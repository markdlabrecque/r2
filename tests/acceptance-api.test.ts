import { expect, it } from 'vitest';
import { AcceptanceApi, validateOrigin } from '../scripts/acceptance/api.ts';
import { caseSchema } from '../scripts/acceptance/contracts.ts';
import { syntheticCase } from './acceptance-fixtures.ts';

it('accepts only a single HTTPS origin', () => {
  expect(validateOrigin('https://example.test:444/')).toBe('https://example.test:444');
  for (const value of ['http://example.test', 'https://user:pass@example.test', 'https://example.test/path', 'https://example.test/?', 'https://example.test/#', 'https://example.test/a/..', 'not a url']) expect(() => validateOrigin(value)).toThrow('invalid-origin');
});
it('keeps the secure session in memory, sets origin on writes and disables redirects', async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const fetcher: typeof fetch = async (url, init) => { seen.push({ url: String(url), init: init! });
    if (String(url).endsWith('/api/session') && init?.method === 'POST') return Response.json({ authenticated: true }, { headers: { 'set-cookie': '__Host-r2_session=CanaryToken; Max-Age=3600; Path=/; HttpOnly; Secure; SameSite=Strict' } });
    if (init?.method === 'DELETE') return Response.json({ authenticated: false });
    return Response.json({ timezone: 'UTC', notificationsPaused: false });
  };
  const api = new AcceptanceApi('https://example.test', { fetch: fetcher }); await api.login('PasswordCanary'); await api.settings(); await api.logout();
  expect(seen.map(x => x.init.redirect)).toEqual(['manual','manual','manual']);
  expect((seen[0]!.init.headers as Record<string,string>).origin).toBe('https://example.test');
  expect((seen[0]!.init.headers as Record<string,string>).cookie).toBeUndefined();
  expect((seen[1]!.init.headers as Record<string,string>).cookie).toBe('__Host-r2_session=CanaryToken');
  expect(JSON.stringify(api)).not.toMatch(/Canary|example/);
  expect((seen[2]!.init.headers as Record<string,string>).origin).toBe('https://example.test');
});
it('rejects insecure cookies, redirects, oversized bodies, timeouts and raw errors safely', async () => {
  const insecure = new AcceptanceApi('https://example.test', { fetch: async () => Response.json({ authenticated: true }, { headers: { 'set-cookie': '__Host-r2_session=secret; Path=/' } }) });
  await expect(insecure.login('password')).rejects.toMatchObject({ code: 'invalid-response' });
  const redirect = new AcceptanceApi('https://example.test', { fetch: async () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.test' } }) });
  await expect(redirect.settings()).rejects.toMatchObject({ code: 'redirect' });
  const large = new AcceptanceApi('https://example.test', { maxBytes: 5, fetch: async () => new Response('secret payload') });
  await expect(large.settings()).rejects.toMatchObject({ code: 'response-too-large' });
  const slow = new AcceptanceApi('https://example.test', { timeoutMs: 10, fetch: async () => new Promise(() => {}) });
  await expect(slow.settings()).rejects.toMatchObject({ code: 'timeout' });
  const broken = new AcceptanceApi('https://example.test', { fetch: async () => { throw new Error('password-cookie-canary'); } });
  try { await broken.settings(); expect.fail(); } catch (e) { expect(String(e)).not.toContain('canary'); expect(e).toMatchObject({ code: 'network' }); }
});
it('maps typed failures without exposing server messages or payloads', async () => {
  for (const [serverCode, code] of [['unavailable','unavailable'], ['quota_exceeded','quota-exceeded'], ['proposal_expired','expired'], ['forbidden','forbidden'], ['unauthorized','unauthorized'], ['request_id_conflict','conflict']] as const) {
    const api = new AcceptanceApi('https://example.test', { fetch: async () => Response.json({ error: { code: serverCode, message: 'private-canary' } }, { status: 400 }) });
    try { await api.settings(); expect.fail(); } catch (error) { expect(error).toMatchObject({ code }); expect(String(error)).not.toContain('private-canary'); }
  }
  const malformed = new AcceptanceApi('https://example.test', { fetch: async () => Response.json({ timezone: 'secret-canary', notificationsPaused: false }) });
  await expect(malformed.settings()).rejects.toMatchObject({ code: 'invalid-response' });
});
it('accepts only actual bounded app IDs in persisted cases', () => {
  const c = syntheticCase();
  expect(caseSchema.safeParse({ ...c, proposalId: 'prp_abcdefghijklmnopqrstuv', reminderId: 'rem_abcdefghijklmnopqrstuv' }).success).toBe(true);
  for (const value of ['prp_secret', 'prp_abcdefghijklmnopqrstuv!', 'rem_abcdefghijklmnopqrstuv', '../secret']) expect(caseSchema.safeParse({ ...c, proposalId: value }).success).toBe(false);
  expect(caseSchema.safeParse({ ...c, proposalId: 'prp_abcdefghijklmnopqrstuv', reminderId: 'rem_secret' }).success).toBe(false);
});
