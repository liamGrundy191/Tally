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
  // Not needed to generate the client, so it may be missing then. Prisma's migrate engine writes
  // TLS settings differently from the app's driver, so production gives it its own address (D60).
  datasource: { url: process.env.MIGRATE_DATABASE_URL || process.env.DATABASE_URL },
});
