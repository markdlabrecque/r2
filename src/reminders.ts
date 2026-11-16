import { Temporal } from '@js-temporal/polyfill';

/**
 * Deterministic time rules for one-off reminders. The model proposes a local date/time;
 * this code decides whether it is a real, unambiguous, future instant in the owner's zone.
 */

const LOCAL_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/** A one-off reminder further away than this is more likely a misunderstanding. */
export const MAX_HORIZON_MS = 5 * 366 * 24 * 60 * 60 * 1000;

export type TimeResolution =
  | { ok: true; dueAt: number; localDateTime: string; utcOffset: string }
  | { ok: false; reason: 'format' | 'nonexistent' | 'ambiguous' | 'past' | 'too_far'; message: string };

const fail = (reason: Extract<TimeResolution, { ok: false }>['reason'], message: string): TimeResolution => ({
  ok: false,
  reason,
  message,
});

/**
 * Resolve `YYYY-MM-DDTHH:mm` in `timezone` to a UTC instant. Impossible dates, local times
 * skipped or repeated by a clock change, and times that are not in the future are rejected
 * with a message that is safe to show the owner.
 */
export function resolveLocalTime(localDateTime: string, timezone: string, now: number): TimeResolution {
  if (!LOCAL_DATE_TIME.test(localDateTime)) return fail('format', 'I could not work out a valid date and time. What date and time do you want?');
  let plain: Temporal.PlainDateTime;
  try {
    plain = Temporal.PlainDateTime.from(localDateTime, { overflow: 'reject' });
  } catch {
    return fail('format', 'That date does not exist. What date and time do you want?');
  }
  let zoned: Temporal.ZonedDateTime;
  try {
    zoned = plain.toZonedDateTime(timezone, { disambiguation: 'reject' });
  } catch {
    const compatible = plain.toZonedDateTime(timezone, { disambiguation: 'compatible' });
    return Temporal.PlainDateTime.compare(compatible.toPlainDateTime(), plain) !== 0
      ? fail('nonexistent', `${plain.toString()} does not exist in ${timezone} because the clocks change then. Choose a different time.`)
      : fail('ambiguous', `${plain.toString()} happens twice in ${timezone} because the clocks change then. Choose a different time.`);
  }
  const dueAt = zoned.epochMilliseconds;
  if (dueAt <= now) return fail('past', 'That time has already passed. What future date and time do you want?');
  if (dueAt - now > MAX_HORIZON_MS) return fail('too_far', 'That is more than five years away. What nearer date and time do you want?');
  return { ok: true, dueAt, localDateTime: plain.toString({ smallestUnit: 'minute' }), utcOffset: zoned.offset };
}

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** The owner's current local time as model context, for example `Wednesday 2026-10-14T08:00`. */
export function describeNow(now: number, timezone: string): string {
  const zoned = Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO(timezone);
  const weekday = WEEKDAYS[zoned.dayOfWeek - 1] ?? '';
  return `${weekday} ${zoned.toPlainDateTime().toString({ smallestUnit: 'minute' })}`;
}
