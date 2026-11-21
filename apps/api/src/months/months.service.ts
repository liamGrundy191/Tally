// Months (section 6.1): one per calendar month, created when its first ticket arrives.
import { Injectable, NotFoundException } from '@nestjs/common';
import { type Month, type Prisma, PrismaClient, TicketStatus } from '../generated/prisma/client.ts';

/**
 * Step 6c: the month a settled ticket date belongs to, created if this is its first ticket. Safe
 * when several tickets of a new month arrive at once.
 */
export async function monthOf(db: PrismaClient | Prisma.TransactionClient, date: Date) {
  const key = { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 };
  await db.month.createMany({ data: [key], skipDuplicates: true });
  return db.month.findUniqueOrThrow({ where: { year_month: key } });
}

@Injectable()
export class MonthsService {
  constructor(private readonly prisma: PrismaClient) {}

  async list() {
    const months = await this.prisma.month.findMany({
      orderBy: [{ year: 'desc' }, { month: 'desc' }],
    });
    return this.withCounts(months);
  }

  async get(id: string) {
    const month = await this.prisma.month.findUnique({ where: { id } });
    if (!month) throw new NotFoundException('There is no such month.');
    return { ...(await this.withCounts([month]))[0]!, workplaces: await this.rows(id) };
  }

  /**
   * The month page's tickets by workplace and row (section 9): one row per confirmed name, compared
   * ignoring capitals and spaces (5.2). Tickets with no confirmed name yet are listed apart.
   */
  private async rows(monthId: string) {
    const groups = await this.prisma.workplaceGroup.findMany({
      where: { monthId, mergedIntoId: null },
      orderBy: { displayName: 'asc' },
      include: {
        tickets: {
          where: { status: { not: 'excluded' } },
          orderBy: [{ shiftDate: 'asc' }, { createdAt: 'asc' }],
          select: { id: true, workerName: true, shiftDate: true, totalMinutes: true, status: true },
        },
      },
    });
    return groups.map((g) => {
      const rows = new Map<string, { name: string; tickets: typeof g.tickets }>();
      for (const t of g.tickets.filter((t) => t.workerName)) {
        const key = t.workerName!.toLowerCase().replace(/\s+/g, ' ').trim();
        const row = rows.get(key) ?? { name: t.workerName!, tickets: [] };
        row.tickets.push(t);
        rows.set(key, row);
      }
      return {
        groupId: g.id,
        name: g.displayName,
        rows: [...rows.values()].sort((a, b) => a.name.localeCompare(b.name)),
        unnamed: g.tickets.filter((t) => !t.workerName),
      };
    });
  }

  /** Each month with its tickets counted by status (section 9: "640 tickets, 12 need review"). */
  private async withCounts(months: Month[]) {
    const counts = await this.prisma.ticket.groupBy({
      by: ['monthId', 'status'],
      where: { monthId: { in: months.map((m) => m.id) } },
      _count: { _all: true },
    });
    return months.map((m) => ({
      id: m.id,
      year: m.year,
      month: m.month,
      status: m.status,
      closedAt: m.closedAt,
      summaryTicketCount: m.summaryTicketCount,
      summaryTotalMinutes: m.summaryTotalMinutes,
      tickets: Object.fromEntries(
        Object.values(TicketStatus).map((s) => [
          s,
          counts.find((c) => c.monthId === m.id && c.status === s)?._count._all ?? 0,
        ]),
      ),
    }));
  }
}
