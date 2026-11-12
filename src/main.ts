import { ConfigError } from './config.ts';
import { startService } from './service.ts';

try {
  const service = await startService(process.env);
  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    service.app.log.info({ signal }, 'R2 stopping');
    service.stop().then(
      () => process.exit(0),
      (error: unknown) => {
        service.app.log.error({ err: error }, 'R2 failed to stop cleanly');
        process.exit(1);
      },
    );
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
} catch (error) {
  // Startup errors name the problem but never print environment values such as keys.
  console.error(`R2 failed to start: ${error instanceof ConfigError || error instanceof Error ? error.message : 'unknown error'}`);
  process.exit(1);
}
