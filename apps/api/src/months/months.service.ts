// Months (section 6.1): one per calendar month, created when its first ticket arrives.
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { hasHebrew, hoursToMinutes, normaliseName, onRate57List } from '@tally/shared';
import { audit } from '../audit.ts';
import {
  type DownloadKind,
  type Month,
  type Prisma,
  PrismaClient,
  TicketStatus,
} from '../generated/prisma/client.ts';
import { finalGroups, listPlace, lockMonth } from './organiser.ts';

/**
 * Step 6c: the month a settled ticket date belongs to, created if this is its first ticket. Safe
 * when several tickets of a new month arrive at once.
 */
export async function monthOf(db: PrismaClient | Prisma.TransactionClient, date: Date) {
  const key = { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 };
  const found = await db.month.findUnique({ where: { year_month: key } });
  if (found) return found;
  // A new month waits while the lists are being deleted with the last open one (5.4, D56).
  await lockNewMonth(db);
  await db.month.createMany({ data: [key], skipDuplicates: true });
  return db.month.findUniqueOrThrow({ where: { year_month: key } });
}

/**
 * Held while a month is created, and while the lists are deleted for want of an open month. Always
 * taken before a month's own lock, so the lock order stays the same everywhere.
 */
export const lockNewMonth = (db: PrismaClient | Prisma.TransactionClient) =>
  db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('new-month'))`;

@Injectable()
export class MonthsService {
  constructor(private readonly prisma: PrismaClient) {}

  async list() {
    const months = await this.prisma.month.findMany({
      orderBy: [{ year: 'desc' }, { month: 'desc' }],
    });
    return this.withCounts(months);
  }

  /**
   * Closing needs one download of each file (6.1). Recorded after the file is built, under the
   * month's lock, so a download that races with Close is refused rather than left behind.
   */
  async recordDownload(userId: string, monthId: string, kind: DownloadKind, madeAt = new Date()) {
    await this.prisma.$transaction(
      async (tx) => {
        await lockMonth(tx, monthId);
        const month = await tx.month.findUnique({ where: { id: monthId } });
        if (month?.status !== 'open') {
          throw new ConflictException('This month is being closed or is closed.');
        }
        await tx.download.create({ data: { monthId, kind, userId, createdAt: madeAt } });
      },
      { timeout: 120_000, maxWait: 60_000 },
    );
  }

  async get(id: string) {
    const month = await this.prisma.month.findUnique({ where: { id } });
    if (!month) throw new NotFoundException('There is no such month.');
    const workplaces = await this.rows(id);
    return {
      ...(await this.withCounts([month]))[0]!,
      workplaces,
      questions: await this.questions(id, workplaces),
      morning: await this.morning(id),
      notes: await this.notes(workplaces),
    };
  }

  /** The month's morning hours (D66), each under the place it ended in after merges. */
  async morning(monthId: string, db: PrismaClient | Prisma.TransactionClient = this.prisma) {
    const groups = await db.workplaceGroup.findMany({ where: { monthId } });
    const top = finalGroups(groups);
    const nameOf = new Map(groups.map((g) => [g.id, g.displayName]));
    const entries = await db.morningHours.findMany({
      where: { monthId },
      orderBy: { createdAt: 'asc' },
    });
    return entries.map((e) => {
      const groupId = top(e.workplaceGroupId);
      return { id: e.id, groupId, place: nameOf.get(groupId)!, minutes: e.minutes };
    });
  }

  /** Adds a place's morning hours, typed as "37.5" (D66), to the group its tickets join. */
  async addMorning(userId: string, monthId: string, place: string, hours: string) {
    const minutes = hoursToMinutes(hours);
    if (minutes === null) {
      throw new BadRequestException(
        'Type the hours as a number such as 37.5 or 4.25 (whole minutes, more than 0).',
      );
    }
    await this.prisma.$transaction(async (tx) => {
      await lockMonth(tx, monthId);
      await this.openMonth(tx, monthId);
      // As a ticket's workplace: a list spelling is stored under its list name, then grouped.
      const name = (await listPlace(tx, place))!;
      const normalisedName = normaliseName(name);
      if (normalisedName === '') throw new BadRequestException('Choose the workplace.');
      let group =
        (await tx.workplaceGroup.findFirst({ where: { monthId, normalisedName } })) ??
        (await tx.workplaceGroup.create({ data: { monthId, normalisedName, displayName: name } }));
      while (group.mergedIntoId) {
        group = await tx.workplaceGroup.findUniqueOrThrow({ where: { id: group.mergedIntoId } });
      }
      const entry = await tx.morningHours.create({
        data: { monthId, workplaceGroupId: group.id, minutes },
      });
      await audit(tx, {
        userId,
        action: 'add-morning-hours',
        entity: 'MorningHours',
        entityId: entry.id,
        monthId,
        after: { place: group.displayName, minutes },
      });
    });
  }

  async removeMorning(userId: string, monthId: string, entryId: string) {
    await this.prisma.$transaction(async (tx) => {
      await lockMonth(tx, monthId);
      await this.openMonth(tx, monthId);
      const entry = await tx.morningHours.findFirst({ where: { id: entryId, monthId } });
      if (!entry) throw new NotFoundException('There are no such morning hours.');
      await tx.morningHours.delete({ where: { id: entry.id } });
      // A removal leaves no row behind: the month remembers it, so Close asks for a new download.
      await tx.month.update({ where: { id: monthId }, data: { lastActivityAt: new Date() } });
      await audit(tx, {
        userId,
        action: 'remove-morning-hours',
        entity: 'MorningHours',
        entityId: entry.id,
        monthId,
        before: { minutes: entry.minutes },
      });
    });
  }

  private async openMonth(tx: Prisma.TransactionClient, monthId: string) {
    const month = await tx.month.findUnique({ where: { id: monthId } });
    if (!month) throw new NotFoundException('There is no such month.');
    if (month.status !== 'open')
      throw new ConflictException('This month is being closed or is closed.');
  }

  /**
   * Notes for the month page, shown as information (D66): a ready ticket on the 57 list that is
   * not ticked, and one English name that stands for two Hebrew spellings in one place.
   */
  private async notes(workplaces: Awaited<ReturnType<typeof this.rows>>) {
    const lists = await this.prisma.listEntry.findMany({
      where: { kind: { in: ['rate57', 'workplace'] } },
    });
    const rate57 = lists.filter((l) => l.kind === 'rate57');
    const places = lists.filter((l) => l.kind === 'workplace');
    const unticked: { ticketId: string; name: string; place: string }[] = [];
    const sameName: { name: string; place: string }[] = [];
    for (const w of workplaces) {
      for (const r of w.rows) {
        for (const t of r.tickets) {
          if (
            t.status === 'verified' &&
            t.rate57 !== true &&
            onRate57List(rate57, places, r.name, t.workplaceRaw ?? w.name)
          )
            unticked.push({ ticketId: t.id, name: r.name, place: w.name });
        }
        const spellings = new Set(
          r.tickets.flatMap((t) =>
            t.firstName && hasHebrew(t.firstName) ? [normaliseName(t.firstName)] : [],
          ),
        );
        if (spellings.size > 1) sameName.push({ name: r.name, place: w.name });
      }
    }
    return { rate57Unticked: unticked, sameName };
  }

  /**
   * The open "is this the same place?" questions (5.3), one per pair of places as they are after
   * earlier merges. Each side's `id` is the one stored in the question, which "same place" takes
   * as `keepGroupId`; its name, spellings and tickets are those of the place it ended in.
   */
  private async questions(monthId: string, workplaces: Awaited<ReturnType<typeof this.rows>>) {
    const top = finalGroups(
      await this.prisma.workplaceGroup.findMany({
        where: { monthId },
        select: { id: true, mergedIntoId: true },
      }),
    );
    const flags = await this.prisma.flag.findMany({
      where: { code: 'WORKPLACE_SIMILAR', resolvedAt: null, ticket: { monthId } },
      select: { id: true, detail: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const places = new Map(workplaces.map((w) => [w.groupId, w]));
    const cards = new Map<string, { flagId: string; groups: object[] }>();
    for (const f of flags) {
      const ids = (f.detail as { groups: string[] }).groups;
      const sides = ids.map((id) => ({ id, place: places.get(top(id)) }));
      const key = sides
        .map((s) => s.place?.groupId)
        .sort()
        .join();
      if (cards.has(key) || sides[0]!.place === sides[1]!.place) continue;
      if (sides.some((s) => !s.place)) continue;
      cards.set(key, {
        flagId: f.id,
        groups: sides.map(({ id, place }) => {
          const tickets = [...place!.rows.flatMap((r) => r.tickets), ...place!.unnamed];
          return {
            id,
            name: place!.name,
            spellings: place!.spellings,
            tickets: tickets.length,
            ticketId: tickets[0]?.id ?? null,
          };
        }),
      });
    }
    return [...cards.values()];
  }

  /**
   * The month page's tickets by workplace and row (section 9): one row per confirmed name, compared
   * ignoring capitals and spaces (5.2). Tickets with no confirmed name yet are listed apart.
   */
  async rows(monthId: string, db: PrismaClient | Prisma.TransactionClient = this.prisma) {
    const groups = await db.workplaceGroup.findMany({
      where: { monthId, mergedIntoId: null },
      orderBy: { displayName: 'asc' },
      include: {
        tickets: {
          where: { status: { not: 'excluded' } },
          orderBy: [{ shiftDate: 'asc' }, { createdAt: 'asc' }],
          select: {
            id: true,
            version: true,
            workerName: true,
            shiftDate: true,
            totalMinutes: true,
            status: true,
            workplaceRaw: true,
            firstName: true,
            rate57: true,
          },
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
        // How the place was written on its tickets, to help decide a "same place" question.
        spellings: [...new Set(g.tickets.map((t) => t.workplaceRaw!))],
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
