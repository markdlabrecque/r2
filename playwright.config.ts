import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './browser',
  workers: 1,
  use: { browserName: 'chromium', ignoreHTTPSErrors: true },
});
