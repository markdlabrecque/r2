import { statSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase, schemaVersion, SchemaError } from '../src/db.ts';
import { migrations } from '../src/migrations.ts';
import { FakeClock, tempDir } from './helpers.ts';

const dirs: { cleanup(): void }[] = [];
const tmp = () => {
  const t = tempDir();
  dirs.push(t);
  return t.dir;
};
afterEach(() => dirs.splice(0).forEach((d) => d.cleanup()));

const insertReminder = (db: ReturnType<typeof openDatabase>, over: Record<string, unknown> = {}) => {
  const r = {
    id: 'r_1', request_id: 'req-1', text: 'Take the bins out', due_at_ms: 1000, timezone: 'America/Toronto',
    status: 'scheduled', next_attempt_at_ms: 1000, created_at_ms: 1, updated_at_ms: 1, ...over,
  };
  db.prepare(
    `INSERT INTO reminders (id, request_id, text, due_at_ms, timezone, status, next_attempt_at_ms, created_at_ms, updated_at_ms)
     VALUES (@id, @request_id, @text, @due_at_ms, @timezone, @status, @next_attempt_at_ms, @created_at_ms, @updated_at_ms)`,
  ).run(r);
};

describe('sqlite contracts', () => {
  it('persists across reopen, migrates once, and uses private file modes', () => {
    const path = join(tmp(), 'data', 'r2.sqlite');
    const clock = new FakeClock();
    let db = openDatabase(path, clock);
    insertReminder(db);
    db.close();
    db = openDatabase(path, clock);
    expect(schemaVersion(db)).toBe(migrations.at(-1)!.version);
    expect(db.prepare('SELECT COUNT(*) n FROM schema_migrations').get()).toEqual({ n: migrations.length });
    expect(db.prepare('SELECT text, due_at_ms FROM reminders').get()).toEqual({ text: 'Take the bins out', due_at_ms: 1000 });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(path, '..')).mode & 0o777).toBe(0o700);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('synchronous', { simple: true })).toBe(2);
    db.close();
  });

  it('refuses a database from a newer build', () => {
    const path = join(tmp(), 'r2.sqlite');
    const raw = new Database(path);
    migrate(raw, new FakeClock());
    raw.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)').run(999, 'future', 0);
    raw.close();
    expect(() => openDatabase(path, new FakeClock())).toThrow(SchemaError);
  });

  it('rejects a duplicate confirmation request id', () => {
    const db = openDatabase(':memory:', new FakeClock());
    insertReminder(db);
    expect(() => insertReminder(db, { id: 'r_2' })).toThrow(/UNIQUE/);
  });

  it('keeps the confirmed request immutable but lets delivery state change', () => {
    const db = openDatabase(':memory:', new FakeClock());
    insertReminder(db);
    expect(() => db.prepare('UPDATE reminders SET due_at_ms = 5 WHERE id = ?').run('r_1')).toThrow(/immutable/);
    expect(() => db.prepare('UPDATE reminders SET text = ? WHERE id = ?').run('x', 'r_1')).toThrow(/immutable/);
    db.prepare("UPDATE reminders SET status = 'sending', lease_expires_at_ms = 9, attempt_count = 1 WHERE id = ?").run('r_1');
    expect(db.prepare('SELECT status FROM reminders').get()).toEqual({ status: 'sending' });
  });

  it('bounds attempts and requires consistent state', () => {
    const db = openDatabase(':memory:', new FakeClock());
    insertReminder(db);
    expect(() => db.prepare('UPDATE reminders SET attempt_count = 5').run()).toThrow(/CHECK/);
    expect(() => db.prepare("UPDATE reminders SET status = 'sending'").run()).toThrow(/CHECK/);
    expect(() => db.prepare("UPDATE reminders SET status = 'accepted'").run()).toThrow(/CHECK/);
    expect(() => db.prepare("UPDATE reminders SET status = 'bogus'").run()).toThrow(/CHECK/);
  });

  it('records at most one row per attempt number and keeps reminders referenced', () => {
    const db = openDatabase(':memory:', new FakeClock());
    insertReminder(db);
    const add = () =>
      db.prepare("INSERT INTO delivery_attempts (reminder_id, attempt_number, started_at_ms, outcome) VALUES ('r_1', 1, 1, 'in_progress')").run();
    add();
    expect(add).toThrow(/UNIQUE/);
    expect(() => db.prepare('DELETE FROM reminders').run()).toThrow(/FOREIGN KEY/);
    expect(() => db.prepare("INSERT INTO delivery_attempts (reminder_id, attempt_number, started_at_ms, outcome) VALUES ('nope', 1, 1, 'in_progress')").run()).toThrow(/FOREIGN KEY/);
  });

  it('allows only one settings row, one subscription and one VAPID pair', () => {
    const db = openDatabase(':memory:', new FakeClock());
    expect(() => db.prepare('INSERT INTO settings (id, updated_at_ms) VALUES (2, 0)').run()).toThrow(/CHECK/);
    expect(() => db.prepare("INSERT INTO push_subscription (id, endpoint, p256dh, auth, created_at_ms) VALUES (2,'e','p','a',0)").run()).toThrow(/CHECK/);
    expect(db.prepare('SELECT timezone FROM settings').get()).toEqual({ timezone: null });
  });
});
