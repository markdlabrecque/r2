import Fastify, { type FastifyInstance } from 'fastify';
import type { Clock } from './clock.ts';
import type { Config } from './config.ts';
import type { Db } from './db.ts';
import { readStoreStatus } from './status.ts';

export interface AppDeps {
  config: Config;
  db: Db;
  clock: Clock;
  /** Fastify logger option. Tests pass `false` or a capture stream. */
  logger?: Parameters<typeof Fastify>[0] extends infer O ? (O extends { logger?: infer L } ? L : never) : never;
}

/**
 * Credentials and request bodies never reach the logs: Fastify's request log
 * records method, URL and ids only, and these headers are redacted regardless.
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

export function createApp(deps: AppDeps): FastifyInstance {
  const { config, db, clock } = deps;
  const app = Fastify({
    logger: deps.logger ?? loggerOptions(config.logLevel),
    bodyLimit: 64 * 1024,
    trustProxy: false,
  });

  app.addHook('onSend', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
  });

  // Health needs no OpenAI and no login: it reports counts and flags only.
  app.get('/healthz', async (_req, reply) => {
    const checkedAt = new Date(clock.now()).toISOString();
    try {
      const store = readStoreStatus(db);
      return {
        status: 'ok',
        checkedAt,
        schemaVersion: store.schemaVersion,
        database: 'ok',
        openai: { configured: config.openai.apiKey !== undefined },
        notifications: {
          paused: store.notificationsPaused,
          browserConnected: store.browserConnected,
        },
        timezoneConfigured: store.timezoneConfigured,
        reminders: store.reminders,
      };
    } catch (error) {
      app.log.error({ err: error }, 'health check: database unavailable');
      return reply.code(503).send({ status: 'unavailable', checkedAt, database: 'error' });
    }
  });

  return app;
}
