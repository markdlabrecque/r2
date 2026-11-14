import { readFileSync } from 'node:fs';
import { buildSync } from 'esbuild';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

const script = buildSync({ entryPoints: ['web/app.ts'], bundle: true, format: 'iife', write: false }).outputFiles[0]!.text;

async function page(overrides: Record<string, unknown> = {}) {
  const dom = new JSDOM(readFileSync('web/index.html', 'utf8'), { url: 'https://r2.example.ts.net', runScripts: 'outside-only' });
  const responses: Record<string, unknown> = {
    '/api/session': { authenticated: true, loginAvailable: true },
    '/api/settings': { timezone: 'America/Toronto' },
    '/api/reminders': { reminders: [{ text: 'Private reminder', localDateTime: '2026-10-15T19:00', timezone: 'America/Toronto', state: 'retry', attempts: 1, errorCode: 'temporary', nextAttemptAt: '2026-10-15T23:01:00.000Z', deliveryAttempts: [{ outcome: 'failed' }] }] },
    '/api/push': { configured: false },
    '/api/status': { worker: { state: 'stopped' }, notifications: { paused: false, pausedByConfig: false }, assistantConfigured: false, reminders: { due: 1, byState: {} } },
    ...overrides,
  };
  dom.window.fetch = (async (url: string) => {
    const data = responses[url];
    if (data instanceof Error) throw data;
    return { ok: true, json: async () => data } as Response;
  }) as typeof fetch;
  dom.window.eval(script);
  await new Promise((resolve) => setTimeout(resolve, 20));
  return dom;
}

describe('owner web states', () => {
  it('shows actionable retry details, stopped worker and disabled assistant without implying delivery', async () => {
    const dom = await page();
    const text = dom.window.document.body.textContent!;
    expect(text).toContain('Private reminder');
    expect(text).toContain('2026-10-15 19:00 America/Toronto');
    expect(text).toContain('2026-10-15 19:01 America/Toronto');
    expect(text).toContain('worker is stopped');
    expect(text).toContain('assistant is not configured');
    dom.window.close();
  });

  it('explains permanent failure and provider acceptance without claiming display', async () => {
    const base = { localDateTime: '2026-10-15T19:00', timezone: 'America/Toronto', attempts: 1, nextAttemptAt: '2026-10-15T23:01:00Z', deliveryAttempts: [{ outcome: 'failed' }] };
    const dom = await page({ '/api/reminders': { reminders: [
      { ...base, text: 'Failed', state: 'failed', errorCode: 'subscription_gone' },
      { ...base, text: 'Accepted', state: 'accepted', errorCode: null, deliveryAttempts: [{ outcome: 'accepted' }] },
    ] } });
    const text = dom.window.document.getElementById('reminders')!.textContent!;
    expect(text).toContain('Browser subscription expired. Connect the browser again; this reminder stays failed.');
    expect(text).toContain('Push service accepted (does not prove you saw it)');
    dom.window.close();
  });

  it('reports refresh failures rather than leaving stale healthy status', async () => {
    const dom = await page({ '/api/status': new Error('offline'), '/api/reminders': new Error('offline') });
    expect(dom.window.document.getElementById('service-state')!.textContent).toContain('cannot be reached');
    expect(dom.window.document.getElementById('reminders-status')!.textContent).toContain('cannot be reached');
    dom.window.close();
  });
});
