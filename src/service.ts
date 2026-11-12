import type { FastifyInstance } from 'fastify';
import { systemClock, type Clock } from './clock.ts';
import { loadConfig, type Config } from './config.ts';
import { openDatabase, type Db } from './db.ts';
import { createApp } from './server.ts';

export interface RunningService {
  app: FastifyInstance;
  db: Db;
  config: Config;
  /** Actual listening port (useful when R2_PORT=0). */
  port: number;
  stop(): Promise<void>;
}

/** Start R2: open and migrate SQLite, then listen on loopback. Works without OpenAI. */
export async function startService(
  env: NodeJS.ProcessEnv,
  clock: Clock = systemClock,
  logger?: Parameters<typeof createApp>[0]['logger'],
): Promise<RunningService> {
  const config = loadConfig(env);
  const db = openDatabase(config.dbPath, clock);
  const app = createApp({ config, db, clock, ...(logger !== undefined ? { logger } : {}) });
  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    db.close();
    throw error;
  }
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  if (config.openai.apiKey === undefined) {
    app.log.warn('OPENAI_API_KEY is not set; new reminder requests are unavailable, saved reminders still send');
  }
  app.log.info({ host: config.host, port }, 'R2 listening');
  return {
    app,
    db,
    config,
    port,
    async stop() {
      await app.close();
      db.close();
    },
  };
}
