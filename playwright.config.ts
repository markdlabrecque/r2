import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './browser',
  workers: 1,
  timeout: 60_000,
  reporter: 'list',
  use: { browserName: 'chromium', ignoreHTTPSErrors: true, trace: 'retain-on-failure' },
});
