import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { inspect } from 'node:util';
import { findPackageRoot } from './paths.ts';

/**
 * Error messages name the variable and the rule. They never include a value, so a
 * malformed secret cannot reach a terminal or log through a configuration error.
 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Holds a secret so that logging, JSON and inspection of the config show `[redacted]`. */
export class Secret {
  readonly #value: string;
  constructor(value: string) {
    this.#value = value;
  }
  reveal(): string {
    return this.#value;
  }
  toJSON(): string {
    return '[redacted]';
  }
  toString(): string {
    return '[redacted]';
  }
  [inspect.custom](): string {
    return '[redacted]';
  }
}

export type AuthConfig = { enabled: true; passwordHash: Secret } | { enabled: false; reason: 'not_configured' };

export type PushConfig =
  | { enabled: true; publicKey: string; privateKey: Secret; subject: string }
  | { enabled: false; reason: 'not_configured' | 'incomplete' };

export type ChatConfig =
  | { enabled: true; apiKey: Secret; model: string }
  | { enabled: false; reason: 'not_configured' | 'api_key_missing' | 'model_missing' | 'invalid' };

export interface Config {
  /** Always loopback: Tailscale Serve terminates HTTPS in front of R2. Not configurable. */
  readonly host: '127.0.0.1';
  readonly port: number;
  /** Single https origin the owner uses to reach R2, e.g. `https://r2.tailnet.ts.net`. */
  readonly origin: string;
  /** Absolute real path, outside the checkout. */
  readonly dataDir: string;
  readonly dbPath: string;
  readonly sessionTtlHours: number;
  readonly pauseNotifications: boolean;
  /** Disabled until `R2_PASSWORD_HASH` is set; later auth plugins read this. */
  readonly auth: AuthConfig;
  /** Disabled until all three VAPID values are set; later push plugins read this. */
  readonly push: PushConfig;
  /** Never blocks startup: saved reminders stay deliverable without a model. */
  readonly chat: ChatConfig;
}

export interface ConfigOptions {
  /** The installation directory. Defaults to the directory holding this build's package.json. */
  checkoutRoot?: string;
}

const MAX_SESSION_TTL_HOURS = 24 * 365;

/** Value of an environment variable, or undefined when unset or empty. */
function read(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

function parseOrigin(value: string | undefined): string {
  if (value === undefined) throw new ConfigError('R2_ORIGIN is required: the https origin of the private site.');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError('R2_ORIGIN must be a single https origin such as https://r2.example.ts.net.');
  }
  if (url.protocol !== 'https:' || url.origin !== value || url.hostname === '') {
    throw new ConfigError(
      'R2_ORIGIN must be a single https origin such as https://r2.example.ts.net: no http, path, query, credentials or default port.',
    );
  }
  return url.origin;
}

/** Resolve through symbolic links, including for a path that does not exist yet. */
export function resolveRealPath(input: string, depth = 0): string {
  if (depth > 32) throw new ConfigError('A path in the configuration has too many symbolic links.');
  const tail: string[] = [];
  let current = resolve(input);
  for (;;) {
    try {
      const real = realpathSync(current);
      return tail.length === 0 ? real : join(real, ...tail.reverse());
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw new ConfigError('A path in the configuration cannot be resolved.');
      }
      // A dangling symlink still points somewhere: follow it rather than treat it as absent.
      let target: string | undefined;
      try {
        if (lstatSync(current).isSymbolicLink()) target = resolve(dirname(current), readlinkSync(current));
      } catch {
        // not a symlink or not readable; fall through to the parent
      }
      if (target !== undefined) {
        const resolved = resolveRealPath(target, depth + 1);
        return tail.length === 0 ? resolved : join(resolved, ...tail.reverse());
      }
      const parent = dirname(current);
      if (parent === current) throw new ConfigError('A path in the configuration cannot be resolved.');
      tail.push(basename(current));
      current = parent;
    }
  }
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function parseDataDir(value: string | undefined, checkoutRoot: string): string {
  if (value === undefined) {
    throw new ConfigError('R2_DATA_DIR is required: an absolute directory outside the checkout.');
  }
  if (!isAbsolute(value) || value.includes('\0') || value.split(/[\\/]/).includes('..')) {
    throw new ConfigError('R2_DATA_DIR must be an absolute path without ".." segments.');
  }
  const real = resolveRealPath(value);
  if (isInside(realpathSync(checkoutRoot), real)) {
    throw new ConfigError('R2_DATA_DIR must be outside the R2 checkout, including through symbolic links.');
  }
  return real;
}

function parseBoolean(name: string, value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const v = value.toLowerCase();
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  throw new ConfigError(`${name} must be true or false.`);
}

function parseInteger(name: string, value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!/^\d{1,6}$/.test(value) || n < min || n > max) {
    throw new ConfigError(`${name} must be an integer from ${min} to ${max}.`);
  }
  return n;
}

function parsePasswordHash(value: string | undefined): AuthConfig {
  if (value === undefined) return { enabled: false, reason: 'not_configured' };
  // PHC string: $scrypt$<params>$<salt>$<hash> or $argon2id$<params>$<salt>$<hash>.
  const parts = value.split('$');
  const valid =
    parts.length >= 5 &&
    parts[0] === '' &&
    (parts[1] === 'scrypt' || parts[1] === 'argon2id') &&
    parts.slice(2).every((p) => /^[A-Za-z0-9+/=,._-]+$/.test(p));
  if (!valid) {
    throw new ConfigError('R2_PASSWORD_HASH must be a PHC-format scrypt or argon2id hash.');
  }
  return { enabled: true, passwordHash: new Secret(value) };
}

function parsePush(env: NodeJS.ProcessEnv): PushConfig {
  const publicKey = read(env, 'VAPID_PUBLIC_KEY');
  const privateKey = read(env, 'VAPID_PRIVATE_KEY');
  const subject = read(env, 'VAPID_SUBJECT');

  const isKey = (v: string, bytes: number, firstByte?: number): boolean => {
    if (!/^[A-Za-z0-9_-]+$/.test(v)) return false;
    const raw = Buffer.from(v, 'base64url');
    return raw.length === bytes && (firstByte === undefined || raw[0] === firstByte);
  };
  if (publicKey !== undefined && !isKey(publicKey, 65, 0x04)) {
    throw new ConfigError('VAPID_PUBLIC_KEY must be an uncompressed P-256 public key in base64url.');
  }
  if (privateKey !== undefined && !isKey(privateKey, 32)) {
    throw new ConfigError('VAPID_PRIVATE_KEY must be a P-256 private key in base64url.');
  }
  if (subject !== undefined) {
    let ok = false;
    if (/^mailto:[^\s@]+@[^\s@]+$/.test(subject)) ok = true;
    else {
      try {
        ok = new URL(subject).protocol === 'https:';
      } catch {
        ok = false;
      }
    }
    if (!ok) throw new ConfigError('VAPID_SUBJECT must be a mailto: address or an https URL.');
  }
  if (publicKey === undefined && privateKey === undefined && subject === undefined) {
    return { enabled: false, reason: 'not_configured' };
  }
  if (publicKey === undefined || privateKey === undefined || subject === undefined) {
    return { enabled: false, reason: 'incomplete' };
  }
  return { enabled: true, publicKey, privateKey: new Secret(privateKey), subject };
}

/**
 * Model configuration is optional and must never prevent startup: anything missing or
 * unusable disables chat and says why, without echoing the value.
 */
function parseChat(env: NodeJS.ProcessEnv): ChatConfig {
  const apiKey = read(env, 'OPENAI_API_KEY');
  const model = read(env, 'OPENAI_MODEL');
  if (apiKey === undefined && model === undefined) return { enabled: false, reason: 'not_configured' };
  if (apiKey === undefined) return { enabled: false, reason: 'api_key_missing' };
  if (model === undefined) return { enabled: false, reason: 'model_missing' };
  if (!/^[\x21-\x7e]{8,512}$/.test(apiKey) || !/^[A-Za-z0-9._:-]{1,100}$/.test(model)) {
    return { enabled: false, reason: 'invalid' };
  }
  return { enabled: true, apiKey: new Secret(apiKey), model };
}

export function loadConfig(env: NodeJS.ProcessEnv, options: ConfigOptions = {}): Config {
  const checkoutRoot = options.checkoutRoot ?? findPackageRoot(import.meta.url);
  const origin = parseOrigin(read(env, 'R2_ORIGIN'));
  const dataDir = parseDataDir(read(env, 'R2_DATA_DIR'), checkoutRoot);
  return {
    host: '127.0.0.1',
    port: parseInteger('R2_PORT', read(env, 'R2_PORT'), 3000, 0, 65535),
    origin,
    dataDir,
    dbPath: join(dataDir, 'r2.sqlite'),
    sessionTtlHours: parseInteger('R2_SESSION_TTL_HOURS', read(env, 'R2_SESSION_TTL_HOURS'), 168, 1, MAX_SESSION_TTL_HOURS),
    pauseNotifications: parseBoolean('R2_PAUSE_NOTIFICATIONS', read(env, 'R2_PAUSE_NOTIFICATIONS'), false),
    auth: parsePasswordHash(read(env, 'R2_PASSWORD_HASH')),
    push: parsePush(env),
    chat: parseChat(env),
  };
}
