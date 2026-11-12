import { existsSync } from 'node:fs';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyError, type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { installApiAccessControl } from './auth.ts';
import type { Config } from './config.ts';
import {
  R2Error,
  type Clock,
  type ErrorBody,
  type ErrorCode,
  type ModelInterpreter,
  type PushTransport,
  type Storage,
  type Worker,
} from './contracts.ts';
import { defaultWebRoot } from './paths.ts';

/** 8 KiB: every request R2 accepts is a short chat message or a small JSON object. */
export const BODY_LIMIT_BYTES = 8192;

export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** Everything a feature needs from the application. Features never reach for globals. */
export interface AppDependencies {
  config: Config;
  storage: Storage;
  clock: Clock;
  /** Absent until a later task supplies one; chat features must treat that as disabled. */
  modelInterpreter?: ModelInterpreter;
  /** Absent until push is configured. */
  pushTransport?: PushTransport;
  /** Started when the app becomes ready and stopped when it closes. */
  worker?: Worker;
  /** Fastify logger option. Tests pass `false` or a capture stream. */
  logger?: FastifyServerOptions['logger'];
  /** Directory of built web assets. Defaults to `dist/web` in the installation. */
  webRoot?: string;
}

/**
 * A later feature (auth, settings, chat, push ...) adds its routes here. Each plugin gets its
 * own encapsulated Fastify scope, so its hooks cannot leak into other features.
 */
export interface FeaturePlugin {
  name: string;
  register(app: FastifyInstance, deps: AppDependencies): void | Promise<void>;
}

/**
 * Credentials and request bodies never reach the logs: Fastify's request log records
 * method, URL and ids only, and these headers are redacted regardless.
 */
export function loggerOptions(level: string) {
  return {
    level,
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
      censor: '[redacted]',
    },
  };
}

function errorBody(code: ErrorCode, message: string): ErrorBody {
  return { error: { code, message } };
}

/** Map Fastify's own client errors to our typed codes, with messages we wrote. */
function classifyFastifyError(error: FastifyError): R2Error | undefined {
  switch (error.code) {
    case 'FST_ERR_CTP_BODY_TOO_LARGE':
      return new R2Error('payload_too_large', `The request body is larger than ${BODY_LIMIT_BYTES} bytes.`);
    case 'FST_ERR_CTP_INVALID_MEDIA_TYPE':
      return new R2Error('unsupported_media_type', 'The request content type is not supported.');
    default:
      break;
  }
  if (error.statusCode !== undefined && error.statusCode >= 400 && error.statusCode < 500) {
    return new R2Error('invalid_request', 'The request could not be understood.');
  }
  return undefined;
}

export function createApp(deps: AppDependencies, featurePlugins: readonly FeaturePlugin[] = []): FastifyInstance {
  const { config, storage, worker } = deps;
  const app = Fastify({
    logger: deps.logger ?? loggerOptions('info'),
    bodyLimit: BODY_LIMIT_BYTES,
    // Honour X-Forwarded-* only from a loopback peer (Tailscale Serve); never from anything else.
    trustProxy: 'loopback',
  });

  // Same-origin defaults. No CORS plugin is registered, so no cross-origin access is granted.
  app.addHook('onSend', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
  });

  // Safe errors only: our typed messages, or a generic one. Details go to the private log.
  app.setErrorHandler((error: FastifyError | R2Error, request, reply) => {
    const typed = error instanceof R2Error ? error : classifyFastifyError(error as FastifyError);
    if (typed !== undefined) {
      return reply.code(typed.status).send(errorBody(typed.code, typed.message));
    }
    request.log.error({ err: error }, 'request failed');
    return reply.code(500).send(errorBody('internal_error', 'Something went wrong.'));
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send(errorBody('not_found', 'Not found.')));

  // Generic by design: no counts, settings, provider configuration or stored content.
  app.get('/healthz', async (request, reply) => {
    try {
      storage.ping();
      if (worker?.getStatus().state === 'failed') throw new Error('worker failed');
      return { status: 'ok' };
    } catch (error) {
      request.log.error({ err: error }, 'health check failed');
      return reply.code(503).send({ status: 'unavailable' });
    }
  });

  // Before any feature registers: every `/api/` route is owner-only unless it opts out.
  installApiAccessControl(app, deps);

  for (const plugin of featurePlugins) {
    app.register(async (scope) => {
      await plugin.register(scope, deps);
    }, { name: plugin.name } as never);
  }

  // Built web shell. `/sw.js` is reserved at the origin root for the later service worker:
  // until that task ships it, the request gets a 404, never the app shell.
  const webRoot = deps.webRoot ?? defaultWebRoot();
  if (existsSync(webRoot)) {
    app.register(fastifyStatic, { root: webRoot, prefix: '/', cacheControl: false, dotfiles: 'deny' });
  } else {
    app.log.warn('Web assets are missing; run `npm run build`. API routes still work.');
  }

  if (worker !== undefined) {
    app.addHook('onReady', async () => {
      await worker.start();
    });
    app.addHook('onClose', async () => {
      await worker.stop();
    });
  }

  void config;
  return app;
}
