import { defineConfig } from 'vitest/config';

const tier = process.env.R2_TEST_TIER ?? 'commit';
if (!['commit', 'functional', 'nightly', 'smoke', 'all'].includes(tier)) {
  throw new Error(`Unknown R2_TEST_TIER: ${tier}`);
}
const functional = 'tests/**/*.functional.test.ts';
const nightly = 'tests/**/*.nightly.test.ts';

export default defineConfig({
  test: {
    environment: 'node',
    include: tier === 'functional' ? [functional]
      : tier === 'nightly' ? [nightly]
      : tier === 'smoke' ? ['tests/artifact.nightly.test.ts']
      : ['tests/**/*.test.ts'],
    exclude: tier === 'commit' ? [functional, nightly] : [],
  },
});
