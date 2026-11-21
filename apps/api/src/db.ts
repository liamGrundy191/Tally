import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.ts';

/** A database client for `url`; `schema` picks a Postgres schema other than `public` (tests). */
export function createPrisma(url: string, schema?: string): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: url }, schema ? { schema } : undefined),
  });
}
