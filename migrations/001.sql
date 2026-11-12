-- R2 initial schema. UTC instants are integer milliseconds since the Unix epoch.
-- Booleans are INTEGER 0/1. This is unreleased, synthetic-only: fresh databases get this
-- schema directly, and the application refuses any older incompatible schema.
-- VAPID keys are external configuration; no private key is stored here.

-- Singleton owner settings. The timezone is explicit; it is never inferred.
CREATE TABLE owner_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  timezone TEXT CHECK (timezone IS NULL OR length(timezone) > 0),
  notifications_paused INTEGER NOT NULL DEFAULT 0 CHECK (notifications_paused IN (0, 1))
) STRICT;
INSERT INTO owner_settings (id) VALUES (1);

-- Only a hash of the session token is stored.
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  CHECK (expires_at > created_at)
) STRICT;
CREATE INDEX sessions_expires_at ON sessions (expires_at);

-- Singleton connected browser. Replacing it bumps version and clears ready_at.
CREATE TABLE push_subscription (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  ready_at INTEGER
) STRICT;

-- Unconfirmed interpretations. Confirmation consumes one by linking a reminder.
CREATE TABLE proposals (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL CHECK (length(text) > 0),
  due_at INTEGER NOT NULL,
  timezone TEXT NOT NULL CHECK (length(timezone) > 0),
  local_datetime TEXT NOT NULL CHECK (length(local_datetime) > 0),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  confirmed_reminder_id TEXT REFERENCES reminders (id),
  request_id TEXT UNIQUE,
  CHECK (expires_at > created_at),
  CHECK ((confirmed_reminder_id IS NULL) = (request_id IS NULL))
) STRICT;
CREATE INDEX proposals_expires_at ON proposals (expires_at);

-- Confirmed one-off reminders. due_at, timezone and local_datetime keep the original request.
CREATE TABLE reminders (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL UNIQUE REFERENCES proposals (id),
  request_id TEXT NOT NULL UNIQUE,
  text TEXT NOT NULL CHECK (length(text) > 0),
  due_at INTEGER NOT NULL,
  timezone TEXT NOT NULL CHECK (length(timezone) > 0),
  local_datetime TEXT NOT NULL CHECK (length(local_datetime) > 0),
  state TEXT NOT NULL CHECK (state IN ('scheduled', 'sending', 'retry', 'accepted', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at INTEGER NOT NULL,
  lease_until INTEGER,
  claim_token TEXT,
  created_at INTEGER NOT NULL,
  accepted_at INTEGER,
  error_code TEXT,
  CHECK (state <> 'sending' OR (lease_until IS NOT NULL AND claim_token IS NOT NULL)),
  CHECK (state <> 'accepted' OR accepted_at IS NOT NULL),
  CHECK (state <> 'failed' OR error_code IS NOT NULL)
) STRICT;
CREATE INDEX reminders_state_next_attempt_at ON reminders (state, next_attempt_at);
CREATE INDEX reminders_due_at ON reminders (due_at, created_at);

-- The confirmed request cannot be rewritten; only delivery state may change.
CREATE TRIGGER reminders_request_immutable
BEFORE UPDATE OF id, proposal_id, request_id, text, due_at, timezone, local_datetime, created_at
ON reminders
BEGIN
  SELECT RAISE(ABORT, 'reminder request fields are immutable');
END;

-- One row per push attempt, written before the network call.
CREATE TABLE delivery_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reminder_id TEXT NOT NULL REFERENCES reminders (id),
  attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
  claim_token TEXT NOT NULL,
  subscription_version INTEGER NOT NULL CHECK (subscription_version >= 1),
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  outcome TEXT NOT NULL CHECK (outcome IN ('started', 'accepted', 'failed', 'unknown')),
  error_code TEXT,
  UNIQUE (reminder_id, attempt_number),
  CHECK (outcome = 'started' OR finished_at IS NOT NULL)
) STRICT;

-- Persistent model-usage counters, one row per quota bucket.
CREATE TABLE model_usage (
  bucket TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0)
) STRICT;
