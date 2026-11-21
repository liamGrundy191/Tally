import type { Prisma, PrismaClient } from './generated/prisma/client.ts';

/** Principle 8: every change records who made it, and the values before and after. */
export function audit(
  db: PrismaClient | Prisma.TransactionClient,
  entry: {
    userId: string;
    action: string;
    entity: string;
    entityId: string;
    monthId?: string;
    before?: Prisma.InputJsonValue;
    after?: Prisma.InputJsonValue;
  },
) {
  return db.auditEntry.create({ data: entry });
}
