import { resolve } from 'node:path';

export interface Config {
  /** Loopback only; Tailscale Serve terminates HTTPS in front of R2. */
  host: string;
  port: number;
  dataDir: string;
  dbPath: string;
  openai: { apiKey: string | undefined; model: string };
  logLevel: string;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const LOG_LEVELS = new Set(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const host = env.R2_HOST?.trim() || '127.0.0.1';
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new ConfigError(
      `R2_HOST must be a loopback address (127.0.0.1, ::1 or localhost); got "${host}". ` +
        'Expose R2 privately with Tailscale Serve.',
    );
  }

  const portText = env.R2_PORT?.trim() || '8787';
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || port > 65535) {
    throw new ConfigError(`R2_PORT must be an integer from 0 to 65535; got "${portText}".`);
  }

  const logLevel = env.R2_LOG_LEVEL?.trim() || 'info';
  if (!LOG_LEVELS.has(logLevel)) {
    throw new ConfigError(`R2_LOG_LEVEL must be one of ${[...LOG_LEVELS].join(', ')}.`);
  }

  const dataDir = resolve(env.R2_DATA_DIR?.trim() || './data');
  return {
    host,
    port,
    dataDir,
    dbPath: resolve(dataDir, 'r2.sqlite'),
    // OpenAI is optional at startup: saved reminders must stay deliverable without it.
    openai: {
      apiKey: env.OPENAI_API_KEY?.trim() || undefined,
      model: env.R2_OPENAI_MODEL?.trim() || 'gpt-5-mini',
    },
    logLevel,
  };
}
