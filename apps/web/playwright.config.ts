// The browser test (pnpm e2e, T2.3): the built web app and the built API, on the test's own
// database `tally_e2e` and bucket `tally-e2e`, seeded by apps/api/test/e2e-seed.test.ts.
// Never the dev database. Ports: API 3100, web 4173, so a running `pnpm dev` is not disturbed.
import { defineConfig, devices } from '@playwright/test';

try {
  process.loadEnvFile(new URL('../../.env', import.meta.url));
} catch {
  // No .env: CI sets DATABASE_URL and the S3_ settings.
}
const database = new URL(process.env.DATABASE_URL ?? 'postgresql://localhost/none');
database.pathname = '/tally_e2e';

export default defineConfig({
  testDir: 'e2e',
  testMatch: '*.e2e.ts',
  workers: 1,
  timeout: 120_000,
  reporter: 'list',
  use: { baseURL: 'http://localhost:4173', ...devices['Desktop Chrome'], trace: 'off' },
  webServer: [
    {
      command: 'node --experimental-strip-types --disable-warning=ExperimentalWarning dist/main.js',
      cwd: '../api',
      url: 'http://localhost:3100/api/auth/me',
      reuseExistingServer: false,
      env: {
        DATABASE_URL: database.toString(),
        S3_BUCKET: 'tally-e2e',
        EXTRACTOR: 'fake',
        REVIEW_EVERYTHING: 'false',
        PORT: '3100',
      },
    },
    {
      command: 'pnpm exec vite preview --port 4173 --strictPort',
      url: 'http://localhost:4173',
      reuseExistingServer: false,
      env: { API_URL: 'http://localhost:3100' },
    },
  ],
});
