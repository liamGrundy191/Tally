import { configDefaults, defineConfig } from 'vitest/config';

// The browser test's seed wipes its database: it runs only through vitest.e2e-seed.config.ts.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'test/e2e-seed.test.ts'],
    // Database and file storage tests: 5 s is too short on a slow machine, run however.
    testTimeout: 20_000,
  },
});
