import https, { request, type Agent, type RequestOptions } from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createECDH } from 'node:crypto';
import { generateVAPIDKeys } from 'web-push';
import type { LookupAddress, LookupAllOptions } from 'node:dns';
import type { LookupFunction } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { guardedLookup, WebPushTransport } from '../src/push.ts';

const { resolver } = vi.hoisted(() => ({ resolver: vi.fn() }));
vi.mock('node:dns', () => ({ lookup: resolver }));
afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks(); });

const HOST = 'updates.push.services.mozilla.com';
const privateAnswers: LookupAddress[] = [
  { address: '127.0.0.1', family: 4 },
  { address: '100.100.1.1', family: 4 },
  { address: 'fd00::1', family: 6 },
];

function answers(addresses: LookupAddress[], error: NodeJS.ErrnoException | null = null) {
  resolver.mockImplementation((_host: string, _options: LookupAllOptions, callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void) => callback(error, addresses));
}

function lookup(all: boolean) {
  return new Promise<{ error: NodeJS.ErrnoException | null; address: string | LookupAddress[]; family?: number }>((resolve) => {
    guardedLookup(HOST, { all }, (error, address, family) => resolve({ error, address, family }));
  });
}

describe('guarded DNS boundary', () => {
  it('rejects private-only and empty answers, and preserves resolver errors', async () => {
    for (const addresses of [privateAnswers, []]) {
      answers(addresses);
      for (const all of [false, true]) expect((await lookup(all)).error?.code).toBe('EBLOCKED');
    }
    const error = Object.assign(new Error('Synthetic DNS failure'), { code: 'EAI_AGAIN' });
    answers([], error);
    for (const all of [false, true]) expect((await lookup(all)).error).toBe(error);
  });

  it('returns only allowed answers in all-mode and the first allowed answer in single-mode', async () => {
    const publicAnswers = [{ address: '8.8.8.8', family: 4 }, { address: '2607:f8b0:4005::1', family: 6 }];
    answers([privateAnswers[0]!, publicAnswers[0]!, ...privateAnswers.slice(1), publicAnswers[1]!]);
    expect(await lookup(true)).toEqual({ error: null, address: publicAnswers, family: undefined });
    expect(await lookup(false)).toEqual({ error: null, address: '8.8.8.8', family: 4 });
    expect(resolver).toHaveBeenCalledWith(HOST, { all: true }, expect.any(Function));
  });

  it('does not follow a provider redirect to a private address', async () => {
    // Exercise the real web-push adapter, replacing only its HTTPS request boundary.
    // No TLS bypass, local certificate authority, or push encryption implementation.
    const requests: string[] = [];
    vi.spyOn(https, 'request').mockImplementation((options, callback) => {
      requests.push((options as RequestOptions).hostname!);
      const req = new EventEmitter() as EventEmitter & { write: () => void; end: () => void; setTimeout: () => void };
      req.write = () => {};
      req.setTimeout = () => {};
      req.end = () => {
        const response = new PassThrough() as PassThrough & { statusCode: number; headers: object };
        response.statusCode = 302;
        response.headers = { location: 'https://127.0.0.1/private' };
        (callback as (response: IncomingMessage) => void)(response as unknown as IncomingMessage);
        response.end();
      };
      return req as unknown as ClientRequest;
    });
    const browserKey = createECDH('prime256v1');
    browserKey.generateKeys();
    const transport = new WebPushTransport({ vapid: { subject: 'mailto:owner@example.com', ...generateVAPIDKeys() } });
    expect(await transport.send({
      endpoint: `https://${HOST}/synthetic-token`,
      p256dh: browserKey.getPublicKey().toString('base64url'),
      auth: Buffer.alloc(16, 9).toString('base64url'),
    }, 'rem_redirect')).toEqual({ outcome: 'failed', retryable: false, code: 'rejected', httpStatus: 302 });
    expect(requests).toEqual([HOST]);
  });

  it('the default transport agent rejects private DNS during a real HTTPS connection attempt', async () => {
    answers(privateAnswers);
    let connectionError: NodeJS.ErrnoException | undefined;
    let agent: Agent | undefined;
    const transport = new WebPushTransport({
      vapid: { subject: 'mailto:owner@example.com', publicKey: 'unused', privateKey: 'unused' },
      send: async (subscription, _payload, options) => {
        agent = options.agent as Agent;
        // Fail closed before issuing a request if the attachment is removed. No real DNS fallback.
        expect(agent.options.lookup).toBe(guardedLookup);
        const attached = agent.options.lookup as LookupFunction;
        // Even a broken filter must never hand a synthetic address to TCP.
        agent.options.lookup = (hostname, lookupOptions, callback) => attached(hostname, lookupOptions, (error) => {
          callback(error ?? Object.assign(new Error('Unsafe DNS answer escaped filtering'), { code: 'EUNSAFE' }), '', 4);
        });
        return new Promise((resolve, reject) => {
          const req = request(subscription.endpoint, { agent }, (response) => {
            response.resume();
            resolve({ statusCode: response.statusCode! });
          });
          req.on('error', (error: NodeJS.ErrnoException) => { connectionError = error; reject(error); });
          req.end();
        });
      },
    });
    try {
      const result = await transport.send({
        endpoint: `https://${HOST}/synthetic-token`,
        p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString('base64url'),
        auth: Buffer.alloc(16, 9).toString('base64url'),
      }, 'rem_dns');
      expect(connectionError?.code).toBe('EBLOCKED');
      expect(resolver).toHaveBeenCalledWith(HOST, expect.objectContaining({ all: true }), expect.any(Function));
      expect(result).toEqual({ outcome: 'failed', retryable: true, code: 'network' });
    } finally {
      agent?.destroy();
    }
  });
});
