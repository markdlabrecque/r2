import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { authPlugin } from '../src/auth.ts';
import { chatPlugin, DAILY_MODEL_LIMIT } from '../src/chat.ts';
import { loadConfig } from '../src/config.ts';
import type { ModelInterpreter, ModelOutcome } from '../src/contracts.ts';
import { openStorage } from '../src/db.ts';
import { createInterpreter, parseOutcome } from '../src/openai.ts';
import { resolveLocalTime } from '../src/reminders.ts';
import { hashPassword } from '../src/password.ts';
import { createApp } from '../src/routes.ts';
import { settingsPlugin } from '../src/settings.ts';
import { FakeClock, syntheticEnv, tempDir } from './helpers.ts';

const PASSWORD = 'correct horse battery staple';
const ORIGIN = 'https://r2.example.ts.net';
const headers = { origin: ORIGIN, 'content-type': 'application/json' };

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

class FakeModel implements ModelInterpreter {
  calls: { text: string; now: number; timezone: string }[] = [];
  outcome: ModelOutcome | Error = { type: 'clarify', question: 'What time?' };
  async interpret(text: string, now: number, timezone: string): Promise<ModelOutcome> {
    this.calls.push({ text, now, timezone });
    if (this.outcome instanceof Error) throw this.outcome;
    return this.outcome;
  }
}

async function setup(dataDir?: string, model: ModelInterpreter | null = new FakeModel()) {
  const t = tempDir();
  cleanups.push(t.cleanup);
  const dir = dataDir ?? join(t.dir, 'data');
  const clock = new FakeClock();
  const hash = await hashPassword(PASSWORD, { ln: 10, r: 8, p: 1 });
  const config = loadConfig(syntheticEnv(dir, { R2_PASSWORD_HASH: hash }));
  const storage = openStorage(config.dbPath, clock);
  const app = createApp(
    { config, storage, clock, logger: false, webRoot: join(t.dir, 'none'), ...(model ? { modelInterpreter: model } : {}) },
    [authPlugin, settingsPlugin, chatPlugin],
  );
  cleanups.push(async () => {
    await app.close();
    storage.close();
  });
  const login = await app.inject({ method: 'POST', url: '/api/session', headers, payload: { password: PASSWORD } });
  const cookie = String(login.headers['set-cookie']).split(';')[0] ?? '';
  const post = (url: string, payload: unknown) =>
    app.inject({ method: 'POST', url, headers: { ...headers, cookie }, payload: payload as object });
  const get = (url: string) => app.inject({ method: 'GET', url, headers: { cookie } });
  return { app, storage, clock, model, post, get, dir, cookie };
}

describe('resolveLocalTime', () => {
  const now = Date.UTC(2026, 9, 14, 12, 0, 0);
  it('resolves a valid local time with its offset', () => {
    const r = resolveLocalTime('2026-10-15T19:00', 'America/Toronto', now);
    expect(r).toMatchObject({ ok: true, dueAt: Date.UTC(2026, 9, 15, 23, 0, 0), utcOffset: '-04:00' });
  });
  it('rejects malformed, impossible, past, far, skipped and repeated local times', () => {
    const reason = (s: string) => {
      const r = resolveLocalTime(s, 'America/Toronto', now);
      return r.ok ? 'ok' : r.reason;
    };
    expect(reason('tomorrow 7pm')).toBe('format');
    expect(reason('2026-02-30T10:00')).toBe('format');
    expect(reason('2026-10-14T07:00')).toBe('past');
    expect(reason('2040-01-01T10:00')).toBe('too_far');
    expect(reason('2027-03-14T02:30')).toBe('nonexistent');
    expect(reason('2026-11-01T01:30')).toBe('ambiguous');
  });
});

describe('OpenAI adapter', () => {
  it('sends a strict schema with no tools and only the message, zone and local time', async () => {
    let body: Record<string, unknown> = {};
    const interpreter = createInterpreter(async (b) => {
      body = b;
      return { output_text: JSON.stringify({ type: 'one_off', question: null, text: 'Bins', localDateTime: '2026-10-15T19:00', reason: null }) };
    }, 'test-model');
    const out = await interpreter.interpret('bins tomorrow 7pm', Date.UTC(2026, 9, 14, 12), 'America/Toronto');
    expect(out).toEqual({ type: 'one_off', text: 'Bins', localDateTime: '2026-10-15T19:00' });
    expect(body).toMatchObject({ model: 'test-model', input: 'bins tomorrow 7pm', store: false });
    expect(body).not.toHaveProperty('tools');
    expect(JSON.stringify(body)).toContain('"strict":true');
    expect(String(body.instructions)).toContain('America/Toronto');
  });
  it('treats malformed or incomplete output as a failure', async () => {
    expect(parseOutcome('nope')).toBeNull();
    expect(parseOutcome('{"type":"one_off","question":null,"text":"x","localDateTime":null,"reason":null}')).toBeNull();
    const interpreter = createInterpreter(async () => ({ output_text: 'garbage' }), 'm');
    await expect(interpreter.interpret('x', 0, 'UTC')).rejects.toThrow();
  });
});

describe('chat and confirmation', () => {
  it('requires the owner and a configured timezone', async () => {
    const s = await setup();
    expect((await s.app.inject({ method: 'POST', url: '/api/chat', headers, payload: { message: 'hi' } })).statusCode).toBe(401);
    expect((await s.app.inject({ method: 'GET', url: '/api/reminders' })).statusCode).toBe(401);
    const res = await s.post('/api/chat', { message: 'remind me' });
    expect(res.statusCode).toBe(400);
    expect((s.model as FakeModel).calls).toHaveLength(0);
  });

  it('passes the owner timezone and clock to the model and relays clarifications without saving', async () => {
    const s = await setup();
    s.storage.setTimezone('America/Toronto');
    const res = await s.post('/api/chat', { message: 'Remind me tomorrow' });
    expect(res.json()).toEqual({ type: 'clarify', message: 'What time?' });
    expect((s.model as FakeModel).calls[0]).toMatchObject({ text: 'Remind me tomorrow', timezone: 'America/Toronto', now: s.clock.now() });
    expect(s.storage.listReminders()).toEqual([]);
  });

  it('asks again instead of proposing when the model returns an invalid or past time', async () => {
    const s = await setup();
    s.storage.setTimezone('America/Toronto');
    const model = s.model as FakeModel;
    model.outcome = { type: 'one_off', text: 'Bins', localDateTime: '2026-10-14T07:00' };
    const past = (await s.post('/api/chat', { message: 'bins' })).json();
    expect(past.type).toBe('clarify');
    model.outcome = { type: 'one_off', text: 'Bins', localDateTime: '2027-03-14T02:30' };
    expect((await s.post('/api/chat', { message: 'bins' })).json().type).toBe('clarify');
    expect(s.storage.listReminders()).toEqual([]);
  });

  it('commits a reminder only after explicit confirmation, idempotently, and keeps the original due time', async () => {
    const s = await setup();
    s.storage.setTimezone('America/Toronto');
    (s.model as FakeModel).outcome = { type: 'one_off', text: 'Take the bins out', localDateTime: '2026-10-15T19:00' };
    const chat = (await s.post('/api/chat', { message: 'bins tomorrow 7pm' })).json();
    expect(chat).toMatchObject({ type: 'proposal', utcOffset: '-04:00' });
    expect(chat.proposal).toMatchObject({ text: 'Take the bins out', timezone: 'America/Toronto', localDateTime: '2026-10-15T19:00', dueAt: '2026-10-15T23:00:00.000Z' });
    expect(s.storage.listReminders()).toEqual([]);

    const body = { proposalId: chat.proposal.id, requestId: 'request-0001' };
    const first = (await s.post('/api/reminders/confirm', body)).json();
    const again = (await s.post('/api/reminders/confirm', body)).json();
    expect(again.reminder.id).toBe(first.reminder.id);
    expect(first.reminder).toMatchObject({ state: 'scheduled', localDateTime: '2026-10-15T19:00', timezone: 'America/Toronto' });
    expect(first.reminder).not.toHaveProperty('claimToken');

    const clash = await s.post('/api/reminders/confirm', { proposalId: 'prp_missing', requestId: 'request-0001' });
    expect(clash.statusCode).toBe(404);
    const list = (await s.get('/api/reminders')).json();
    expect(list.reminders).toHaveLength(1);
    expect(list.reminders[0]).toMatchObject({ id: first.reminder.id, text: 'Take the bins out', deliveryAttempts: [] });
  });

  it('rejects an expired proposal and never creates a reminder', async () => {
    const s = await setup();
    s.storage.setTimezone('UTC');
    (s.model as FakeModel).outcome = { type: 'one_off', text: 'Bins', localDateTime: '2026-10-14T18:00' };
    const chat = (await s.post('/api/chat', { message: 'bins' })).json();
    s.clock.advance(16 * 60_000);
    const res = await s.post('/api/reminders/confirm', { proposalId: chat.proposal.id, requestId: 'request-0002' });
    expect(res.statusCode).toBe(404);
    expect(s.storage.listReminders()).toEqual([]);
  });

  it('keeps a confirmed reminder across restart and lists it with the model disabled', async () => {
    const first = await setup();
    first.storage.setTimezone('America/Toronto');
    (first.model as FakeModel).outcome = { type: 'one_off', text: 'Call dentist', localDateTime: '2026-10-20T09:30' };
    const chat = (await first.post('/api/chat', { message: 'dentist' })).json();
    const saved = (await first.post('/api/reminders/confirm', { proposalId: chat.proposal.id, requestId: 'request-0003' })).json();
    await first.app.close();
    first.storage.close();

    const second = await setup(first.dir, null);
    const list = (await second.get('/api/reminders')).json();
    expect(list.reminders.map((r: { id: string }) => r.id)).toEqual([saved.reminder.id]);
    const chatDown = await second.post('/api/chat', { message: 'anything' });
    expect(chatDown.statusCode).toBe(503);
    expect(second.storage.listReminders()).toHaveLength(1);
  });

  it('fails safely when the model errors, without leaking the message to errors, and bounds daily usage', async () => {
    const s = await setup();
    s.storage.setTimezone('UTC');
    const model = s.model as FakeModel;
    model.outcome = new Error('upstream secret detail');
    const res = await s.post('/api/chat', { message: 'private words' });
    expect(res.statusCode).toBe(503);
    expect(res.body).not.toMatch(/secret|private words/);
    expect(s.storage.listReminders()).toEqual([]);

    model.outcome = { type: 'unsupported', reason: 'recurring' };
    const bucket = `chat:${new Date(s.clock.now()).toISOString().slice(0, 10)}`;
    while (s.storage.getModelUsage(bucket) < DAILY_MODEL_LIMIT) s.storage.consumeModelQuota(bucket, DAILY_MODEL_LIMIT);
    const limited = await s.post('/api/chat', { message: 'x' });
    expect(limited.statusCode).toBe(429);
  });
});
