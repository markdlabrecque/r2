import { z } from 'zod';
import { proposalIdSchema, reminderIdSchema } from './contracts.ts';
import { isValidTimezone } from '../../src/contracts.ts';

export type ApiCode = 'invalid-origin' | 'network' | 'timeout' | 'response-too-large' | 'redirect' | 'invalid-response' | 'unauthorized' | 'forbidden' | 'unavailable' | 'quota-exceeded' | 'conflict' | 'expired' | 'http-error';
export class ApiError extends Error {
  readonly code: ApiCode;
  constructor(code: ApiCode) { super(`Acceptance API: ${code}`); this.name = 'ApiError'; this.code = code; }
}
export function validateOrigin(value: string): string {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password || u.pathname !== '/' || u.search || u.hash || /[?#]/.test(value) || !/^https:\/\/[^/]+\/?$/i.test(value)) throw 0;
    return u.origin;
  } catch { throw new ApiError('invalid-origin'); }
}
const instant = z.string().refine(v => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v)));
const zone = z.string().refine(isValidTimezone);
const local = z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d$/);
const proposal = z.object({ id: proposalIdSchema, text: z.string().max(500), dueAt: instant, timezone: zone, localDateTime: local, createdAt: instant, expiresAt: instant, confirmedReminderId: reminderIdSchema.nullable() });
const attempt = z.object({ attemptNumber: z.number().int().positive(), subscriptionVersion: z.number().int().positive(), startedAt: instant, finishedAt: instant.nullable(), outcome: z.enum(['started', 'accepted', 'failed', 'unknown']) });
const reminder = z.object({ id: reminderIdSchema, proposalId: proposalIdSchema, text: z.string().max(500), dueAt: instant, timezone: zone, localDateTime: local, state: z.enum(['scheduled', 'sending', 'retry', 'accepted', 'failed']), attempts: z.number().int().nonnegative(), acceptedAt: instant.nullable() });
export type Proposal = z.infer<typeof proposal>;
export type Reminder = z.infer<typeof reminder>;
export type ListedReminder = Reminder & { deliveryAttempts: z.infer<typeof attempt>[] };
const settings = z.object({ timezone: zone.nullable(), notificationsPaused: z.boolean() });
const push = z.object({ subscription: z.object({ connected: z.boolean(), ready: z.boolean(), version: z.number().int().positive().nullable() }) });
const status = z.object({ now: instant, notifications: z.object({ paused: z.boolean(), pausedByConfig: z.boolean(), pushConfigured: z.boolean(), browserConnected: z.boolean(), browserReady: z.boolean() }), assistantConfigured: z.boolean() });
const chat = z.discriminatedUnion('type', [z.object({ type: z.literal('clarify'), message: z.string() }), z.object({ type: z.literal('unsupported'), message: z.string() }), z.object({ type: z.literal('proposal'), message: z.string(), proposal, utcOffset: z.string().regex(/^[+-]\d\d:\d\d$/) })]);
export interface ApiOptions { fetch?: typeof fetch; timeoutMs?: number; maxBytes?: number }
/** Credentials and raw responses never leave this instance except for the narrowly typed DTOs. */
export class AcceptanceApi {
  readonly #origin: string; readonly #fetch: typeof fetch; readonly #timeout: number; readonly #max: number;
  #cookie: string | null = null;
  constructor(origin: string, options: ApiOptions = {}) {
    this.#origin = validateOrigin(origin); this.#fetch = options.fetch ?? fetch;
    this.#timeout = options.timeoutMs ?? 10_000; this.#max = options.maxBytes ?? 256 * 1024;
    if (!Number.isInteger(this.#timeout) || this.#timeout < 1 || this.#timeout > 120_000 || !Number.isInteger(this.#max) || this.#max < 1 || this.#max > 1024 * 1024) throw new ApiError('invalid-response');
  }
  async #request<T>(method: string, path: string, schema: z.ZodType<T>, body?: unknown, mode: 'owner' | 'anonymous' | 'bad-origin' = 'owner'): Promise<{ value: T; response: Response }> {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new ApiError('timeout')); }, this.#timeout); });
    const work = async () => {
      const headers: Record<string, string> = {};
      if (method !== 'GET') headers.origin = mode === 'bad-origin' ? 'https://invalid-origin.example' : this.#origin;
      if (body !== undefined) headers['content-type'] = 'application/json';
      if (mode !== 'anonymous' && this.#cookie) headers.cookie = this.#cookie;
      let response: Response;
      try { response = await this.#fetch(`${this.#origin}${path}`, { method, headers, redirect: 'manual', signal: controller.signal, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }
      catch { throw new ApiError('network'); }
      if (response.status >= 300 && response.status < 400) throw new ApiError('redirect');
      let bytes = 0; const chunks: Uint8Array[] = [];
      if (response.body) {
        const reader = response.body.getReader();
        try { while (true) { const item = await reader.read(); if (item.done) break; bytes += item.value.byteLength; if (bytes > this.#max) { controller.abort(); throw new ApiError('response-too-large'); } chunks.push(item.value); } }
        catch (e) { if (e instanceof ApiError) throw e; throw new ApiError('network'); }
        finally { reader.releaseLock(); }
      }
      let data: unknown;
      try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ApiError('invalid-response'); }
      if (!response.ok) {
        const error = z.object({ error: z.object({ code: z.string() }) }).safeParse(data);
        const code = error.success ? error.data.error.code : '';
        throw new ApiError(code === 'unauthorized' ? 'unauthorized' : code === 'forbidden' ? 'forbidden' : code === 'unavailable' ? 'unavailable' : code === 'quota_exceeded' ? 'quota-exceeded' : code === 'proposal_expired' ? 'expired' : ['conflict', 'request_id_conflict', 'proposal_not_found'].includes(code) ? 'conflict' : 'http-error');
      }
      const parsed = schema.safeParse(data); if (!parsed.success) throw new ApiError('invalid-response');
      return { value: parsed.data, response };
    };
    try { return await Promise.race([work(), timeout]); } finally { if (timer) clearTimeout(timer); }
  }
  async login(password: string): Promise<void> {
    this.#cookie = null;
    const { response } = await this.#request('POST', '/api/session', z.object({ authenticated: z.literal(true) }), { password }, 'anonymous');
    const values = response.headers.getSetCookie();
    const cookies = values.filter(v => /^__Host-r2_session=/.test(v));
    if (cookies.length !== 1) throw new ApiError('invalid-response');
    const parts = cookies[0]!.split(';').map(v => v.trim());
    const match = /^__Host-r2_session=([A-Za-z0-9_-]{1,128})$/.exec(parts[0]!);
    const attrs = parts.slice(1).map(v => v.toLowerCase());
    if (!match || !attrs.includes('secure') || !attrs.includes('httponly') || !attrs.includes('path=/') || !attrs.includes('samesite=strict') || attrs.some(v => v.startsWith('domain='))) throw new ApiError('invalid-response');
    this.#cookie = `__Host-r2_session=${match[1]}`;
  }
  async logout(): Promise<void> { try { await this.#request('DELETE', '/api/session', z.object({ authenticated: z.literal(false) })); } finally { this.#cookie = null; } }
  async settings() { return (await this.#request('GET', '/api/settings', settings)).value; }
  async status() { return (await this.#request('GET', '/api/status', status)).value; }
  async push() { return (await this.#request('GET', '/api/push', push)).value; }
  async chat(message: string) {
    const result = (await this.#request('POST', '/api/chat', chat, { message })).value;
    return result.type === 'proposal' ? { type: result.type, proposal: result.proposal, utcOffset: result.utcOffset } : { type: result.type };
  }
  async confirm(proposalId: string, requestId: string) { return (await this.#request('POST', '/api/reminders/confirm', z.object({ reminder }), { proposalId, requestId })).value.reminder; }
  async reminders(): Promise<ListedReminder[]> { return (await this.#request('GET', '/api/reminders', z.object({ reminders: z.array(reminder.extend({ deliveryAttempts: z.array(attempt).max(100) })).max(1000) }))).value.reminders; }
  async pause(paused: boolean) { return (await this.#request('PUT', '/api/notifications/pause', status, { paused })).value; }
  /** Anonymous and invalid-origin probes never alter the session. The latter deliberately includes it. */
  async probe(kind: 'anonymous' | 'bad-origin'): Promise<'unauthorized' | 'forbidden' | 'unexpected'> {
    if (kind === 'bad-origin') { if (!this.#cookie) throw new ApiError('unauthorized'); await this.settings(); }
    try { await this.#request(kind === 'anonymous' ? 'GET' : 'POST', kind === 'anonymous' ? '/api/settings' : '/api/session', z.unknown(), kind === 'anonymous' ? undefined : {}, kind); return 'unexpected'; }
    catch (e) { if (e instanceof ApiError && (e.code === 'unauthorized' || e.code === 'forbidden')) return e.code; throw e; }
  }
}
