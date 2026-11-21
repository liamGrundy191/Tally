import { defineConfig } from 'prisma/config';

// Prisma does not read .env by itself; the repository keeps one .env at its root.
try {
  process.loadEnvFile(new URL('../../.env', import.meta.url));
} catch {
  // No .env: DATABASE_URL comes from the environment (CI, production).
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  // Not needed to generate the client, so it may be missing then.
  datasource: { url: process.env.DATABASE_URL },
});
