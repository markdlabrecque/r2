import type { FastifyInstance } from 'fastify';
import { authPlugin } from './auth.ts';
import { loadConfig, type Config } from './config.ts';
import { systemClock, type Clock } from './contracts.ts';
import { chatPlugin } from './chat.ts';
import { openStorage, type SqliteStorage } from './db.ts';
import { createOpenAIInterpreter } from './openai.ts';
import { pushPlugin } from './push-routes.ts';
import { WebPushTransport } from './push.ts';
import { settingsPlugin } from './settings.ts';
import { createApp, loggerOptions, type AppDependencies, type FeaturePlugin } from './routes.ts';

export interface RunningService {
  app: FastifyInstance;
  storage: SqliteStorage;
  config: Config;
  /** Actual listening port (useful when R2_PORT=0). */
  port: number;
  stop(): Promise<void>;
}

export interface StartOptions {
  clock?: Clock;
  logger?: AppDependencies['logger'];
  featurePlugins?: readonly FeaturePlugin[];
  /** Injected adapters and worker; tests supply fakes. */
  adapters?: Pick<AppDependencies, 'modelInterpreter' | 'pushTransport' | 'worker' | 'webRoot'>;
  /** Directory holding the checkout, for the "data outside the checkout" rule. */
  checkoutRoot?: string;
}

/** Start R2: validate configuration, open and migrate SQLite, then listen on loopback. */
export async function startService(env: NodeJS.ProcessEnv, options: StartOptions = {}): Promise<RunningService> {
  const clock = options.clock ?? systemClock;
  const config = loadConfig(env, options.checkoutRoot !== undefined ? { checkoutRoot: options.checkoutRoot } : {});
  const storage = openStorage(config.dbPath, clock);
  // An injected interpreter wins (tests); otherwise OpenAI is used only when configured.
  const modelInterpreter =
    options.adapters?.modelInterpreter ??
    (config.chat.enabled ? createOpenAIInterpreter({ apiKey: config.chat.apiKey.reveal(), model: config.chat.model }) : undefined);
  const pushTransport =
    options.adapters?.pushTransport ??
    (config.push.enabled
      ? new WebPushTransport({
          vapid: { subject: config.push.subject, publicKey: config.push.publicKey, privateKey: config.push.privateKey.reveal() },
        })
      : undefined);
  const app = createApp(
    {
      config,
      storage,
      clock,
      logger: options.logger ?? loggerOptions('info'),
      ...options.adapters,
      ...(modelInterpreter !== undefined ? { modelInterpreter } : {}),
      ...(pushTransport !== undefined ? { pushTransport } : {}),
    },
    [authPlugin, settingsPlugin, pushPlugin, chatPlugin, ...(options.featurePlugins ?? [])],
  );
  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    await app.close().catch(() => undefined);
    storage.close();
    throw error;
  }
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  if (!config.chat.enabled) {
    app.log.warn({ reason: config.chat.reason }, 'Chat is disabled; saved reminders still send');
  }
  if (!config.auth.enabled) app.log.warn('R2_PASSWORD_HASH is not set; owner login is not ready');
  if (!config.push.enabled) app.log.warn({ reason: config.push.reason }, 'VAPID is not configured; push is not ready');
  app.log.info({ host: config.host, port }, 'R2 listening');
  return {
    app,
    storage,
    config,
    port,
    async stop() {
      try {
        await app.close();
      } finally {
        storage.close();
      }
    },
  };
}
