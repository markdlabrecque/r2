/**
 * Append-only list of schema migrations. Never edit an applied migration; add a new one.
 * All timestamps are integer milliseconds since the Unix epoch (UTC).
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/** Total push attempts per reminder: the first try plus retries after 30s, 2min and 10min. */
export const MAX_DELIVERY_ATTEMPTS = 4;

export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: 'initial-contracts',
    sql: `
      -- Single-row owner settings. The timezone is explicit; it is never inferred.
      CREATE TABLE settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        timezone TEXT,
        notifications_paused INTEGER NOT NULL DEFAULT 0 CHECK (notifications_paused IN (0, 1)),
        updated_at_ms INTEGER NOT NULL
      ) STRICT;
      INSERT INTO settings (id, timezone, notifications_paused, updated_at_ms) VALUES (1, NULL, 0, 0);

      -- Revocable owner sessions. Only a hash of the session token is stored.
      CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY,
        created_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        revoked_at_ms INTEGER,
        CHECK (expires_at_ms > created_at_ms)
      ) STRICT;
      CREATE INDEX sessions_expiry ON sessions (expires_at_ms);

      -- One VAPID key pair, kept across restarts so the browser subscription stays valid.
      CREATE TABLE vapid_keys (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        public_key TEXT NOT NULL,
        private_key TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL
      ) STRICT;

      -- One connected browser. A new subscription replaces the previous row.
      CREATE TABLE push_subscription (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        endpoint TEXT NOT NULL,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        tested_at_ms INTEGER,
        invalidated_at_ms INTEGER
      ) STRICT;

      -- Confirmed one-off reminders. request_id makes a confirmation idempotent.
      -- due_at_ms is the original due time; next_attempt_at_ms is the worker's schedule.
      CREATE TABLE reminders (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE,
        text TEXT NOT NULL CHECK (length(text) > 0),
        due_at_ms INTEGER NOT NULL,
        timezone TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('scheduled', 'sending', 'retry_wait', 'accepted', 'failed')),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND ${MAX_DELIVERY_ATTEMPTS}),
        next_attempt_at_ms INTEGER,
        lease_expires_at_ms INTEGER,
        outcome TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        completed_at_ms INTEGER,
        CHECK (status NOT IN ('scheduled', 'retry_wait') OR next_attempt_at_ms IS NOT NULL),
        CHECK (status <> 'sending' OR lease_expires_at_ms IS NOT NULL),
        CHECK (status NOT IN ('accepted', 'failed') OR completed_at_ms IS NOT NULL)
      ) STRICT;
      CREATE INDEX reminders_due ON reminders (status, next_attempt_at_ms);

      -- The original request cannot be rewritten after confirmation.
      CREATE TRIGGER reminders_immutable_request
      BEFORE UPDATE OF id, request_id, text, due_at_ms, timezone, created_at_ms ON reminders
      BEGIN
        SELECT RAISE(ABORT, 'reminder request fields are immutable');
      END;

      -- One row per push attempt, recorded before the network call.
      CREATE TABLE delivery_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        reminder_id TEXT NOT NULL REFERENCES reminders (id) ON DELETE RESTRICT,
        attempt_number INTEGER NOT NULL CHECK (attempt_number BETWEEN 1 AND ${MAX_DELIVERY_ATTEMPTS}),
        started_at_ms INTEGER NOT NULL,
        finished_at_ms INTEGER,
        outcome TEXT NOT NULL CHECK (outcome IN
          ('in_progress', 'accepted', 'temporary_failure', 'permanent_failure', 'interrupted')),
        http_status INTEGER,
        error_code TEXT,
        UNIQUE (reminder_id, attempt_number),
        CHECK (outcome = 'in_progress' OR finished_at_ms IS NOT NULL)
      ) STRICT;
    `,
  },
];
