import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.ts';
import { tempDir } from './helpers.ts';

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));
const tmp = (): string => {
  const t = tempDir();
  cleanups.push(t.cleanup);
  return t.dir;
};

const b64 = (n: number, first?: number, fill = 7): string => {
  const buf = Buffer.alloc(n, fill);
  if (first !== undefined) buf[0] = first;
  return buf.toString('base64url');
};
const HASH = '$scrypt$ln=15,r=8,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNo';

const base = (dir: string, extra: NodeJS.ProcessEnv = {}) => ({
  R2_ORIGIN: 'https://r2.example.ts.net',
  R2_DATA_DIR: join(dir, 'data'),
  ...extra,
});
const checkout = (): string => {
  const d = join(tmp(), 'checkout');
  mkdirSync(d);
  return d;
};
const failure = (fn: () => unknown): ConfigError => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return e as ConfigError;
  }
  throw new Error('expected a ConfigError');
};

describe('R2_ORIGIN', () => {
  it('is required and must be a single https origin', () => {
    const dir = tmp();
    expect(() => loadConfig({ R2_DATA_DIR: join(dir, 'd') })).toThrow(/R2_ORIGIN is required/);
    for (const bad of [
      'http://r2.example.ts.net',
      'r2.example.ts.net',
      'https://r2.example.ts.net/',
      'https://r2.example.ts.net/path',
      'https://r2.example.ts.net:443',
      'https://user:pw@r2.example.ts.net',
      'https://r2.example.ts.net?x=1',
      'ftp://r2.example.ts.net',
    ]) {
      expect(() => loadConfig(base(dir, { R2_ORIGIN: bad })), bad).toThrow(ConfigError);
    }
    expect(loadConfig(base(dir, { R2_ORIGIN: 'https://r2.example.ts.net:8443' })).origin).toBe('https://r2.example.ts.net:8443');
  });
});

describe('R2_DATA_DIR', () => {
  it('is required, absolute, and not working-directory dependent', () => {
    const dir = tmp();
    expect(() => loadConfig({ R2_ORIGIN: 'https://r2.example.ts.net' })).toThrow(/R2_DATA_DIR is required/);
    expect(() => loadConfig(base(dir, { R2_DATA_DIR: 'data' }))).toThrow(/absolute/);
    expect(() => loadConfig(base(dir, { R2_DATA_DIR: `${dir}/a/../b` }))).toThrow(/absolute/);
    const c = loadConfig(base(dir));
    expect(c.dbPath).toBe(join(c.dataDir, 'r2.sqlite'));
  });

  it('rejects paths inside the checkout, including via symlinked ancestors and not-yet-existing paths', () => {
    const root = checkout();
    const outside = tmp();
    const opts = { checkoutRoot: root };
    expect(() => loadConfig({ R2_ORIGIN: 'https://x.example', R2_DATA_DIR: join(root, 'data') }, opts)).toThrow(/outside the R2 checkout/);
    expect(() => loadConfig({ R2_ORIGIN: 'https://x.example', R2_DATA_DIR: root }, opts)).toThrow(/outside/);
    mkdirSync(join(root, 'inner'));
    symlinkSync(join(root, 'inner'), join(outside, 'link'));
    expect(() => loadConfig({ R2_ORIGIN: 'https://x.example', R2_DATA_DIR: join(outside, 'link', 'deep', 'er') }, opts)).toThrow(/outside/);
    // A dangling symlink pointing into the checkout is still inside.
    symlinkSync(join(root, 'not-yet'), join(outside, 'dangling'));
    expect(() => loadConfig({ R2_ORIGIN: 'https://x.example', R2_DATA_DIR: join(outside, 'dangling') }, opts)).toThrow(/outside/);
    // A symlinked checkout root cannot disguise itself either.
    symlinkSync(root, join(outside, 'rootlink'));
    expect(() => loadConfig({ R2_ORIGIN: 'https://x.example', R2_DATA_DIR: join(outside, 'rootlink', 'data') }, opts)).toThrow(/outside/);
    expect(() => loadConfig({ R2_ORIGIN: 'https://x.example', R2_DATA_DIR: join(outside, 'ok') }, opts)).not.toThrow();
  });

  it('rejects the real checkout by default', () => {
    expect(() => loadConfig({ R2_ORIGIN: 'https://x.example', R2_DATA_DIR: join(process.cwd(), 'data') })).toThrow(/outside/);
  });
});

describe('listener and numeric settings', () => {
  it('defaults to 127.0.0.1:3000, 168h sessions, notifications not paused', () => {
    const c = loadConfig(base(tmp()));
    expect(c).toMatchObject({ host: '127.0.0.1', port: 3000, sessionTtlHours: 168, pauseNotifications: false });
  });
  it('has no configurable host', () => {
    expect(loadConfig(base(tmp(), { R2_HOST: '0.0.0.0' })).host).toBe('127.0.0.1');
  });
  it('validates R2_PORT, R2_SESSION_TTL_HOURS and R2_PAUSE_NOTIFICATIONS', () => {
    const dir = tmp();
    expect(loadConfig(base(dir, { R2_PORT: '8080', R2_SESSION_TTL_HOURS: '24', R2_PAUSE_NOTIFICATIONS: 'true' }))).toMatchObject({
      port: 8080,
      sessionTtlHours: 24,
      pauseNotifications: true,
    });
    for (const env of [{ R2_PORT: 'abc' }, { R2_PORT: '70000' }, { R2_PORT: '-1' }, { R2_SESSION_TTL_HOURS: '0' }, { R2_SESSION_TTL_HOURS: 'x' }, { R2_PAUSE_NOTIFICATIONS: 'maybe' }]) {
      expect(() => loadConfig(base(dir, env))).toThrow(ConfigError);
    }
  });
});

describe('optional auth, push and chat configuration', () => {
  it('starts with nothing configured: auth, push and chat are disabled, not errors', () => {
    const c = loadConfig(base(tmp()));
    expect(c.auth).toEqual({ enabled: false, reason: 'not_configured' });
    expect(c.push).toEqual({ enabled: false, reason: 'not_configured' });
    expect(c.chat).toEqual({ enabled: false, reason: 'not_configured' });
  });

  it('accepts a valid password hash and hides it from inspection', () => {
    const c = loadConfig(base(tmp(), { R2_PASSWORD_HASH: HASH }));
    expect(c.auth.enabled).toBe(true);
    expect(JSON.stringify(c)).not.toContain('aGFzaGhhc2hoYXNo');
    expect(String(c.auth.enabled && c.auth.passwordHash)).toBe('[redacted]');
  });

  it('rejects a malformed password hash without echoing it', () => {
    const e = failure(() => loadConfig(base(tmp(), { R2_PASSWORD_HASH: 'plain-text-password-123' })));
    expect(e.message).toContain('R2_PASSWORD_HASH');
    expect(e.message).not.toContain('plain-text-password-123');
  });

  it('reads VAPID values; partial values mean not ready, malformed values fail safely', () => {
    const dir = tmp();
    const full = { VAPID_PUBLIC_KEY: b64(65, 4), VAPID_PRIVATE_KEY: b64(32, undefined, 9), VAPID_SUBJECT: 'mailto:owner@example.com' };
    const c = loadConfig(base(dir, full));
    expect(c.push.enabled).toBe(true);
    expect(JSON.stringify(c)).not.toContain(full.VAPID_PRIVATE_KEY);
    expect(loadConfig(base(dir, { VAPID_SUBJECT: 'https://example.com/me' })).push).toEqual({ enabled: false, reason: 'incomplete' });
    const e = failure(() => loadConfig(base(dir, { ...full, VAPID_PRIVATE_KEY: 'not-a-real-private-key!!' })));
    expect(e.message).not.toContain('not-a-real-private-key');
    expect(() => loadConfig(base(dir, { ...full, VAPID_PUBLIC_KEY: b64(65, 5) }))).toThrow(ConfigError);
    expect(() => loadConfig(base(dir, { ...full, VAPID_SUBJECT: 'ftp://x' }))).toThrow(ConfigError);
  });

  it('enables chat only with OPENAI_API_KEY and OPENAI_MODEL; never blocks startup', () => {
    const dir = tmp();
    const key = 'sk-synthetic-not-real-key';
    expect(loadConfig(base(dir, { OPENAI_API_KEY: key })).chat).toEqual({ enabled: false, reason: 'model_missing' });
    expect(loadConfig(base(dir, { OPENAI_MODEL: 'gpt-x' })).chat).toEqual({ enabled: false, reason: 'api_key_missing' });
    expect(loadConfig(base(dir, { R2_OPENAI_MODEL: 'gpt-x', OPENAI_API_KEY: key })).chat.enabled).toBe(false);
    expect(loadConfig(base(dir, { OPENAI_API_KEY: 'short', OPENAI_MODEL: 'gpt-x' })).chat).toEqual({ enabled: false, reason: 'invalid' });
    const on = loadConfig(base(dir, { OPENAI_API_KEY: key, OPENAI_MODEL: 'gpt-x' }));
    expect(on.chat.enabled && on.chat.model).toBe('gpt-x');
    expect(JSON.stringify(on)).not.toContain(key);
  });
});
