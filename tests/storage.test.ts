import { copyFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DELIVERY_OUTCOMES,
  R2Error,
  REMINDER_STATES,
  toDeliveryAttemptDto,
  toProposalDto,
  toReminderDto,
} from '../src/contracts.ts';
import { loadMigrations, migrate, openDatabase, openStorage, schemaVersion, type SqliteStorage } from '../src/db.ts';
import { defaultMigrationsDir } from '../src/paths.ts';
import { FakeClock, tempDir } from './helpers.ts';

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));
const tmp = (): string => {
  const t = tempDir();
  cleanups.push(t.cleanup);
  return t.dir;
};
const mem = (clock = new FakeClock()): SqliteStorage => {
  const s = openStorage(':memory:', clock);
  cleanups.push(() => s.close());
  return s;
};
const file = (path: string, clock = new FakeClock()): SqliteStorage => {
  const s = openStorage(path, clock);
  cleanups.push(() => s.close());
  return s;
};

const NOON = Date.UTC(2026, 9, 14, 12, 0, 0);
const proposalInput = (over: Partial<Parameters<SqliteStorage['storeProposal']>[0]> = {}) => ({
  text: 'Take the bins out',
  dueAt: NOON + 3_600_000,
  timezone: 'America/Toronto',
  localDateTime: '2026-10-14T09:00',
  expiresAt: NOON + 900_000,
  ...over,
});
const catchError = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
};

describe('migration', () => {
  it('creates exactly the contracted tables, columns and no VAPID key table', () => {
    const { db } = mem();
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
    expect(tables).toEqual(['delivery_attempts', 'model_usage', 'owner_settings', 'proposals', 'push_subscription', 'reminders', 'schema_migrations', 'sessions']);
    const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    expect(cols('owner_settings')).toEqual(['id', 'timezone', 'notifications_paused']);
    expect(cols('sessions')).toEqual(['token_hash', 'created_at', 'expires_at']);
    expect(cols('push_subscription')).toEqual(['id', 'endpoint', 'p256dh', 'auth', 'version', 'ready_at']);
    expect(cols('proposals')).toEqual(['id', 'text', 'due_at', 'timezone', 'local_datetime', 'created_at', 'expires_at', 'confirmed_reminder_id', 'request_id']);
    expect(cols('reminders')).toEqual(['id', 'proposal_id', 'request_id', 'text', 'due_at', 'timezone', 'local_datetime', 'state', 'attempts', 'next_attempt_at', 'lease_until', 'claim_token', 'created_at', 'accepted_at', 'error_code']);
    expect(cols('delivery_attempts')).toEqual(['id', 'reminder_id', 'attempt_number', 'claim_token', 'subscription_version', 'started_at', 'finished_at', 'outcome', 'error_code']);
    expect(cols('model_usage')).toEqual(['bucket', 'count']);
    const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[]).map((i) => i.name);
    expect(indexes).toEqual(expect.arrayContaining(['reminders_state_next_attempt_at', 'reminders_due_at', 'proposals_expires_at', 'sessions_expires_at']));
    expect(REMINDER_STATES).toEqual(['scheduled', 'sending', 'retry', 'accepted', 'failed']);
    expect(DELIVERY_OUTCOMES).toEqual(['started', 'accepted', 'failed', 'unknown']);
  });

  it('loads the SQL from disk and records each version once across repeated startups', () => {
    const path = join(tmp(), 'data', 'r2.sqlite');
    const clock = new FakeClock();
    expect(loadMigrations(defaultMigrationsDir()).map((m) => m.name)).toEqual(['001.sql']);
    openDatabase(path, clock).close();
    clock.advance(1000);
    const db = openDatabase(path, clock);
    cleanups.push(() => db.close());
    expect(schemaVersion(db)).toBe(1);
    expect(db.prepare('SELECT version, applied_at FROM schema_migrations').all()).toEqual([{ version: 1, applied_at: NOON }]);
  });

  it('uses private modes, WAL, synchronous=FULL, foreign keys and a 5s busy timeout', () => {
    const path = join(tmp(), 'data', 'r2.sqlite');
    const { db } = file(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(path, '..')).mode & 0o777).toBe(0o700);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('synchronous', { simple: true })).toBe(2);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
  });

  it('rolls back a failed migration completely and does not record it', () => {
    const dir = tmp();
    const good = join(dir, 'good');
    const bad = join(dir, 'bad');
    mkdirSync(good);
    mkdirSync(bad);
    copyFileSync(join(defaultMigrationsDir(), '001.sql'), join(good, '001.sql'));
    copyFileSync(join(defaultMigrationsDir(), '001.sql'), join(bad, '001.sql'));
    writeFileSync(join(bad, '002.sql'), 'CREATE TABLE half_done (x INTEGER); INSERT INTO nonexistent VALUES (1);');

    const path = join(dir, 'r2.sqlite');
    openDatabase(path, new FakeClock(), { migrationsDir: good }).close();
    expect(() => openDatabase(path, new FakeClock(), { migrationsDir: bad })).toThrow();
    const raw = new Database(path);
    cleanups.push(() => raw.close());
    expect(schemaVersion(raw)).toBe(1);
    expect(raw.prepare("SELECT 1 FROM sqlite_master WHERE name = 'half_done'").get()).toBeUndefined();

    // A fresh database with a failing migration is left with no tables and no record.
    const fresh = new Database(join(dir, 'fresh.sqlite'));
    cleanups.push(() => fresh.close());
    expect(() => migrate(fresh, new FakeClock(), loadMigrations(bad))).toThrow();
    expect(fresh.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table'").get()).toEqual({ n: 0 });
  });

  it('rejects an incompatible pre-repair schema without modifying it', () => {
    const path = join(tmp(), 'old.sqlite');
    const old = new Database(path);
    old.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at_ms INTEGER NOT NULL) STRICT;
      INSERT INTO schema_migrations VALUES (1, 'initial-contracts', 0);
      CREATE TABLE settings (id INTEGER PRIMARY KEY, timezone TEXT);
      CREATE TABLE vapid_keys (id INTEGER PRIMARY KEY, private_key TEXT);`);
    old.close();
    const error = catchError(() => openDatabase(path, new FakeClock()));
    expect(error).toBeInstanceOf(R2Error);
    expect((error as R2Error).code).toBe('incompatible_schema');
    const after = new Database(path);
    cleanups.push(() => after.close());
    const names = (after.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
    expect(names).toEqual(['schema_migrations', 'settings', 'vapid_keys']);
  });

  it('rejects a foreign database and a newer schema', () => {
    const dir = tmp();
    const foreign = new Database(join(dir, 'foreign.sqlite'));
    foreign.exec('CREATE TABLE other (x INTEGER)');
    foreign.close();
    expect((catchError(() => openDatabase(join(dir, 'foreign.sqlite'), new FakeClock())) as R2Error).code).toBe('incompatible_schema');

    const path = join(dir, 'r2.sqlite');
    openDatabase(path, new FakeClock()).close();
    const raw = new Database(path);
    raw.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)').run(999, 'future', 0);
    raw.close();
    expect((catchError(() => openDatabase(path, new FakeClock())) as R2Error).code).toBe('incompatible_schema');
  });

  it('preserves records across a file-backed reopen', () => {
    const path = join(tmp(), 'r2.sqlite');
    const clock = new FakeClock();
    const first = openStorage(path, clock);
    first.setTimezone('America/Toronto');
    const reminder = first.confirmProposal(first.storeProposal(proposalInput()).id, 'req-1');
    first.close();
    const second = file(path, clock);
    expect(second.getSettings().timezone).toBe('America/Toronto');
    expect(second.getReminder(reminder.id)).toEqual(reminder);
  });
});

describe('schema constraints', () => {
  const insertReminder = (s: SqliteStorage, over: Record<string, unknown> = {}) => {
    const p = s.storeProposal(proposalInput());
    const row = { id: 'r1', proposal_id: p.id, request_id: 'q1', text: 't', due_at: 1, timezone: 'UTC', local_datetime: '2026-01-01T00:00', state: 'scheduled', next_attempt_at: 1, created_at: 1, ...over };
    s.db
      .prepare(
        `INSERT INTO reminders (id, proposal_id, request_id, text, due_at, timezone, local_datetime, state, next_attempt_at, created_at)
         VALUES (@id, @proposal_id, @request_id, @text, @due_at, @timezone, @local_datetime, @state, @next_attempt_at, @created_at)`,
      )
      .run(row);
  };

  it('restricts reminder states and keeps the request immutable', () => {
    const s = mem();
    expect(() => insertReminder(s, { state: 'retry_wait' })).toThrow(/CHECK/);
    insertReminder(s);
    expect(s.db.prepare('SELECT attempts FROM reminders').get()).toEqual({ attempts: 0 });
    expect(() => s.db.prepare("UPDATE reminders SET state = 'bogus'").run()).toThrow(/CHECK/);
    expect(() => s.db.prepare("UPDATE reminders SET state = 'sending'").run()).toThrow(/CHECK/);
    expect(() => s.db.prepare('UPDATE reminders SET due_at = 5').run()).toThrow(/immutable/);
    s.db.prepare("UPDATE reminders SET state = 'retry', attempts = 1").run();
  });

  it('enforces unique proposal and request ids on reminders', () => {
    const s = mem();
    insertReminder(s);
    expect(() => insertReminder(s, { id: 'r2', request_id: 'q1' })).toThrow(/UNIQUE/);
    const proposalId = (s.db.prepare('SELECT proposal_id p FROM reminders').get() as { p: string }).p;
    expect(() => insertReminder(s, { id: 'r3', request_id: 'q3', proposal_id: proposalId })).toThrow(/UNIQUE/);
  });

  it('restricts delivery outcomes, attempt numbers and references', () => {
    const s = mem();
    insertReminder(s);
    const add = (n: number, outcome: string) =>
      s.db
        .prepare("INSERT INTO delivery_attempts (reminder_id, attempt_number, claim_token, subscription_version, started_at, outcome, finished_at) VALUES ('r1', ?, 'c', 1, 1, ?, 2)")
        .run(n, outcome);
    add(1, 'accepted');
    expect(() => add(1, 'failed')).toThrow(/UNIQUE/);
    expect(() => add(2, 'in_progress')).toThrow(/CHECK/);
    expect(() => s.db.prepare("INSERT INTO delivery_attempts (reminder_id, attempt_number, claim_token, subscription_version, started_at, outcome) VALUES ('nope', 1, 'c', 1, 1, 'started')").run()).toThrow(/FOREIGN KEY/);
  });

  it('allows one settings row and one subscription row', () => {
    const s = mem();
    expect(() => s.db.prepare('INSERT INTO owner_settings (id) VALUES (2)').run()).toThrow(/CHECK/);
    expect(() => s.db.prepare("INSERT INTO push_subscription (id, endpoint, p256dh, auth, version) VALUES (2,'e','p','a',1)").run()).toThrow(/CHECK/);
    expect(s.getSettings()).toEqual({ timezone: null, notificationsPaused: false });
  });
});

describe('settings, sessions and subscription', () => {
  it('stores an explicit valid IANA timezone and the pause flag', () => {
    const s = mem();
    expect(s.setTimezone('America/Toronto').timezone).toBe('America/Toronto');
    expect(s.setNotificationsPaused(true)).toEqual({ timezone: 'America/Toronto', notificationsPaused: true });
    for (const bad of ['Mars/Base', '+05:00', '', 'x'.repeat(100)]) {
      expect((catchError(() => s.setTimezone(bad)) as R2Error).code).toBe('invalid_timezone');
    }
  });

  it('stores only a hash of the session token and honours expiry and revocation', () => {
    const clock = new FakeClock();
    const s = mem(clock);
    s.createSession('super-secret-token', NOON + 1000);
    expect(JSON.stringify(s.db.prepare('SELECT * FROM sessions').all())).not.toContain('super-secret-token');
    expect(s.getSession('super-secret-token')).toEqual({ createdAt: NOON, expiresAt: NOON + 1000 });
    expect(s.getSession('other')).toBeUndefined();
    clock.advance(1000);
    expect(s.getSession('super-secret-token')).toBeUndefined();
    expect(s.purgeExpiredSessions()).toBe(1);
    s.createSession('t2', NOON + 5000);
    expect(s.revokeSession('t2')).toBe(true);
    expect(s.revokeSession('t2')).toBe(false);
    expect((catchError(() => s.createSession('t3', NOON)) as R2Error).code).toBe('invalid_request');
  });

  it('versions the singleton subscription and tracks readiness per version', () => {
    const s = mem(new FakeClock());
    expect(s.getSubscription()).toBeUndefined();
    const v1 = s.replaceSubscription({ endpoint: 'https://push.example/1', p256dh: 'p', auth: 'a' });
    expect(v1).toMatchObject({ version: 1, readyAt: null });
    expect(s.markSubscriptionReady(1)).toBe(true);
    expect(s.getSubscription()?.readyAt).toBe(NOON);
    const v2 = s.replaceSubscription({ endpoint: 'https://push.example/2', p256dh: 'p2', auth: 'a2' });
    expect(v2).toMatchObject({ version: 2, readyAt: null, endpoint: 'https://push.example/2' });
    expect(s.markSubscriptionReady(1)).toBe(false);
    expect(s.db.prepare('SELECT COUNT(*) n FROM push_subscription').get()).toEqual({ n: 1 });
    expect((catchError(() => s.replaceSubscription({ endpoint: '', p256dh: 'p', auth: 'a' })) as R2Error).code).toBe('invalid_request');
  });
});

describe('proposals and atomic confirmation', () => {
  it('stores, reads and expires proposals', () => {
    const clock = new FakeClock();
    const s = mem(clock);
    const p = s.storeProposal(proposalInput());
    expect(p.id).toMatch(/^prp_/);
    expect(s.getProposal(p.id)).toEqual(p);
    expect(s.expireProposals()).toBe(0);
    clock.advance(900_000);
    expect(s.expireProposals()).toBe(1);
    expect(s.getProposal(p.id)).toBeUndefined();
    expect((catchError(() => s.storeProposal(proposalInput({ timezone: 'Nowhere/Land' }))) as R2Error).code).toBe('invalid_timezone');
    expect((catchError(() => s.storeProposal(proposalInput({ expiresAt: NOON }))) as R2Error).code).toBe('invalid_request');
  });

  it('confirms once, keeping the original local time and due instant', () => {
    const s = mem();
    const p = s.storeProposal(proposalInput());
    const r = s.confirmProposal(p.id, 'req-1');
    expect(r).toMatchObject({ proposalId: p.id, requestId: 'req-1', text: p.text, dueAt: p.dueAt, timezone: 'America/Toronto', localDateTime: '2026-10-14T09:00', state: 'scheduled', attempts: 0, nextAttemptAt: p.dueAt });
    expect(r.id).toMatch(/^rem_/);
    expect(s.getProposal(p.id)).toMatchObject({ confirmedReminderId: r.id, requestId: 'req-1' });
    expect(s.getReminder(r.id)).toEqual(r);
    expect(s.getReminder('missing')).toBeUndefined();
  });

  it('returns the original reminder when the proposal is confirmed again, even with a fresh request id', () => {
    const s = mem();
    const p = s.storeProposal(proposalInput());
    const first = s.confirmProposal(p.id, 'req-1');
    expect(s.confirmProposal(p.id, 'req-1')).toEqual(first);
    expect(s.confirmProposal(p.id, 'req-2')).toEqual(first);
    expect(s.db.prepare('SELECT COUNT(*) n FROM reminders').get()).toEqual({ n: 1 });
  });

  it('keeps a confirmed proposal confirmable after it passes its expiry, but refuses an unconfirmed expired one', () => {
    const clock = new FakeClock();
    const s = mem(clock);
    const confirmed = s.storeProposal(proposalInput());
    const reminder = s.confirmProposal(confirmed.id, 'req-1');
    const unconfirmed = s.storeProposal(proposalInput({ text: 'Other' }));
    clock.advance(900_000);
    expect(s.confirmProposal(confirmed.id, 'req-9')).toEqual(reminder);
    expect((catchError(() => s.confirmProposal(unconfirmed.id, 'req-2')) as R2Error).code).toBe('proposal_expired');
    expect((catchError(() => s.confirmProposal('prp_missing', 'req-3')) as R2Error).code).toBe('proposal_not_found');
    expect(s.db.prepare('SELECT COUNT(*) n FROM reminders').get()).toEqual({ n: 1 });
  });

  it('returns a typed conflict when a request id is reused for a different proposal', () => {
    const s = mem();
    const a = s.storeProposal(proposalInput());
    const b = s.storeProposal(proposalInput({ text: 'Different' }));
    s.confirmProposal(a.id, 'req-1');
    const error = catchError(() => s.confirmProposal(b.id, 'req-1'));
    expect(error).toBeInstanceOf(R2Error);
    expect((error as R2Error).code).toBe('request_id_conflict');
    expect((error as R2Error).status).toBe(409);
    expect(s.db.prepare('SELECT COUNT(*) n FROM reminders').get()).toEqual({ n: 1 });
    expect(s.getProposal(b.id)?.confirmedReminderId).toBeNull();
  });

  it('never creates two reminders when two connections confirm the same proposal', () => {
    const path = join(tmp(), 'r2.sqlite');
    const clock = new FakeClock();
    const a = file(path, clock);
    const b = file(path, clock);
    const p = a.storeProposal(proposalInput());
    // Duplicate request id, then different request ids, from separate connections.
    const r1 = a.confirmProposal(p.id, 'req-1');
    const r2 = b.confirmProposal(p.id, 'req-1');
    const r3 = b.confirmProposal(p.id, 'req-other');
    const r4 = a.confirmProposal(p.id, 'req-third');
    expect([r2, r3, r4]).toEqual([r1, r1, r1]);
    expect(a.db.prepare('SELECT COUNT(*) n FROM reminders').get()).toEqual({ n: 1 });

    // A request id taken on one connection conflicts on the other.
    const q = a.storeProposal(proposalInput({ text: 'Second' }));
    expect((catchError(() => b.confirmProposal(q.id, 'req-1')) as R2Error).code).toBe('request_id_conflict');
  });

  it('serialises writers with BEGIN IMMEDIATE and is durable on return', () => {
    const path = join(tmp(), 'r2.sqlite');
    const a = file(path);
    const p = a.storeProposal(proposalInput());
    const reminder = a.confirmProposal(p.id, 'req-1');
    // A completely separate connection sees the committed reminder immediately.
    const raw = new Database(path, { readonly: true });
    cleanups.push(() => raw.close());
    expect(raw.prepare('SELECT id FROM reminders').get()).toEqual({ id: reminder.id });
    // A competing writer is refused while a write lock is held.
    const holder = new Database(path);
    cleanups.push(() => holder.close());
    holder.pragma('busy_timeout = 0');
    holder.exec('BEGIN IMMEDIATE');
    const q = a.storeProposal.bind(a);
    a.db.pragma('busy_timeout = 0');
    expect(() => q(proposalInput())).toThrow(/locked|busy/i);
    holder.exec('ROLLBACK');
  });

  it('rolls back everything and reports failure when the transaction fails midway', () => {
    const s = mem();
    const p = s.storeProposal(proposalInput());
    s.db.exec("CREATE TRIGGER sabotage BEFORE UPDATE ON proposals BEGIN SELECT RAISE(ABORT, 'disk on fire'); END");
    expect(() => s.confirmProposal(p.id, 'req-1')).toThrow(/disk on fire/);
    expect(s.db.prepare('SELECT COUNT(*) n FROM reminders').get()).toEqual({ n: 0 });
    expect(s.getProposal(p.id)?.confirmedReminderId).toBeNull();
    expect(s.db.inTransaction).toBe(false);
    s.db.exec('DROP TRIGGER sabotage');
    expect(s.confirmProposal(p.id, 'req-1').requestId).toBe('req-1');
  });

  it('lists reminders by due time and exposes ISO-8601 DTOs without internal fields', () => {
    const s = mem();
    const late = s.confirmProposal(s.storeProposal(proposalInput({ dueAt: NOON + 7_200_000, text: 'Late' })).id, 'a');
    const early = s.confirmProposal(s.storeProposal(proposalInput({ dueAt: NOON + 60_000, text: 'Early' })).id, 'b');
    expect(s.listReminders().map((r) => r.id)).toEqual([early.id, late.id]);
    expect(s.listReminders({ limit: 1 })).toHaveLength(1);
    expect(() => s.listReminders({ limit: 0 })).toThrow(R2Error);
    const dto = toReminderDto(early);
    expect(dto).toMatchObject({ dueAt: '2026-10-14T12:01:00.000Z', timezone: 'America/Toronto', localDateTime: '2026-10-14T09:00', state: 'scheduled', acceptedAt: null });
    expect(Object.keys(dto)).not.toEqual(expect.arrayContaining(['claimToken', 'leaseUntil', 'requestId']));
    expect(toProposalDto(s.getProposal(early.proposalId)!).expiresAt).toBe('2026-10-14T12:15:00.000Z');
  });
});

describe('quota and delivery records', () => {
  it('counts model usage persistently up to the limit', () => {
    const path = join(tmp(), 'r2.sqlite');
    const a = openStorage(path, new FakeClock());
    expect(a.consumeModelQuota('2026-10-14', 2)).toEqual({ allowed: true, count: 1 });
    expect(a.consumeModelQuota('2026-10-14', 2)).toEqual({ allowed: true, count: 2 });
    expect(a.consumeModelQuota('2026-10-14', 2)).toEqual({ allowed: false, count: 2 });
    expect(a.consumeModelQuota('2026-10-15', 2).allowed).toBe(true);
    a.close();
    const b = file(path);
    expect(b.getModelUsage('2026-10-14')).toBe(2);
    expect(b.getModelUsage('unused')).toBe(0);
    expect(b.consumeModelQuota('2026-10-14', 2).allowed).toBe(false);
    expect((catchError(() => b.consumeModelQuota('', 1)) as R2Error).code).toBe('invalid_request');
  });

  it('records numbered attempts before sending and finishes each once', () => {
    const clock = new FakeClock();
    const s = mem(clock);
    const reminder = s.confirmProposal(s.storeProposal(proposalInput()).id, 'req-1');
    const one = s.startDeliveryAttempt({ reminderId: reminder.id, claimToken: 'c1', subscriptionVersion: 1 });
    expect(one).toMatchObject({ attemptNumber: 1, outcome: 'started', finishedAt: null });
    clock.advance(500);
    expect(s.finishDeliveryAttempt(one.id, 'failed', 'temporary')).toMatchObject({ outcome: 'failed', errorCode: 'temporary', finishedAt: NOON + 500 });
    expect((catchError(() => s.finishDeliveryAttempt(one.id, 'accepted')) as R2Error).code).toBe('conflict');
    const two = s.startDeliveryAttempt({ reminderId: reminder.id, claimToken: 'c2', subscriptionVersion: 2 });
    expect(two.attemptNumber).toBe(2);
    s.finishDeliveryAttempt(two.id, 'unknown');
    expect(s.listDeliveryAttempts(reminder.id).map((a) => a.outcome)).toEqual(['failed', 'unknown']);
    expect((catchError(() => s.startDeliveryAttempt({ reminderId: 'nope', claimToken: 'c', subscriptionVersion: 1 })) as R2Error).code).toBe('not_found');
    const dto = toDeliveryAttemptDto(one);
    expect(dto).not.toHaveProperty('claimToken');
    expect(dto.startedAt).toBe('2026-10-14T12:00:00.000Z');
  });
});
