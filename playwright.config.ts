import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: ['e2e/**/*.spec.ts', 'browser/**/*.spec.ts'],
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { browserName: 'chromium', ignoreHTTPSErrors: true, trace: 'retain-on-failure' },
});
