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

export type TestDatabase = ReturnType<typeof testDatabase>;

/**
 * A new empty schema, with a client for it, and another for the job queue's own tables. Call
 * `migrate` before use and `drop` after. With `database`, that whole database instead (the
 * browser test's, kept between runs), in its usual schemas, as the API itself uses it.
 */
export function testDatabase(database?: string) {
  const url = database ? databaseUrlFor(database) : databaseUrl!;
  const schema = database ? 'public' : `test_${randomBytes(4).toString('hex')}`;
  const prisma = createPrisma(url, schema);
  return {
    url,
    prisma,
    schema,
    queueSchema: database ? undefined : `${schema}_queue`,
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
      if (database) throw new Error('A named test database is kept: reset it instead.');
      await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}_queue" CASCADE`);
      await prisma.$disconnect();
    },
  };
}

/** DATABASE_URL with another database on the same server. */
export function databaseUrlFor(database: string) {
  const url = new URL(databaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}
