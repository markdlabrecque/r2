import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpsServer } from 'node:https';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashPassword } from '../src/password.ts';
import { startService, type RunningService } from '../src/service.ts';
import { FakeClock } from '../tests/helpers.ts';
import { createServerCleanup } from '../tests/server-cleanup.ts';

test('confirmed reminder survives restart and is submitted without a model', async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), 'r2-browser-'));
  let service: RunningService | undefined;
  let upstreamPort = 0;
  const clock = new FakeClock();
  const sends: string[] = [];
  const transport = { send: async (_subscription: unknown, id: string) => { sends.push(id); return { outcome: 'accepted' as const }; } };
  // TLS terminates locally, just as Serve terminates TLS in front of R2. No external service is contacted.
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'key'), '-out', join(dir, 'cert'), '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  const proxy = createHttpsServer({ key: readFileSync(join(dir, 'key')), cert: readFileSync(join(dir, 'cert')) }, (req, res) => {
    const upstream = httpRequest({ host: '127.0.0.1', port: upstreamPort, path: req.url, method: req.method, headers: req.headers }, (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(upstream);
  });
  const closeProxy = createServerCleanup(proxy);
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const port = (proxy.address() as { port: number }).port;
  const origin = `https://127.0.0.1:${port}`;
  const env = { R2_ORIGIN: origin, R2_DATA_DIR: join(dir, 'data'), R2_PORT: '0', R2_PASSWORD_HASH: await hashPassword('synthetic password', { ln: 10, r: 8, p: 1 }) };
  const model = { interpret: async () => ({ type: 'one_off' as const, text: 'Take out bins', localDateTime: '2026-10-15T19:00' }) };
  try {
    service = await startService(env, { clock, logger: false, adapters: { modelInterpreter: model, pushTransport: transport } });
    upstreamPort = service.port;
    // Synthetic subscription: this verifies submission, not browser push or notification display.
    service.storage.replaceSubscription({ endpoint: 'https://example.invalid/push', p256dh: 'synthetic', auth: 'synthetic' });
    await page.goto(origin);
    expect(await page.evaluate(async () => (await fetch('/api/reminders')).status)).toBe(401);
    await page.locator('#password').fill('synthetic password');
    await page.locator('#login button').click();
    await expect(page.locator('#owner')).toBeVisible();
    await page.locator('#timezone').fill('America/Toronto');
    await page.locator('#settings button').click();
    await expect(page.locator('#settings-status')).toContainText('Timezone saved');
    await page.locator('#message').fill('Remind me to take out bins tomorrow at 7pm');
    await page.locator('#send').click();
    await expect(page.locator('#proposal-when')).toContainText('2026-10-15 19:00 America/Toronto (UTC-04:00)');
    await expect(page.locator('#reminders')).toContainText('No reminders yet');
    await page.locator('#confirm').click();
    await expect(page.locator('#confirm-status')).toContainText('Saved');
    await expect(page.locator('#reminders')).toContainText('Take out bins');
    await service.stop();
    service = undefined;
    service = await startService(env, { clock, logger: false, adapters: { pushTransport: transport } });
    upstreamPort = service.port;
    await page.close();
    clock.t = Date.UTC(2026, 9, 15, 23, 0, 1);
    await expect.poll(() => sends.length, { timeout: 12_000 }).toBe(1);
    expect(sends[0]).not.toContain('bins');
    const newPage = await page.context().newPage();
    await newPage.goto(origin);
    await expect(newPage.locator('#service-state')).toContainText('assistant is not configured');
    await expect(newPage.locator('#reminders')).toContainText('due 2026-10-15 19:00 America/Toronto');
    await expect(newPage.locator('#reminders')).toContainText('last outcome: accepted');
    await newPage.locator('#logout').click();
    await expect(newPage.locator('#owner')).toBeHidden();
    await expect(newPage.locator('#reminders')).toBeEmpty();
  } finally {
    await test.step('stop service', async () => { await service?.stop(); });
    await test.step('close TLS proxy', async () => {
      await closeProxy();
    });
    rmSync(dir, { recursive: true, force: true });
  }
});
