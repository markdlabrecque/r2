import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { Clock } from './clock.ts';
import { migrations } from './migrations.ts';

export type Db = Database.Database;

export class SchemaError extends Error {}

/**
 * Open (creating if needed) the R2 database, with private file modes, and apply migrations.
 * Pass ":memory:" only for throwaway tests.
 */
export function openDatabase(path: string, clock: Clock): Db {
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
    migrate(db, clock);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function schemaVersion(db: Db): number {
  const exists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get();
  if (!exists) return 0;
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null };
  return row.v ?? 0;
}

export function migrate(db: Db, clock: Clock): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at_ms INTEGER NOT NULL
  ) STRICT`);
  const latest = migrations.at(-1)?.version ?? 0;
  const current = schemaVersion(db);
  if (current > latest) {
    throw new SchemaError(
      `Database schema version ${current} is newer than this R2 build (${latest}). Refusing to start.`,
    );
  }
  for (const m of migrations) {
    if (m.version <= current) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at_ms) VALUES (?, ?, ?)').run(
        m.version,
        m.name,
        clock.now(),
      );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}
