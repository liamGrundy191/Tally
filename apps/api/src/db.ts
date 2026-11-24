import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.ts';

// API + worker, each with this pool and pg-boss's, stay under the smallest managed database's
// connection limit (about 22; D60).
export const POOL_SIZE = 4;

/** A database client for `url`; `schema` picks a Postgres schema other than `public` (tests). */
export function createPrisma(url: string, schema?: string): PrismaClient {
  return new PrismaClient({
    // A database that does not answer fails within 10 s instead of hanging (pg's default: never).
    adapter: new PrismaPg(
      { connectionString: url, connectionTimeoutMillis: 10_000, max: POOL_SIZE },
      schema ? { schema } : undefined,
    ),
  });
}
