import { lookup as dnsLookup } from 'node:dns';
import { Agent } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { sendNotification, type RequestOptions } from 'web-push';
import { R2Error, type PushResult, type PushSubscriptionKeys, type PushTransport } from './contracts.ts';

/** Reminder id used for the owner's "send a test notification" button. */
export const TEST_PUSH_ID = 'test';
/** The push service may hold a reminder for a day if the browser is offline; a test only for a minute. */
export const REMINDER_PUSH_TTL_SECONDS = 24 * 60 * 60;
export const TEST_PUSH_TTL_SECONDS = 60;
/** Socket idle timeout, and the hard deadline for one whole send. A lease must outlast the deadline. */
export const PUSH_TIMEOUT_MS = 10_000;
export const PUSH_DEADLINE_MS = 15_000;

const MAX_ENDPOINT_LENGTH = 2048;
const REMINDER_ID = /^[A-Za-z0-9_-]{1,64}$/;

// ------------------------------------------------------------------------ endpoint rules

/**
 * Reviewed push-service hosts: Chrome/Edge-on-FCM, Firefox, Safari and Windows Notification
 * Service. An endpoint is data from the browser, so R2 only ever contacts these.
 */
const EXACT_HOSTS: readonly string[] = ['fcm.googleapis.com', 'web.push.apple.com'];
const HOST_SUFFIXES: readonly string[] = ['.push.services.mozilla.com', '.push.apple.com', '.notify.windows.com'];

export function isAllowedPushHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return EXACT_HOSTS.includes(host) || HOST_SUFFIXES.some((suffix) => host.endsWith(suffix) && host.length > suffix.length);
}

/** Parse and vet a subscription endpoint. Throws `invalid_request` without echoing the value. */
export function validatePushEndpoint(endpoint: string, allowHost: (hostname: string) => boolean = isAllowedPushHost): URL {
  const reject = (): never => {
    throw new R2Error('invalid_request', 'That browser push address is not one R2 can use.');
  };
  if (endpoint.length === 0 || endpoint.length > MAX_ENDPOINT_LENGTH) return reject();
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return reject();
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    url.hash !== '' ||
    isIP(url.hostname.replace(/^\[|\]$/g, '')) !== 0 ||
    !allowHost(url.hostname)
  ) {
    return reject();
  }
  return url;
}

function decodedLength(value: string, bytes: number, firstByte?: number): boolean {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return false;
  const raw = Buffer.from(value, 'base64url');
  return raw.length === bytes && (firstByte === undefined || raw[0] === firstByte);
}

/** The browser's P-256 public key (65 bytes) and auth secret (16 bytes), base64url. */
export function validateSubscriptionKeys(p256dh: string, auth: string): boolean {
  return decodedLength(p256dh, 65, 0x04) && decodedLength(auth, 16);
}

// ------------------------------------------------------------------- address restrictions

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // Tailscale and carrier-grade NAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6');
}

/** True for loopback, private, link-local, tailnet, multicast and malformed addresses. */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  return family === 0 || blocked.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/** DNS lookup that refuses to hand back any address R2 must not connect to. */
export const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, '', 4);
    const allowed = addresses.filter((a) => !isBlockedAddress(a.address));
    const first = allowed[0];
    if (first === undefined) {
      return callback(Object.assign(new Error('Push address is not allowed.'), { code: 'EBLOCKED' }), '', 4);
    }
    if (options.all) return callback(null, allowed);
    return callback(null, first.address, first.family);
  });
};

// ------------------------------------------------------------------------------ transport

export interface SendFunction {
  (
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
    payload: string,
    options: RequestOptions,
  ): Promise<{ statusCode: number }>;
}

export interface WebPushTransportOptions {
  vapid: { subject: string; publicKey: string; privateKey: string };
  /** Tests inject a fake; production uses the web-push library. */
  send?: SendFunction;
  allowHost?: (hostname: string) => boolean;
  agent?: Agent;
  timeoutMs?: number;
  deadlineMs?: number;
}

function statusOf(error: unknown): number | undefined {
  const status = typeof error === 'object' && error !== null ? (error as { statusCode?: unknown }).statusCode : undefined;
  return typeof status === 'number' ? status : undefined;
}

/** Map a provider HTTP status to R2's outcome. Redirects are never followed. */
export function classifyStatus(status: number): PushResult {
  if (status >= 200 && status < 300) return { outcome: 'accepted', httpStatus: status };
  if (status === 404 || status === 410) return { outcome: 'failed', retryable: false, code: 'subscription_gone', httpStatus: status };
  if (status === 429 || status === 408 || status >= 500) {
    return { outcome: 'failed', retryable: true, code: 'temporary', httpStatus: status };
  }
  return { outcome: 'failed', retryable: false, code: 'rejected', httpStatus: status };
}

/**
 * Sends the one generic Web Push message. The encrypted payload carries only the opaque
 * reminder id; the service worker supplies the fixed notification text. No result or log
 * line from here contains the endpoint, keys or any reminder content.
 */
export class WebPushTransport implements PushTransport {
  readonly #vapid: WebPushTransportOptions['vapid'];
  readonly #send: SendFunction;
  readonly #allowHost: (hostname: string) => boolean;
  readonly #agent: Agent;
  readonly #timeoutMs: number;
  readonly #deadlineMs: number;

  constructor(options: WebPushTransportOptions) {
    this.#vapid = options.vapid;
    this.#send = options.send ?? ((subscription, payload, requestOptions) => sendNotification(subscription, payload, requestOptions));
    this.#allowHost = options.allowHost ?? isAllowedPushHost;
    this.#agent = options.agent ?? new Agent({ lookup: guardedLookup, maxSockets: 4 });
    this.#timeoutMs = options.timeoutMs ?? PUSH_TIMEOUT_MS;
    this.#deadlineMs = options.deadlineMs ?? PUSH_DEADLINE_MS;
  }

  async send(subscription: PushSubscriptionKeys, reminderId: string): Promise<PushResult> {
    const rejected: PushResult = { outcome: 'failed', retryable: false, code: 'rejected' };
    if (!REMINDER_ID.test(reminderId)) return rejected;
    try {
      validatePushEndpoint(subscription.endpoint, this.#allowHost);
    } catch {
      return rejected;
    }
    if (!validateSubscriptionKeys(subscription.p256dh, subscription.auth)) return rejected;

    const isTest = reminderId === TEST_PUSH_ID;
    const options: RequestOptions = {
      vapidDetails: this.#vapid,
      TTL: isTest ? TEST_PUSH_TTL_SECONDS : REMINDER_PUSH_TTL_SECONDS,
      urgency: 'high',
      timeout: this.#timeoutMs,
      agent: this.#agent,
      contentEncoding: 'aes128gcm',
      // Lets the push service collapse a repeat of the same reminder. Topic is limited to 32 chars.
      ...(reminderId.length <= 32 ? { topic: reminderId } : {}),
    };
    const payload = JSON.stringify({ reminderId });

    let timer: NodeJS.Timeout | undefined;
    try {
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Push deadline exceeded.')), this.#deadlineMs);
        timer.unref();
      });
      const response = await Promise.race([
        this.#send({ endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } }, payload, options),
        deadline,
      ]);
      return classifyStatus(response.statusCode);
    } catch (error) {
      const status = statusOf(error);
      if (status !== undefined) return classifyStatus(status);
      // Connection errors, timeouts and blocked addresses: nothing says the push was delivered.
      return { outcome: 'failed', retryable: true, code: 'network' };
    } finally {
      clearTimeout(timer);
    }
  }
}
