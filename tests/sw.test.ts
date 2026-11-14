import { runInNewContext } from 'node:vm';
import { buildSync } from 'esbuild';
import { describe, expect, it } from 'vitest';

/** Run the real service worker source against a minimal fake worker scope. */
function loadWorker() {
  const out = buildSync({ entryPoints: ['web/sw.ts'], bundle: true, format: 'iife', write: false });
  const listeners: Record<string, (event: unknown) => void> = {};
  const shown: { title: string; options: Record<string, unknown> }[] = [];
  const opened: string[] = [];
  const self = {
    location: { origin: 'https://r2.example.ts.net' },
    registration: {
      showNotification: async (title: string, options: Record<string, unknown>) => void shown.push({ title, options }),
    },
    clients: {
      matchAll: async () => [],
      openWindow: async (url: string) => void opened.push(url),
      claim: async () => undefined,
    },
    skipWaiting: async () => undefined,
    addEventListener: (type: string, fn: (event: unknown) => void) => void (listeners[type] = fn),
  };
  runInNewContext(out.outputFiles[0]!.text, { self, URL });
  return { listeners, shown, opened };
}

const pushEvent = (data: unknown, waits: Promise<unknown>[]) => ({
  data: { json: () => (data instanceof Error ? (() => { throw data; })() : data) },
  waitUntil: (p: Promise<unknown>) => void waits.push(p),
});

describe('service worker', () => {
  it('shows only the generic text, whatever the payload contains', async () => {
    const { listeners, shown } = loadWorker();
    const waits: Promise<unknown>[] = [];
    listeners.push!(pushEvent({ reminderId: 'rem_abc', text: 'Call the dentist', dueAt: '2026-10-15T19:00Z' }, waits));
    listeners.push!(pushEvent(new Error('not json'), waits));
    await Promise.all(waits);
    expect(shown).toHaveLength(2);
    for (const n of shown) {
      expect(n.title).toBe('You have an R2 reminder');
      expect(n.options.body).toBe('You have an R2 reminder');
      expect(JSON.stringify(n)).not.toMatch(/dentist|2026/);
    }
    expect(shown[0]!.options.tag).toBe('rem_abc');
    expect(shown[1]!.options.tag).toBe('r2-reminder');
  });

  it('opens R2 when the notification is clicked', async () => {
    const { listeners, opened } = loadWorker();
    const waits: Promise<unknown>[] = [];
    let closed = false;
    listeners.notificationclick!({ notification: { close: () => (closed = true) }, waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
    expect(closed).toBe(true);
    expect(opened).toEqual(['/']);
  });
});
