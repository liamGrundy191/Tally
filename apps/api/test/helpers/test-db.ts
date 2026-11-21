// A throwaway, migrated Postgres schema for one test file. Needs Postgres: locally
// `docker compose -f docker/compose.dev.yml up -d` and DATABASE_URL in .env; CI provides one.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createPrisma } from '../../src/db.ts';

try {
  process.loadEnvFile(new URL('../../../../.env', import.meta.url));
} catch {
  // No .env: DATABASE_URL comes from the environment.
}
export const databaseUrl = process.env.DATABASE_URL || undefined;
if (!databaseUrl && process.env.CI) {
  throw new Error('CI must provide DATABASE_URL for the database tests.');
}

const apiDir = fileURLToPath(new URL('../..', import.meta.url));

/** A new empty schema, with a client for it. Call `migrate` before use and `drop` after. */
export function testDatabase() {
  const url = databaseUrl!;
  const schema = `test_${randomBytes(4).toString('hex')}`;
  const prisma = createPrisma(url, schema);
  return {
    prisma,
    schema,
    /** Applies the migrations; returns what Prisma printed. Takes several seconds. */
    migrate: async () =>
      (
        await promisify(execFile)(
          process.execPath,
          ['node_modules/prisma/build/index.js', 'migrate', 'deploy'],
          {
            cwd: apiDir,
            env: {
              ...process.env,
              DATABASE_URL: `${url}${url.includes('?') ? '&' : '?'}schema=${schema}`,
            },
          },
        )
      ).stdout,
    drop: async () => {
      await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await prisma.$disconnect();
    },
  };
}
