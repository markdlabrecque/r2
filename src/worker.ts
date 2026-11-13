import {
  DELIVERY_RETRY_DELAYS_MS,
  MAX_DELIVERY_ATTEMPTS,
  type Clock,
  type ErrorCode,
  type PushTransport,
  type Reminder,
  type Storage,
  type Worker,
  type WorkerHealth,
} from './contracts.ts';
import { PUSH_DEADLINE_MS } from './push.ts';

export const POLL_INTERVAL_MS = 5_000;
/** A lease must outlast the hard push deadline, or a slow send could be claimed twice. */
export const LEASE_MS = PUSH_DEADLINE_MS + 15_000;
/** Bounds one pass so a large backlog cannot starve shutdown. */
const MAX_PER_PASS = 50;

/** The subset of a pino logger the worker uses. Only opaque ids and codes are ever logged. */
export interface WorkerLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

const quiet: WorkerLogger = { info() {}, warn() {}, error() {} };

export interface DeliveryWorkerOptions {
  storage: Storage;
  clock: Clock;
  /** Absent when Web Push is not configured: due reminders then wait, they are not failed. */
  pushTransport?: PushTransport | undefined;
  /** `R2_PAUSE_NOTIFICATIONS`; the owner's stored pause setting also applies. */
  forcePaused?: boolean;
  pollMs?: number;
  leaseMs?: number;
  logger?: WorkerLogger;
}

export interface DeliveryStatus extends WorkerHealth {
  paused: boolean;
  pushConfigured: boolean;
  subscriptionConnected: boolean;
}

/**
 * The deterministic scheduler and delivery worker. It never calls the model. Every
 * attempt is claimed in a SQLite transaction, recorded before the network call, and settled
 * in its own transaction, so a crash leaves a visible, recoverable state.
 */
export class DeliveryWorker implements Worker {
  readonly #storage: Storage;
  readonly #clock: Clock;
  readonly #transport: PushTransport | undefined;
  readonly #forcePaused: boolean;
  readonly #pollMs: number;
  readonly #leaseMs: number;
  #log: WorkerLogger;
  #timer: NodeJS.Timeout | undefined;
  #running: Promise<void> | undefined;
  #stopped = true;
  /** Set by stop() so a pass in progress ends; unaffected by whether start() ever ran. */
  #stopRequested = false;
  #state: WorkerHealth['state'] = 'stopped';
  #lastRunAt: number | null = null;
  #lastErrorCode: ErrorCode | null = null;

  constructor(options: DeliveryWorkerOptions) {
    this.#storage = options.storage;
    this.#clock = options.clock;
    this.#transport = options.pushTransport;
    this.#forcePaused = options.forcePaused ?? false;
    this.#pollMs = options.pollMs ?? POLL_INTERVAL_MS;
    this.#leaseMs = options.leaseMs ?? LEASE_MS;
    this.#log = options.logger ?? quiet;
  }

  setLogger(logger: WorkerLogger): void {
    this.#log = logger;
  }

  /** Recover work a previous process left half-done, deliver what is due, then keep polling. */
  async start(): Promise<void> {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#stopRequested = false;
    this.#state = 'running';
    try {
      // After a restart no other process holds a lease: every `sending` row is orphaned.
      const recovered = this.#storage.recoverExpiredLeases({ maxAttempts: MAX_DELIVERY_ATTEMPTS, all: true });
      if (recovered > 0) this.#log.warn({ recovered }, 'recovered interrupted deliveries');
    } catch (error) {
      this.#fail(error);
    }
    if (this.#transport === undefined) this.#log.warn({}, 'Web Push is not configured; due reminders wait');
    this.#schedule(0);
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#stopRequested = true;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    await this.#running?.catch(() => undefined);
    this.#state = 'stopped';
  }

  getStatus(): WorkerHealth {
    return { state: this.#state, lastRunAt: this.#lastRunAt, lastErrorCode: this.#lastErrorCode };
  }

  getDeliveryStatus(): DeliveryStatus {
    return {
      ...this.getStatus(),
      paused: this.isPaused(),
      pushConfigured: this.#transport !== undefined,
      subscriptionConnected: this.#storage.getSubscription() !== undefined,
    };
  }

  isPaused(): boolean {
    return this.#forcePaused || this.#storage.getSettings().notificationsPaused;
  }

  #schedule(delay: number): void {
    if (this.#stopped) return;
    this.#timer = setTimeout(() => {
      this.#running = this.runOnce().finally(() => {
        this.#running = undefined;
        this.#schedule(this.#pollMs);
      });
    }, delay);
  }

  #fail(error: unknown): void {
    this.#state = 'failed';
    this.#lastErrorCode = 'internal_error';
    this.#log.error({ errorName: error instanceof Error ? error.name : 'unknown' }, 'delivery pass failed');
  }

  /** One pass. Exposed so tests drive the worker with an injected clock. Never throws. */
  async runOnce(): Promise<void> {
    try {
      this.#storage.recoverExpiredLeases({ maxAttempts: MAX_DELIVERY_ATTEMPTS });
      const transport = this.#transport;
      // Paused or unconfigured: leave reminders scheduled. They send, still overdue, once resumed.
      if (transport !== undefined && !this.isPaused() && this.#storage.getSubscription() !== undefined) {
        for (let i = 0; i < MAX_PER_PASS && !this.#stopRequested; i++) {
          const [reminder] = this.#storage.claimDueReminders({ limit: 1, leaseMs: this.#leaseMs });
          if (reminder === undefined) break;
          await this.#deliver(reminder, transport);
        }
      }
      this.#state = this.#stopRequested ? this.#state : 'running';
      this.#lastErrorCode = null;
      this.#lastRunAt = this.#clock.now();
    } catch (error) {
      this.#fail(error);
    }
  }

  async #deliver(reminder: Reminder, transport: PushTransport): Promise<void> {
    const claimToken = reminder.claimToken;
    const subscription = this.#storage.getSubscription();
    if (claimToken === null) return;
    if (subscription === undefined) {
      this.#storage.markFailed(reminder.id, claimToken, 'no_subscription');
      return;
    }
    const attempt = this.#storage.startDeliveryAttempt({
      reminderId: reminder.id,
      claimToken,
      subscriptionVersion: subscription.version,
    });
    let result;
    try {
      result = await transport.send(subscription, reminder.id);
    } catch {
      // The transport promises not to throw; if it does, acceptance is unknown.
      result = undefined;
    }
    const attemptNumber = reminder.attempts;
    if (result?.outcome === 'accepted') {
      this.#storage.finishDeliveryAttempt(attempt.id, 'accepted');
      const settled = this.#storage.markAccepted(reminder.id, claimToken);
      this.#log.info({ reminderId: reminder.id, attempt: attemptNumber, settled }, 'push accepted');
      return;
    }
    const code = result?.outcome === 'failed' ? result.code : 'network';
    const retryable = result === undefined ? true : result.outcome === 'failed' && result.retryable;
    this.#storage.finishDeliveryAttempt(attempt.id, result === undefined ? 'unknown' : 'failed', code);
    const delay = DELIVERY_RETRY_DELAYS_MS[attemptNumber - 1];
    if (retryable && attemptNumber < MAX_DELIVERY_ATTEMPTS && delay !== undefined) {
      this.#storage.scheduleRetry(reminder.id, claimToken, this.#clock.now() + delay, code);
      this.#log.warn({ reminderId: reminder.id, attempt: attemptNumber, code, retryInMs: delay }, 'push failed; retry scheduled');
    } else {
      this.#storage.markFailed(reminder.id, claimToken, code);
      this.#log.warn({ reminderId: reminder.id, attempt: attemptNumber, code }, 'push failed permanently');
    }
  }
}
