import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, mkdirSync, openSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import {
  isValidTimezone,
  R2Error,
  REMINDER_STATES,
  type Clock,
  type DeliveryAttempt,
  type DeliveryOutcome,
  type FinishedDeliveryOutcome,
  type NewProposal,
  type OwnerSettings,
  type Proposal,
  type PushSubscriptionKeys,
  type Reminder,
  type ReminderState,
  type SessionRecord,
  type Storage,
  type StoredSubscription,
} from './contracts.ts';
import { defaultMigrationsDir } from './paths.ts';

export type Db = Database.Database;

// ------------------------------------------------------------------------------ migrations

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/** Read `NNN.sql` files from `dir`. Versions must run 1, 2, 3... with no gaps. */
export function loadMigrations(dir: string = defaultMigrationsDir()): Migration[] {
  const files = readdirSync(dir)
    .filter((f) => /^\d{3}\.sql$/.test(f))
    .sort();
  if (files.length === 0) throw new Error('No SQL migrations were found in the migrations directory.');
  return files.map((file, index) => {
    const version = Number(file.slice(0, 3));
    if (version !== index + 1) throw new Error('SQL migrations must be numbered 001, 002, ... without gaps.');
    return { version, name: file, sql: readFileSync(join(dir, file), 'utf8') };
  });
}

const MIGRATION_TABLE_COLUMNS = ['version', 'name', 'applied_at'];

function incompatible(reason: string): R2Error {
  return new R2Error(
    'incompatible_schema',
    `${reason} R2 will not modify it. Move the database aside and start again with a fresh data directory.`,
  );
}

function tableNames(db: Db): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as {
      name: string;
    }[]
  ).map((r) => r.name);
}

/** Highest applied version, or 0 for a fresh database. Throws for an incompatible schema. */
function appliedVersion(db: Db, migrations: readonly Migration[]): number {
  const tables = tableNames(db);
  if (tables.length === 0) return 0;
  if (!tables.includes('schema_migrations')) {
    throw incompatible('This database was not created by R2 and has no migration record.');
  }
  const columns = (db.prepare('PRAGMA table_info(schema_migrations)').all() as { name: string }[]).map((c) => c.name);
  if (columns.join(',') !== MIGRATION_TABLE_COLUMNS.join(',')) {
    throw incompatible('This database uses an older, incompatible R2 schema.');
  }
  if (tables.includes('settings') || tables.includes('vapid_keys')) {
    throw incompatible('This database uses an older, incompatible R2 schema.');
  }
  const rows = db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all() as {
    version: number;
    name: string;
  }[];
  rows.forEach((row, index) => {
    const known = migrations[index];
    if (row.version !== index + 1 || known === undefined || known.name !== row.name) {
      throw incompatible('This database records migrations this R2 build does not know.');
    }
  });
  return rows.length;
}

export function schemaVersion(db: Db): number {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
  if (!exists) return 0;
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null };
  return row.v ?? 0;
}

/**
 * Apply pending migrations in one `BEGIN IMMEDIATE` transaction. A failure rolls everything
 * back, including the migration record, so a migration is recorded only if it ran. Repeating
 * it on a current database changes nothing.
 */
export function migrate(db: Db, clock: Clock, migrations: readonly Migration[] = loadMigrations()): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    const current = appliedVersion(db, migrations);
    const pending = migrations.filter((m) => m.version > current);
    for (const m of pending) {
      if (m.version === 1) {
        db.exec(`CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at INTEGER NOT NULL
        ) STRICT`);
      }
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        m.version,
        m.name,
        clock.now(),
      );
    }
    db.exec('COMMIT');
  } catch (error) {
    if (db.inTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

export interface OpenOptions {
  /** Directory of `NNN.sql` files. Defaults to the installation's migrations directory. */
  migrationsDir?: string;
}

/**
 * Open (creating if needed) the R2 database with private file modes, then migrate it.
 * Pass ":memory:" only for throwaway tests.
 */
export function openDatabase(path: string, clock: Clock, options: OpenOptions = {}): Db {
  const migrations = loadMigrations(options.migrationsDir);
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    chmodSync(dirname(path), 0o700);
    // Create the file as 0600 first; SQLite gives WAL/SHM sidecars the same mode.
    closeSync(openSync(path, 'a', 0o600));
    chmodSync(path, 0o600);
  }
  const db = new Database(path);
  try {
    if (path !== ':memory:') db.pragma('journal_mode = WAL');
    // FULL: a reminder the owner was told is saved must survive power loss.
    db.pragma('synchronous = FULL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    migrate(db, clock, migrations);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function openStorage(path: string, clock: Clock, options: OpenOptions = {}): SqliteStorage {
  return new SqliteStorage(openDatabase(path, clock, options), clock);
}

// ---------------------------------------------------------------------------------- rows

interface ProposalRow {
  id: string;
  text: string;
  due_at: number;
  timezone: string;
  local_datetime: string;
  created_at: number;
  expires_at: number;
  confirmed_reminder_id: string | null;
  request_id: string | null;
}

interface ReminderRow {
  id: string;
  proposal_id: string;
  request_id: string;
  text: string;
  due_at: number;
  timezone: string;
  local_datetime: string;
  state: ReminderState;
  attempts: number;
  next_attempt_at: number;
  lease_until: number | null;
  claim_token: string | null;
  created_at: number;
  accepted_at: number | null;
  error_code: string | null;
}

interface AttemptRow {
  id: number;
  reminder_id: string;
  attempt_number: number;
  claim_token: string;
  subscription_version: number;
  started_at: number;
  finished_at: number | null;
  outcome: DeliveryOutcome;
  error_code: string | null;
}

const toProposal = (r: ProposalRow): Proposal => ({
  id: r.id,
  text: r.text,
  dueAt: r.due_at,
  timezone: r.timezone,
  localDateTime: r.local_datetime,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  confirmedReminderId: r.confirmed_reminder_id,
  requestId: r.request_id,
});

const toReminder = (r: ReminderRow): Reminder => ({
  id: r.id,
  proposalId: r.proposal_id,
  requestId: r.request_id,
  text: r.text,
  dueAt: r.due_at,
  timezone: r.timezone,
  localDateTime: r.local_datetime,
  state: r.state,
  attempts: r.attempts,
  nextAttemptAt: r.next_attempt_at,
  leaseUntil: r.lease_until,
  claimToken: r.claim_token,
  createdAt: r.created_at,
  acceptedAt: r.accepted_at,
  errorCode: r.error_code,
});

const toAttempt = (r: AttemptRow): DeliveryAttempt => ({
  id: r.id,
  reminderId: r.reminder_id,
  attemptNumber: r.attempt_number,
  claimToken: r.claim_token,
  subscriptionVersion: r.subscription_version,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  outcome: r.outcome,
  errorCode: r.error_code,
});

/** Opaque identifier: never derived from a path, row number or content. */
const newId = (prefix: string): string => `${prefix}_${randomBytes(16).toString('base64url')}`;
const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

// -------------------------------------------------------------------------------- storage

/** The SQLite implementation of every storage interface. */
export class SqliteStorage implements Storage {
  readonly db: Db;
  readonly #clock: Clock;

  constructor(db: Db, clock: Clock) {
    this.db = db;
    this.#clock = clock;
  }

  ping(): void {
    this.db.prepare('SELECT 1 FROM owner_settings WHERE id = 1').get();
  }

  close(): void {
    if (this.db.open) this.db.close();
  }

  // settings

  getSettings(): OwnerSettings {
    const row = this.db.prepare('SELECT timezone, notifications_paused AS paused FROM owner_settings WHERE id = 1').get() as
      | { timezone: string | null; paused: number }
      | undefined;
    if (row === undefined) throw new Error('owner_settings row is missing');
    return { timezone: row.timezone, notificationsPaused: row.paused === 1 };
  }

  setTimezone(timezone: string): OwnerSettings {
    if (!isValidTimezone(timezone)) throw new R2Error('invalid_timezone', 'Timezone must be a valid IANA name such as America/Toronto.');
    this.db.prepare('UPDATE owner_settings SET timezone = ? WHERE id = 1').run(timezone);
    return this.getSettings();
  }

  setNotificationsPaused(paused: boolean): OwnerSettings {
    this.db.prepare('UPDATE owner_settings SET notifications_paused = ? WHERE id = 1').run(paused ? 1 : 0);
    return this.getSettings();
  }

  // sessions

  createSession(token: string, expiresAt: number): SessionRecord {
    const createdAt = this.#clock.now();
    if (token === '' || !(expiresAt > createdAt)) {
      throw new R2Error('invalid_request', 'A session needs a token and a future expiry.');
    }
    this.db
      .prepare('INSERT INTO sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)')
      .run(hashToken(token), createdAt, expiresAt);
    return { createdAt, expiresAt };
  }

  getSession(token: string): SessionRecord | undefined {
    const row = this.db
      .prepare('SELECT created_at, expires_at FROM sessions WHERE token_hash = ? AND expires_at > ?')
      .get(hashToken(token), this.#clock.now()) as { created_at: number; expires_at: number } | undefined;
    return row === undefined ? undefined : { createdAt: row.created_at, expiresAt: row.expires_at };
  }

  revokeSession(token: string): boolean {
    return this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token)).changes > 0;
  }

  purgeExpiredSessions(): number {
    return this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(this.#clock.now()).changes;
  }

  // push subscription

  replaceSubscription(keys: PushSubscriptionKeys): StoredSubscription {
    if (keys.endpoint === '' || keys.p256dh === '' || keys.auth === '') {
      throw new R2Error('invalid_request', 'A push subscription needs an endpoint and both keys.');
    }
    this.db
      .prepare(
        `INSERT INTO push_subscription (id, endpoint, p256dh, auth, version, ready_at) VALUES (1, @endpoint, @p256dh, @auth, 1, NULL)
         ON CONFLICT (id) DO UPDATE SET endpoint = excluded.endpoint, p256dh = excluded.p256dh, auth = excluded.auth,
           version = push_subscription.version + 1, ready_at = NULL`,
      )
      .run(keys);
    const stored = this.getSubscription();
    if (stored === undefined) throw new Error('push_subscription row is missing');
    return stored;
  }

  getSubscription(): StoredSubscription | undefined {
    const row = this.db.prepare('SELECT endpoint, p256dh, auth, version, ready_at FROM push_subscription WHERE id = 1').get() as
      | { endpoint: string; p256dh: string; auth: string; version: number; ready_at: number | null }
      | undefined;
    return row === undefined
      ? undefined
      : { endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth, version: row.version, readyAt: row.ready_at };
  }

  markSubscriptionReady(version: number): boolean {
    return (
      this.db
        .prepare('UPDATE push_subscription SET ready_at = ? WHERE id = 1 AND version = ?')
        .run(this.#clock.now(), version).changes > 0
    );
  }

  // proposals

  storeProposal(proposal: NewProposal): Proposal {
    const createdAt = this.#clock.now();
    if (!isValidTimezone(proposal.timezone)) throw new R2Error('invalid_timezone', 'Timezone must be a valid IANA name such as America/Toronto.');
    if (proposal.text === '' || proposal.localDateTime === '' || !Number.isSafeInteger(proposal.dueAt) || !(proposal.expiresAt > createdAt)) {
      throw new R2Error('invalid_request', 'A proposal needs text, a local date/time, a due instant and a future expiry.');
    }
    const id = newId('prp');
    this.db
      .prepare(
        `INSERT INTO proposals (id, text, due_at, timezone, local_datetime, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, proposal.text, proposal.dueAt, proposal.timezone, proposal.localDateTime, createdAt, proposal.expiresAt);
    return { ...proposal, id, createdAt, confirmedReminderId: null, requestId: null };
  }

  getProposal(id: string): Proposal | undefined {
    const row = this.db.prepare('SELECT * FROM proposals WHERE id = ?').get(id) as ProposalRow | undefined;
    return row === undefined ? undefined : toProposal(row);
  }

  expireProposals(): number {
    return this.db
      .prepare('DELETE FROM proposals WHERE confirmed_reminder_id IS NULL AND expires_at <= ?')
      .run(this.#clock.now()).changes;
  }

  // reminders

  readonly #confirm = (proposalId: string, requestId: string): Reminder => {
    const now = this.#clock.now();
    const proposal = this.db.prepare('SELECT * FROM proposals WHERE id = ?').get(proposalId) as ProposalRow | undefined;
    if (proposal === undefined) throw new R2Error('proposal_not_found', 'That proposal does not exist or has expired.');

    const byRequest = this.db.prepare('SELECT * FROM reminders WHERE request_id = ?').get(requestId) as ReminderRow | undefined;
    if (byRequest !== undefined) {
      if (byRequest.proposal_id !== proposalId) {
        throw new R2Error('request_id_conflict', 'That request id was already used for a different proposal.');
      }
      return toReminder(byRequest);
    }
    if (proposal.confirmed_reminder_id !== null) {
      const original = this.db.prepare('SELECT * FROM reminders WHERE id = ?').get(proposal.confirmed_reminder_id) as ReminderRow;
      return toReminder(original);
    }
    if (proposal.expires_at <= now) throw new R2Error('proposal_expired', 'That proposal has expired. Ask for the reminder again.');

    const id = newId('rem');
    this.db
      .prepare(
        `INSERT INTO reminders (id, proposal_id, request_id, text, due_at, timezone, local_datetime, state, attempts, next_attempt_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled', 0, ?, ?)`,
      )
      .run(id, proposal.id, requestId, proposal.text, proposal.due_at, proposal.timezone, proposal.local_datetime, proposal.due_at, now);
    this.db.prepare('UPDATE proposals SET confirmed_reminder_id = ?, request_id = ? WHERE id = ?').run(id, requestId, proposal.id);
    return toReminder(this.db.prepare('SELECT * FROM reminders WHERE id = ?').get(id) as ReminderRow);
  };

  confirmProposal(proposalId: string, requestId: string): Reminder {
    if (requestId === '') throw new R2Error('invalid_request', 'A confirmation needs a request id.');
    // IMMEDIATE takes the write lock up front, so two connections serialise. The commit
    // (synchronous=FULL) is durable before this method returns.
    return this.db.transaction(this.#confirm).immediate(proposalId, requestId);
  }

  getReminder(id: string): Reminder | undefined {
    const row = this.db.prepare('SELECT * FROM reminders WHERE id = ?').get(id) as ReminderRow | undefined;
    return row === undefined ? undefined : toReminder(row);
  }

  listReminders(options: { limit?: number } = {}): Reminder[] {
    const limit = options.limit ?? 500;
    if (!Number.isInteger(limit) || limit < 1) throw new R2Error('invalid_request', 'limit must be a positive integer.');
    return (
      this.db.prepare('SELECT * FROM reminders ORDER BY due_at, created_at, id LIMIT ?').all(limit) as ReminderRow[]
    ).map(toReminder);
  }

  // quota

  consumeModelQuota(bucket: string, limit: number): { allowed: boolean; count: number } {
    if (bucket === '' || !Number.isInteger(limit) || limit < 0) {
      throw new R2Error('invalid_request', 'A quota needs a bucket and a non-negative integer limit.');
    }
    return this.db
      .transaction((): { allowed: boolean; count: number } => {
        this.db.prepare('INSERT INTO model_usage (bucket, count) VALUES (?, 0) ON CONFLICT (bucket) DO NOTHING').run(bucket);
        const { count } = this.db.prepare('SELECT count FROM model_usage WHERE bucket = ?').get(bucket) as { count: number };
        if (count >= limit) return { allowed: false, count };
        this.db.prepare('UPDATE model_usage SET count = count + 1 WHERE bucket = ?').run(bucket);
        return { allowed: true, count: count + 1 };
      })
      .immediate();
  }

  getModelUsage(bucket: string): number {
    const row = this.db.prepare('SELECT count FROM model_usage WHERE bucket = ?').get(bucket) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  // delivery records

  startDeliveryAttempt(input: { reminderId: string; claimToken: string; subscriptionVersion: number }): DeliveryAttempt {
    return this.db
      .transaction((): DeliveryAttempt => {
        if (this.db.prepare('SELECT 1 FROM reminders WHERE id = ?').get(input.reminderId) === undefined) {
          throw new R2Error('not_found', 'That reminder does not exist.');
        }
        const { n } = this.db
          .prepare('SELECT COALESCE(MAX(attempt_number), 0) AS n FROM delivery_attempts WHERE reminder_id = ?')
          .get(input.reminderId) as { n: number };
        const info = this.db
          .prepare(
            `INSERT INTO delivery_attempts (reminder_id, attempt_number, claim_token, subscription_version, started_at, outcome)
             VALUES (?, ?, ?, ?, ?, 'started')`,
          )
          .run(input.reminderId, n + 1, input.claimToken, input.subscriptionVersion, this.#clock.now());
        return toAttempt(this.db.prepare('SELECT * FROM delivery_attempts WHERE id = ?').get(info.lastInsertRowid) as AttemptRow);
      })
      .immediate();
  }

  finishDeliveryAttempt(attemptId: number, outcome: FinishedDeliveryOutcome, errorCode: string | null = null): DeliveryAttempt {
    const changes = this.db
      .prepare("UPDATE delivery_attempts SET outcome = ?, error_code = ?, finished_at = ? WHERE id = ? AND outcome = 'started'")
      .run(outcome, errorCode, this.#clock.now(), attemptId).changes;
    if (changes === 0) throw new R2Error('conflict', 'That delivery attempt does not exist or is already finished.');
    return toAttempt(this.db.prepare('SELECT * FROM delivery_attempts WHERE id = ?').get(attemptId) as AttemptRow);
  }

  listDeliveryAttempts(reminderId: string): DeliveryAttempt[] {
    return (
      this.db.prepare('SELECT * FROM delivery_attempts WHERE reminder_id = ? ORDER BY attempt_number').all(reminderId) as AttemptRow[]
    ).map(toAttempt);
  }

  // delivery leases

  claimDueReminders(options: { limit: number; leaseMs: number }): Reminder[] {
    if (!Number.isInteger(options.limit) || options.limit < 1 || !(options.leaseMs > 0)) {
      throw new R2Error('invalid_request', 'A claim needs a positive limit and lease.');
    }
    return this.db
      .transaction((): Reminder[] => {
        const now = this.#clock.now();
        const rows = this.db
          .prepare(
            `SELECT id FROM reminders WHERE state IN ('scheduled', 'retry') AND next_attempt_at <= ?
             ORDER BY due_at, created_at, id LIMIT ?`,
          )
          .all(now, options.limit) as { id: string }[];
        return rows.map(({ id }) => {
          this.db
            .prepare(
              `UPDATE reminders SET state = 'sending', attempts = attempts + 1, lease_until = ?, claim_token = ? WHERE id = ?`,
            )
            .run(now + options.leaseMs, randomBytes(16).toString('base64url'), id);
          return toReminder(this.db.prepare('SELECT * FROM reminders WHERE id = ?').get(id) as ReminderRow);
        });
      })
      .immediate();
  }

  #settle(reminderId: string, claimToken: string, set: string, ...values: (string | number | null)[]): boolean {
    return (
      this.db
        .prepare(
          `UPDATE reminders SET ${set}, lease_until = NULL, claim_token = NULL
           WHERE id = ? AND state = 'sending' AND claim_token = ?`,
        )
        .run(...values, reminderId, claimToken).changes > 0
    );
  }

  markAccepted(reminderId: string, claimToken: string): boolean {
    return this.#settle(reminderId, claimToken, "state = 'accepted', accepted_at = ?, error_code = NULL", this.#clock.now());
  }

  scheduleRetry(reminderId: string, claimToken: string, nextAttemptAt: number, errorCode: string): boolean {
    return this.#settle(reminderId, claimToken, "state = 'retry', next_attempt_at = ?, error_code = ?", nextAttemptAt, errorCode);
  }

  markFailed(reminderId: string, claimToken: string, errorCode: string): boolean {
    return this.#settle(reminderId, claimToken, "state = 'failed', error_code = ?", errorCode);
  }

  recoverExpiredLeases(options: { maxAttempts: number; all?: boolean }): number {
    return this.db
      .transaction((): number => {
        const now = this.#clock.now();
        const rows = this.db
          .prepare("SELECT id, attempts, claim_token FROM reminders WHERE state = 'sending' AND (? OR lease_until <= ?)")
          .all(options.all === true ? 1 : 0, now) as { id: string; attempts: number; claim_token: string }[];
        for (const row of rows) {
          this.db
            .prepare(
              `UPDATE delivery_attempts SET outcome = 'unknown', error_code = 'interrupted', finished_at = ?
               WHERE reminder_id = ? AND claim_token = ? AND outcome = 'started'`,
            )
            .run(now, row.id, row.claim_token);
          if (row.attempts >= options.maxAttempts) {
            this.db
              .prepare("UPDATE reminders SET state = 'failed', error_code = 'interrupted', lease_until = NULL, claim_token = NULL WHERE id = ?")
              .run(row.id);
          } else {
            this.db
              .prepare(
                "UPDATE reminders SET state = 'retry', next_attempt_at = ?, error_code = 'interrupted', lease_until = NULL, claim_token = NULL WHERE id = ?",
              )
              .run(now, row.id);
          }
        }
        return rows.length;
      })
      .immediate();
  }

  countReminders(): { byState: Record<ReminderState, number>; due: number } {
    const byState = Object.fromEntries(REMINDER_STATES.map((s) => [s, 0])) as Record<ReminderState, number>;
    for (const row of this.db.prepare('SELECT state, COUNT(*) AS n FROM reminders GROUP BY state').all() as {
      state: ReminderState;
      n: number;
    }[]) {
      byState[row.state] = row.n;
    }
    const { due } = this.db
      .prepare("SELECT COUNT(*) AS due FROM reminders WHERE state IN ('scheduled', 'retry') AND next_attempt_at <= ?")
      .get(this.#clock.now()) as { due: number };
    return { byState, due };
  }
}
