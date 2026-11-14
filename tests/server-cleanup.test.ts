import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { connect, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { connect as connectTls } from 'node:tls';
import { expect, it } from 'vitest';
import { tempDir } from './helpers.ts';
import { createServerCleanup } from './server-cleanup.ts';

it.each(['TCP', 'TLS'])('closes an HTTPS fixture with an idle %s peer that never sends HTTP', async (peer) => {
  const tmp = tempDir();
  const key = join(tmp.dir, 'key');
  const cert = join(tmp.dir, 'cert');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  const server = createServer({ key: readFileSync(key), cert: readFileSync(cert) });
  const cleanup = createServerCleanup(server);
  let requests = 0;
  server.on('request', () => { requests++; });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  const connected = once(server, peer === 'TCP' ? 'connection' : 'secureConnection');
  const client = peer === 'TCP'
    ? connect(port, '127.0.0.1')
    : connectTls({ port, host: '127.0.0.1', rejectUnauthorized: false });
  await connected;
  // Browser preconnections can stop before or after TLS, without sending HTTP.
  const closed = cleanup();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      closed,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('HTTPS fixture cleanup waited for the clients')), 1_000);
      }),
    ]);
    expect(requests).toBe(0);
    expect(server.listening).toBe(false);
  } finally {
    clearTimeout(timer);
    client.destroy();
    await closed;
    tmp.cleanup();
  }
});
