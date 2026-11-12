import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Clock } from './contracts.ts';
import { R2Error } from './contracts.ts';
import { verifyPassword } from './password.ts';
import type { AppDependencies, FeaturePlugin } from './routes.ts';

/** Cookie value of `name` from a Cookie header. The session token is base64url, so no decoding is needed. */
function parse(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    if (key !== '' && !(key in out)) out[key] = part.slice(i + 1).trim();
  }
  return out;
}

/** Set-Cookie value. Always HttpOnly, Secure, SameSite=Strict, Path=/ and host-only. */
function serialize(name: string, value: string, options: { maxAge: number }): string {
  return `${name}=${value}; Max-Age=${options.maxAge}; Path=/; HttpOnly; Secure; SameSite=Strict`;
}

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Marks an `/api/` route as reachable without a session. Everything else is owner-only. */
    public?: boolean;
  }
}

/** `__Host-` makes browsers insist on Secure, Path=/ and no Domain. */
export const SESSION_COOKIE = '__Host-r2_session';
export const MAX_PASSWORD_LENGTH = 1024;
export const LOGIN_MAX_ATTEMPTS = 5;
export const LOGIN_WINDOW_MS = 15 * 60_000;

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function sessionToken(request: FastifyRequest): string | undefined {
  const header = request.headers.cookie;
  if (header === undefined || header.length > 4096) return undefined;
  const token = parse(header)[SESSION_COOKIE];
  return token === undefined || token.length === 0 || token.length > 128 ? undefined : token;
}

/** True when the request carries a live session and owner sign-in is configured. */
export function isOwner(deps: AppDependencies, request: FastifyRequest): boolean {
  if (!deps.config.auth.enabled) return false;
  const token = sessionToken(request);
  return token !== undefined && deps.storage.getSession(token) !== undefined;
}

/**
 * Fail closed: every route registered under `/api/` is checked here, by the route's own
 * registered URL, so a new feature cannot ship an unprotected endpoint by forgetting a hook.
 * A route opts out only with `config: { public: true }`. Writes must come from the one
 * configured origin whether or not they are public.
 */
export function installApiAccessControl(app: FastifyInstance, deps: AppDependencies): void {
  const sameOrigin = async (request: FastifyRequest): Promise<void> => {
    const site = request.headers['sec-fetch-site'];
    if (site === 'cross-site' || site === 'same-site') {
      throw new R2Error('forbidden', 'Requests from other sites are not allowed.');
    }
    if (!SAFE_METHODS.has(request.method) && request.headers.origin !== deps.config.origin) {
      throw new R2Error('forbidden', 'Requests from other origins are not allowed.');
    }
  };
  const owner = async (request: FastifyRequest): Promise<void> => {
    if (!isOwner(deps, request)) throw new R2Error('unauthorized', 'Sign in to continue.');
  };

  app.addHook('onRoute', (route) => {
    if (route.url !== '/api' && !route.url.startsWith('/api/')) return;
    const guards = route.config?.public === true ? [sameOrigin] : [sameOrigin, owner];
    const existing = route.onRequest === undefined ? [] : Array.isArray(route.onRequest) ? route.onRequest : [route.onRequest];
    route.onRequest = [...guards, ...existing];
  });
}

/**
 * Counts sign-in attempts in a sliding window for the one owner account. An attempt counts
 * when it starts, so parallel guesses cannot slip past the limit; only the owner proving the
 * password clears the count.
 */
export class LoginThrottle {
  #attempts: number[] = [];
  readonly #clock: Clock;
  constructor(clock: Clock) {
    this.#clock = clock;
  }

  /** Milliseconds to wait, or 0 after recording the attempt. */
  begin(): number {
    const now = this.#clock.now();
    this.#attempts = this.#attempts.filter((at) => at > now - LOGIN_WINDOW_MS);
    const oldest = this.#attempts[0];
    if (this.#attempts.length >= LOGIN_MAX_ATTEMPTS && oldest !== undefined) return oldest + LOGIN_WINDOW_MS - now;
    this.#attempts.push(now);
    return 0;
  }

  clear(): void {
    this.#attempts = [];
  }
}

const loginBody = z.strictObject({ password: z.string().min(1).max(MAX_PASSWORD_LENGTH) });

export const authPlugin: FeaturePlugin = {
  name: 'auth',
  register(app, deps) {
    const { config, storage, clock } = deps;
    const throttle = new LoginThrottle(clock);

    app.get('/api/session', { config: { public: true } }, async (request) => ({
      authenticated: isOwner(deps, request),
      loginAvailable: config.auth.enabled,
    }));

    app.post('/api/session', { config: { public: true } }, async (request, reply) => {
      if (!config.auth.enabled) throw new R2Error('unavailable', 'Owner sign-in is not configured on the server.');
      const body = loginBody.safeParse(request.body);
      if (!body.success) throw new R2Error('invalid_request', 'Enter the owner password.');

      const waitMs = throttle.begin();
      if (waitMs > 0) {
        reply.header('Retry-After', String(Math.ceil(waitMs / 1000)));
        throw new R2Error('quota_exceeded', 'Too many sign-in attempts. Try again later.');
      }
      if (!(await verifyPassword(body.data.password, config.auth.passwordHash.reveal()))) {
        throw new R2Error('unauthorized', 'Incorrect password.');
      }
      throttle.clear();

      const ttlSeconds = config.sessionTtlHours * 3600;
      const token = randomBytes(32).toString('base64url');
      storage.purgeExpiredSessions();
      storage.createSession(token, clock.now() + ttlSeconds * 1000);
      reply.header('Set-Cookie', serialize(SESSION_COOKIE, token, { maxAge: ttlSeconds }));
      return { authenticated: true };
    });

    // Public so an expired browser session can still clear its cookie; it only ever revokes.
    app.delete('/api/session', { config: { public: true } }, async (request, reply) => {
      const token = sessionToken(request);
      if (token !== undefined) storage.revokeSession(token);
      reply.header('Set-Cookie', serialize(SESSION_COOKIE, '', { maxAge: 0 }));
      return { authenticated: false };
    });
  },
};
