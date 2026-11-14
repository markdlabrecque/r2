import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer as createHttpsServer, type Server } from 'node:https';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ModelInterpreter } from '../src/contracts.ts';
import { hashPassword } from '../src/password.ts';
import { startService, type RunningService } from '../src/service.ts';
import { FakeClock, syntheticEnv, tempDir } from '../tests/helpers.ts';

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
function tlsProxy(dir: string, target: () => number): Promise<Server> {
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
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('log in, set timezone, chat, confirm, restart: the reminder survives', async ({ page }) => {
  const tmp = tempDir();
  const model = new FakeModel();
  const clock = new FakeClock(); // 2026-10-14T12:00Z
  const hash = await hashPassword(PASSWORD, { ln: 10, r: 8, p: 1 });
  const dataDir = join(tmp.dir, 'data');
  let svc: RunningService | undefined;
  let port = 0;
  const proxy = await tlsProxy(tmp.dir, () => port);
  const origin = `https://localhost:${(proxy.address() as AddressInfo).port}`;
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

    await page.click('#confirm');
    await expect(page.locator('#confirm-status')).toContainText('Saved');
    await expect(page.locator('#reminders li')).toHaveCount(1);
    await expect(page.locator('#reminders')).toContainText('Take the bins out');

    // Restart on the same data: session and reminder persist; the model is not needed to list.
    await svc!.stop();
    await start();
    await page.reload();
    await expect(page.locator('#owner')).toBeVisible();
    await expect(page.locator('#reminders li')).toHaveCount(1);
    await expect(page.locator('#reminders')).toContainText('due 2026-10-15 19:00 America/Toronto');

    await page.click('#logout');
    await expect(page.locator('#login')).toBeVisible();
  } finally {
    await svc?.stop().catch(() => undefined);
    proxy.close();
    tmp.cleanup();
  }
});
