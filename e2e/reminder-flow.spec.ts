import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer as createHttpsServer, type Server } from 'node:https';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { expect, test, type Request } from '@playwright/test';
import type { ModelInterpreter } from '../src/contracts.ts';
import { hashPassword } from '../src/password.ts';
import { startService, type RunningService } from '../src/service.ts';
import { FakeClock, syntheticEnv, tempDir } from '../tests/helpers.ts';
import { createServerCleanup } from '../tests/server-cleanup.ts';

const PASSWORD = 'correct horse battery staple';

class FakeModel implements ModelInterpreter {
  calls: string[] = [];
  async interpret(text: string) {
    this.calls.push(text);
    return /tomorrow\.?$/i.test(text.trim()) && !/\d/.test(text)
      ? ({ type: 'clarify', question: 'What time tomorrow, and what should I remind you about?' } as const)
      : ({ type: 'one_off', text: 'Take the bins out', localDateTime: '2026-10-15T19:00' } as const);
  }
}

/** TLS in front of the loopback service so the browser sees the https origin the service requires. */
function tlsProxy(dir: string, target: () => number): Promise<{ server: Server; close: () => Promise<void> }> {
  const key = join(dir, 'key.pem');
  const cert = join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' });
  const server = createHttpsServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
    const up = httpRequest({ host: '127.0.0.1', port: target(), method: req.method, path: req.url, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on('error', () => {
      res.writeHead(502).end();
    });
    req.pipe(up);
  });
  const close = createServerCleanup(server);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, close })));
}

test('log in, set timezone, chat, double-save, restart: exactly one reminder persists', async ({ page }) => {
  const tmp = tempDir();
  const model = new FakeModel();
  const clock = new FakeClock(); // 2026-10-14T12:00Z
  const hash = await hashPassword(PASSWORD, { ln: 10, r: 8, p: 1 });
  const dataDir = join(tmp.dir, 'data');
  let svc: RunningService | undefined;
  let port = 0;
  const proxy = await tlsProxy(tmp.dir, () => port);
  const origin = `https://localhost:${(proxy.server.address() as AddressInfo).port}`;
  const start = async () => {
    svc = await startService(syntheticEnv(dataDir, { R2_ORIGIN: origin, R2_PASSWORD_HASH: hash }), {
      clock,
      logger: false,
      adapters: { modelInterpreter: model },
    });
    port = svc.port;
  };
  try {
    await start();
    await page.goto(origin);

    await page.fill('#password', 'wrong password');
    await page.click('#login button[type=submit]');
    await expect(page.locator('#login-error')).not.toBeEmpty();

    await page.fill('#password', PASSWORD);
    await page.click('#login button[type=submit]');
    await expect(page.locator('#owner')).toBeVisible();
    await expect(page.locator('#status')).toContainText('Choose your timezone');

    await page.fill('#timezone', 'America/Toronto');
    await page.click('#settings button[type=submit]');
    await expect(page.locator('#settings-status')).toContainText('Timezone saved: America/Toronto');

    // Ambiguous request: asks, saves nothing.
    await page.fill('#message', 'Remind me tomorrow');
    await page.click('#send');
    await expect(page.locator('#reply')).toContainText('What time tomorrow');
    await expect(page.locator('#proposal')).toBeHidden();
    await expect(page.locator('#reminders')).toContainText('No reminders yet');

    // Complete request: proposal shows the zone; nothing is saved until Save.
    await page.fill('#message', 'Take the bins out tomorrow at 7 pm');
    await page.click('#send');
    await expect(page.locator('#proposal')).toBeVisible();
    await expect(page.locator('#proposal-when')).toContainText('2026-10-15 19:00 America/Toronto');
    await expect(page.locator('#reminders')).toContainText('No reminders yet');

    expect(svc!.storage.listReminders()).toHaveLength(0);

    // Hold the first save until the second click sends its request. Neither
    // response can hide the proposal before both real network writes exist.
    const saves: Request[] = [];
    let releaseSaves!: () => void;
    const bothSavesReceived = new Promise<void>((resolve) => { releaseSaves = resolve; });
    await page.route('**/api/reminders/confirm', async (route) => {
      saves.push(route.request());
      if (saves.length === 2) releaseSaves();
      await bothSavesReceived;
      await route.continue(); // No mocked response: both requests reach SQLite.
    });
    await page.locator('#confirm').dblclick();
    await expect.poll(() => saves.length).toBe(2);
    const firstSave = saves[0]!.postDataJSON();
    expect(firstSave).toEqual({ proposalId: expect.any(String), requestId: expect.any(String) });
    expect(firstSave.proposalId).not.toBe('');
    expect(firstSave.requestId).not.toBe('');
    expect(saves[1]!.postDataJSON()).toEqual(firstSave);
    const responses = await Promise.all(saves.map((request) => request.response()));
    for (const response of responses) expect(response?.status()).toBe(200);
    const results = await Promise.all(responses.map((response) => response!.json()));
    expect(results[1]).toEqual(results[0]);
    const savedId = results[0].reminder.id;
    expect(savedId).toEqual(expect.any(String));
    expect(svc!.storage.listReminders()).toHaveLength(1);
    expect(svc!.storage.listReminders()[0]!.id).toBe(savedId);
    expect(model.calls).toEqual(['Remind me tomorrow', 'Take the bins out tomorrow at 7 pm']);

    await expect(page.locator('#confirm-status')).toContainText('Saved');
    await expect(page.locator('#reminders li')).toHaveCount(1);
    await expect(page.locator('#reminders')).toContainText('Take the bins out');

    // Restart on the same data: session and reminder persist; the model is not needed to list.
    await svc!.stop();
    await start();
    expect(svc!.storage.listReminders()).toHaveLength(1);
    expect(svc!.storage.listReminders()[0]!.id).toBe(savedId);
    await page.reload();
    await expect(page.locator('#owner')).toBeVisible();
    await expect(page.locator('#reminders li')).toHaveCount(1);
    await expect(page.locator('#reminders')).toContainText('due 2026-10-15 19:00 America/Toronto');

    await page.click('#logout');
    await expect(page.locator('#login')).toBeVisible();
  } finally {
    await svc?.stop().catch(() => undefined);
    await proxy.close();
    tmp.cleanup();
  }
});
