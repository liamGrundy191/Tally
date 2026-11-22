import { defineConfig } from 'vitest/config';

// pnpm e2e:seed: only the browser test's seed, and the flag that lets it run (D49).
export default defineConfig({
  test: {
    include: ['test/e2e-seed.test.ts'],
    env: { E2E_SEED: '1' },
    testTimeout: 180_000,
  },
});
