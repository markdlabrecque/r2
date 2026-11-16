import { describe, expect, it } from 'vitest';
import { LOGIN_MAX_ATTEMPTS, LOGIN_WINDOW_MS, LoginThrottle } from '../src/auth.ts';
import { toDeliveryAttemptDto, toProposalDto, toReminderDto, type DeliveryAttempt, type Proposal, type Reminder } from '../src/contracts.ts';
import { FakeClock } from './helpers.ts';

describe('LoginThrottle policy', () => {
  it('limits attempts in a sliding window and expires them at the boundary', () => {
    const clock = new FakeClock();
    const throttle = new LoginThrottle(clock);
    expect(throttle.begin()).toBe(0);
    clock.advance(1000);
    for (let i = 1; i < LOGIN_MAX_ATTEMPTS; i++) expect(throttle.begin()).toBe(0);
    expect(throttle.begin()).toBe(LOGIN_WINDOW_MS - 1000);
    clock.advance(LOGIN_WINDOW_MS - 1001);
    expect(throttle.begin()).toBe(1);
    clock.advance(1);
    expect(throttle.begin()).toBe(0);
    // Only the first attempt expired: a fixed-window reset would admit another.
    expect(throttle.begin()).toBe(1000);
    clock.advance(1000);
    expect(throttle.begin()).toBe(0);
  });

  it('clears the count after a successful password without advancing time', () => {
    const throttle = new LoginThrottle(new FakeClock());
    for (let i = 0; i < LOGIN_MAX_ATTEMPTS; i++) expect(throttle.begin()).toBe(0);
    expect(throttle.begin()).toBe(LOGIN_WINDOW_MS);
    throttle.clear();
    for (let i = 0; i < LOGIN_MAX_ATTEMPTS; i++) expect(throttle.begin()).toBe(0);
    expect(throttle.begin()).toBe(LOGIN_WINDOW_MS);
  });
});

describe('public DTO policy', () => {
  it('formats instants and excludes internal request and claim fields', () => {
    const createdAt = Date.parse('2026-10-14T12:00:00.000Z');
    const dueAt = Date.parse('2026-10-15T23:00:00.000Z');
    const proposal: Proposal = {
      id: 'p1', text: 'Bins', dueAt, timezone: 'America/Toronto',
      localDateTime: '2026-10-15T19:00', createdAt,
      expiresAt: createdAt + 900_000, confirmedReminderId: 'r1', requestId: 'private-request',
    };
    expect(toProposalDto(proposal)).toEqual({
      id: 'p1', text: 'Bins', dueAt: '2026-10-15T23:00:00.000Z', timezone: 'America/Toronto',
      localDateTime: '2026-10-15T19:00', createdAt: '2026-10-14T12:00:00.000Z',
      expiresAt: '2026-10-14T12:15:00.000Z', confirmedReminderId: 'r1',
    });
    const reminder: Reminder = {
      id: 'r1', proposalId: 'p1', requestId: 'private-request', text: 'Bins', dueAt,
      timezone: 'America/Toronto', localDateTime: '2026-10-15T19:00', state: 'accepted',
      attempts: 1, nextAttemptAt: dueAt, leaseUntil: dueAt + 60_000,
      claimToken: 'private-claim', createdAt, acceptedAt: dueAt + 1000, errorCode: null,
    };
    expect(toReminderDto(reminder)).toEqual({
      id: 'r1', proposalId: 'p1', text: 'Bins', dueAt: '2026-10-15T23:00:00.000Z',
      timezone: 'America/Toronto', localDateTime: '2026-10-15T19:00', state: 'accepted',
      attempts: 1, nextAttemptAt: '2026-10-15T23:00:00.000Z',
      createdAt: '2026-10-14T12:00:00.000Z', acceptedAt: '2026-10-15T23:00:01.000Z', errorCode: null,
    });
    expect(toReminderDto({ ...reminder, acceptedAt: null }).acceptedAt).toBeNull();
    const attempt: DeliveryAttempt = {
      id: 1, reminderId: 'r1', attemptNumber: 1, claimToken: 'private-claim', subscriptionVersion: 2,
      startedAt: dueAt, finishedAt: dueAt + 1000, outcome: 'accepted', errorCode: null,
    };
    expect(toDeliveryAttemptDto(attempt)).toEqual({
      attemptNumber: 1, subscriptionVersion: 2, startedAt: '2026-10-15T23:00:00.000Z',
      finishedAt: '2026-10-15T23:00:01.000Z', outcome: 'accepted', errorCode: null,
    });
    expect(toDeliveryAttemptDto({ ...attempt, finishedAt: null }).finishedAt).toBeNull();
  });
});
