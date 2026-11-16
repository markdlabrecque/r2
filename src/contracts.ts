/**
 * Shared contracts: the single source of truth for time, model outcomes, DTOs, push delivery,
 * worker lifecycle, typed errors and storage interfaces. Later features import from here
 * rather than redefining these shapes.
 *
 * UTC instants are integer milliseconds since the Unix epoch internally. JSON DTOs carry
 * ISO-8601 UTC strings, plus the IANA timezone and the original local date/time.
 *
 * Keep this file free of parameter properties and enums so Node's type stripping can load it.
 */

// ---------------------------------------------------------------------------------- time

/** Injected time source. Application code never calls Date.now() directly. */
export interface Clock {
  /** Epoch milliseconds. */
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/**
 * True for a named IANA zone the runtime knows (`America/Toronto`, `UTC`). Numeric offsets
 * such as `+05:00` are rejected: the owner's timezone is explicit and named.
 */
export function isValidTimezone(timezone: unknown): timezone is string {
  if (typeof timezone !== 'string' || !/^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/.test(timezone)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

// -------------------------------------------------------------------------------- errors

export const ERROR_CODES = [
  'invalid_request',
  'unsupported_media_type',
  'payload_too_large',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'proposal_not_found',
  'proposal_expired',
  'request_id_conflict',
  'invalid_timezone',
  'quota_exceeded',
  'unavailable',
  'incompatible_schema',
  'internal_error',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const ERROR_STATUS: Readonly<Record<ErrorCode, number>> = {
  invalid_request: 400,
  unsupported_media_type: 415,
  payload_too_large: 413,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  proposal_not_found: 404,
  proposal_expired: 410,
  request_id_conflict: 409,
  invalid_timezone: 400,
  quota_exceeded: 429,
  unavailable: 503,
  incompatible_schema: 500,
  internal_error: 500,
};

/** A typed error whose message is written by us and safe to show to the owner. */
export class R2Error extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  constructor(code: ErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'R2Error';
    this.code = code;
    this.status = ERROR_STATUS[code];
  }
}

/** Body of every JSON error response. */
export interface ErrorBody {
  error: { code: ErrorCode; message: string };
}

// ------------------------------------------------------------------------ model outcomes

/** What the model may return. Application code, not the model, validates and commits. */
export type ModelOutcome =
  | { type: 'clarify'; question: string }
  | { type: 'one_off'; text: string; localDateTime: string }
  | { type: 'unsupported'; reason: string };

export interface ModelInterpreter {
  /** `now` is epoch milliseconds; `timezone` is the owner's explicit IANA zone. */
  interpret(text: string, now: number, timezone: string): Promise<ModelOutcome>;
}

// ------------------------------------------------------------------------------- records

export interface OwnerSettings {
  /** Explicit IANA timezone, or null until the owner sets one. */
  timezone: string | null;
  notificationsPaused: boolean;
}

export interface SessionRecord {
  createdAt: number;
  expiresAt: number;
}

export interface PushSubscriptionKeys {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface StoredSubscription extends PushSubscriptionKeys {
  /** Increases on every replacement so stale delivery attempts can be recognised. */
  version: number;
  /** Set once a test push to this version succeeded; null means not ready. */
  readyAt: number | null;
}

export interface NewProposal {
  text: string;
  dueAt: number;
  timezone: string;
  /** Original local date/time, `YYYY-MM-DDTHH:mm[:ss]`, in `timezone`. */
  localDateTime: string;
  expiresAt: number;
}

export interface Proposal extends NewProposal {
  id: string;
  createdAt: number;
  confirmedReminderId: string | null;
  requestId: string | null;
}

export const REMINDER_STATES = ['scheduled', 'sending', 'retry', 'accepted', 'failed'] as const;
export type ReminderState = (typeof REMINDER_STATES)[number];

export interface Reminder {
  id: string;
  proposalId: string;
  requestId: string;
  text: string;
  dueAt: number;
  timezone: string;
  localDateTime: string;
  state: ReminderState;
  attempts: number;
  nextAttemptAt: number;
  leaseUntil: number | null;
  /** Private to the delivery worker; never part of a DTO. */
  claimToken: string | null;
  createdAt: number;
  acceptedAt: number | null;
  errorCode: string | null;
}

export const DELIVERY_OUTCOMES = ['started', 'accepted', 'failed', 'unknown'] as const;
export type DeliveryOutcome = (typeof DELIVERY_OUTCOMES)[number];
export type FinishedDeliveryOutcome = Exclude<DeliveryOutcome, 'started'>;

export interface DeliveryAttempt {
  id: number;
  reminderId: string;
  attemptNumber: number;
  claimToken: string;
  subscriptionVersion: number;
  startedAt: number;
  finishedAt: number | null;
  outcome: DeliveryOutcome;
  errorCode: string | null;
}

// ----------------------------------------------------------------------------------- DTOs

export interface ProposalDto {
  id: string;
  text: string;
  dueAt: string;
  timezone: string;
  localDateTime: string;
  createdAt: string;
  expiresAt: string;
  confirmedReminderId: string | null;
}

export interface ReminderDto {
  id: string;
  proposalId: string;
  text: string;
  dueAt: string;
  timezone: string;
  localDateTime: string;
  state: ReminderState;
  attempts: number;
  nextAttemptAt: string;
  createdAt: string;
  acceptedAt: string | null;
  errorCode: string | null;
}

export interface DeliveryAttemptDto {
  attemptNumber: number;
  subscriptionVersion: number;
  startedAt: string;
  finishedAt: string | null;
  outcome: DeliveryOutcome;
  errorCode: string | null;
}

const iso = (ms: number): string => new Date(ms).toISOString();

export function toProposalDto(p: Proposal): ProposalDto {
  return {
    id: p.id,
    text: p.text,
    dueAt: iso(p.dueAt),
    timezone: p.timezone,
    localDateTime: p.localDateTime,
    createdAt: iso(p.createdAt),
    expiresAt: iso(p.expiresAt),
    confirmedReminderId: p.confirmedReminderId,
  };
}

/** Drops lease and claim fields and the request id: they are internal. */
export function toReminderDto(r: Reminder): ReminderDto {
  return {
    id: r.id,
    proposalId: r.proposalId,
    text: r.text,
    dueAt: iso(r.dueAt),
    timezone: r.timezone,
    localDateTime: r.localDateTime,
    state: r.state,
    attempts: r.attempts,
    nextAttemptAt: iso(r.nextAttemptAt),
    createdAt: iso(r.createdAt),
    acceptedAt: r.acceptedAt === null ? null : iso(r.acceptedAt),
    errorCode: r.errorCode,
  };
}

export function toDeliveryAttemptDto(a: DeliveryAttempt): DeliveryAttemptDto {
  return {
    attemptNumber: a.attemptNumber,
    subscriptionVersion: a.subscriptionVersion,
    startedAt: iso(a.startedAt),
    finishedAt: a.finishedAt === null ? null : iso(a.finishedAt),
    outcome: a.outcome,
    errorCode: a.errorCode,
  };
}

// ------------------------------------------------------------------------------- push

export type PushFailureCode = 'subscription_gone' | 'rejected' | 'temporary' | 'network';

export type PushResult =
  | { outcome: 'accepted'; httpStatus?: number }
  | { outcome: 'failed'; retryable: boolean; code: PushFailureCode; httpStatus?: number };

export interface PushTransport {
  /**
   * Send one generic notification. The payload may carry only the opaque `reminderId`:
   * never reminder text or its due time.
   */
  send(subscription: PushSubscriptionKeys, reminderId: string): Promise<PushResult>;
}

// ----------------------------------------------------------------------------- worker

export const WORKER_STATES = ['stopped', 'running', 'failed'] as const;
export type WorkerState = (typeof WORKER_STATES)[number];

export interface WorkerHealth {
  state: WorkerState;
  /** Epoch ms of the last completed pass, or null. */
  lastRunAt: number | null;
  lastErrorCode: ErrorCode | null;
}

export interface Worker {
  /** Begin background work. Called once the app is ready. */
  start(): void | Promise<void>;
  /** Stop and release every timer. Must be safe to call more than once. */
  stop(): Promise<void>;
  getStatus(): WorkerHealth;
}

// ------------------------------------------------------------------------------ storage

export interface SettingsStore {
  getSettings(): OwnerSettings;
  /** Rejects with `invalid_timezone` unless `timezone` is a valid IANA zone name. */
  setTimezone(timezone: string): OwnerSettings;
  setNotificationsPaused(paused: boolean): OwnerSettings;
}

export interface SessionStore {
  /** Stores only a SHA-256 hash of `token`. */
  createSession(token: string, expiresAt: number): SessionRecord;
  /** Undefined when unknown or expired. */
  getSession(token: string): SessionRecord | undefined;
  /** Returns whether a session was removed. */
  revokeSession(token: string): boolean;
  /** Returns the number of expired sessions removed. */
  purgeExpiredSessions(): number;
}

export interface SubscriptionStore {
  /** Replaces the singleton subscription, bumps its version and clears readiness. */
  replaceSubscription(keys: PushSubscriptionKeys): StoredSubscription;
  getSubscription(): StoredSubscription | undefined;
  /** Marks `version` ready. False when that version is no longer current. */
  markSubscriptionReady(version: number): boolean;
}

export interface ProposalStore {
  storeProposal(proposal: NewProposal): Proposal;
  getProposal(id: string): Proposal | undefined;
  /** Removes unconfirmed proposals past their expiry. Returns how many. */
  expireProposals(): number;
}

export interface ReminderStore {
  /**
   * Atomically insert one reminder and consume `proposalId`. Repeating a confirmed proposal
   * returns the original reminder whatever the request id. Reusing a request id for a
   * different proposal throws `request_id_conflict`. Success means the data is durable.
   */
  confirmProposal(proposalId: string, requestId: string): Reminder;
  getReminder(id: string): Reminder | undefined;
  /** Ordered by due time, then creation time. */
  listReminders(options?: { limit?: number }): Reminder[];
}

export interface QuotaStore {
  /** Atomically count one use of `bucket` unless it already reached `limit`. */
  consumeModelQuota(bucket: string, limit: number): { allowed: boolean; count: number };
  getModelUsage(bucket: string): number;
}

export interface DeliveryRecordStore {
  /** Records attempt N+1 for the reminder before the network call. */
  startDeliveryAttempt(input: {
    reminderId: string;
    claimToken: string;
    subscriptionVersion: number;
  }): DeliveryAttempt;
  finishDeliveryAttempt(
    attemptId: number,
    outcome: FinishedDeliveryOutcome,
    errorCode?: string | null,
  ): DeliveryAttempt;
  listDeliveryAttempts(reminderId: string): DeliveryAttempt[];
  /** Record the provider outcome and settle the claimed reminder in one transaction. */
  settleDelivery(input: {
    attemptId: number;
    reminderId: string;
    claimToken: string;
    outcome: FinishedDeliveryOutcome;
    errorCode?: string | null;
    settlement: { state: 'accepted' } | { state: 'failed'; code: string } | { state: 'retry'; code: string; nextAttemptAt: number };
  }): boolean;
}

/** Four total attempts per reminder, with these waits after attempts 1, 2 and 3. */
export const MAX_DELIVERY_ATTEMPTS = 4;
export const DELIVERY_RETRY_DELAYS_MS: readonly number[] = [30_000, 120_000, 600_000];

/** Transactional delivery claims. One claim covers exactly one attempt. */
export interface DeliveryLeaseStore {
  /** Moves due `scheduled`/`retry` reminders to `sending` with a lease and claim token. Counts the attempt. */
  claimDueReminders(options: { limit: number; leaseMs: number }): Reminder[];
  markAccepted(reminderId: string, claimToken: string): boolean;
  scheduleRetry(reminderId: string, claimToken: string, nextAttemptAt: number, errorCode: string): boolean;
  markFailed(reminderId: string, claimToken: string, errorCode: string): boolean;
  /**
   * Returns `sending` reminders whose lease expired (all of them with `all`, for the first
   * pass after a restart) to `retry`, or `failed` once `maxAttempts` is used. Their open
   * attempts become `unknown`: the push may or may not have been accepted.
   */
  recoverExpiredLeases(options: { maxAttempts: number; all?: boolean }): number;
  /** Reminder counts by state, plus how many are deliverable now. */
  countReminders(): { byState: Record<ReminderState, number>; due: number };
}

export interface Storage
  extends SettingsStore,
    SessionStore,
    SubscriptionStore,
    ProposalStore,
    ReminderStore,
    QuotaStore,
    DeliveryRecordStore,
    DeliveryLeaseStore {
  /** Throws if the database is unusable. */
  ping(): void;
  close(): void;
}
