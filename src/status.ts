import type { Db } from './db.ts';
import { schemaVersion } from './db.ts';

export const REMINDER_STATUSES = ['scheduled', 'sending', 'retry_wait', 'accepted', 'failed'] as const;
export type ReminderStatus = (typeof REMINDER_STATUSES)[number];

export interface StoreStatus {
  schemaVersion: number;
  notificationsPaused: boolean;
  timezoneConfigured: boolean;
  browserConnected: boolean;
  reminders: Record<ReminderStatus, number>;
}

/** Non-sensitive summary for health checks: counts and flags only, never reminder content. */
export function readStoreStatus(db: Db): StoreStatus {
  const settings = db.prepare('SELECT timezone, notifications_paused AS paused FROM settings WHERE id = 1').get() as
    | { timezone: string | null; paused: number }
    | undefined;
  if (!settings) throw new Error('settings row is missing');
  const sub = db.prepare('SELECT 1 AS ok FROM push_subscription WHERE id = 1 AND invalidated_at_ms IS NULL').get();
  const reminders = Object.fromEntries(REMINDER_STATUSES.map((s) => [s, 0])) as Record<ReminderStatus, number>;
  const rows = db.prepare('SELECT status, COUNT(*) AS n FROM reminders GROUP BY status').all() as {
    status: ReminderStatus;
    n: number;
  }[];
  for (const r of rows) reminders[r.status] = r.n;
  return {
    schemaVersion: schemaVersion(db),
    notificationsPaused: settings.paused === 1,
    timezoneConfigured: settings.timezone !== null,
    browserConnected: sub !== undefined,
    reminders,
  };
}
