// Closing a month (6.1) and deleting it (6.4): everything of it goes, in the database and in file
// storage, except its summary. A month is marked `closing` first; the purge then runs as a job and
// is tried again until everything is gone, so a crash or a restart only delays it. An open month,
// or another month, is never touched: only a `closing` month is purged.
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { autoDeleteOn, isMonthName, monthName } from '@tally/shared';
import { fromPrisma, PgBoss } from 'pg-boss';
import { type Prisma, PrismaClient } from '../generated/prisma/client.ts';
import { PURGE_MONTH } from '../queue.ts';
import { ReadingConfig } from '../reading/config.ts';
import { Storage } from '../storage.ts';
import { lockNewMonth } from './months.service.ts';
import { lockMonth } from './organiser.ts';

type Tx = Prisma.TransactionClient;
/** The organiser may hold a month's lock for up to 2 minutes. */
const LONG = { timeout: 120_000, maxWait: 60_000 };
const BATCH = 1000;

/**
 * When the month last changed: its tickets and places (both files), and its morning hours and
 * removals (the Excel only). The month's own time stands for what leaves no row behind.
 */
async function lastChange(tx: Prisma.TransactionClient, monthId: string, monthActivity: Date) {
  const [t, g, m] = await Promise.all([
    tx.ticket.aggregate({ where: { monthId }, _max: { updatedAt: true } }),
    tx.workplaceGroup.aggregate({ where: { monthId }, _max: { updatedAt: true } }),
    tx.morningHours.aggregate({ where: { monthId }, _max: { updatedAt: true } }),
  ]);
  const max = (...ds: (Date | null | undefined)[]) =>
    new Date(Math.max(0, ...ds.map((d) => d?.getTime() ?? 0)));
  const tickets = max(t._max.updatedAt, g._max.updatedAt);
  // A ticket that left the month (the month's own time) is in the old PDFs too.
  return { pdfs: max(tickets, monthActivity), any: max(tickets, m._max.updatedAt, monthActivity) };
}

@Injectable()
export class Purger {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly boss: PgBoss,
    private readonly storage: Storage,
    private readonly config: ReadingConfig,
  ) {}

  /** Close month (6.1): checks, then the summary, then `closing`; the purge follows as a job. */
  async close(userId: string, monthId: string, typed: string) {
    await this.prisma.$transaction(async (tx) => {
      await lockMonth(tx, monthId);
      const month = await tx.month.findUnique({ where: { id: monthId } });
      if (!month) throw new NotFoundException('There is no such month.');
      if (month.status !== 'open') {
        throw new ConflictException('This month is being closed or is closed.');
      }
      if (!isMonthName(typed, month)) {
        throw new BadRequestException(`To close it, type the month's name: ${monthName(month)}.`);
      }
      const last = async (kind: 'excel' | 'pdfs') =>
        (
          await tx.download.findFirst({
            where: { monthId, kind },
            orderBy: { createdAt: 'desc' },
          })
        )?.createdAt;
      const [excel, pdfs] = [await last('excel'), await last('pdfs')];
      if (!excel || !pdfs) {
        throw new ConflictException(
          'Download the Excel and the workplace PDFs before closing the month.',
        );
      }
      // Q14: a ticket not yet ready is in neither file, so closing would lose it without a trace.
      const waiting = await tx.ticket.count({
        where: { monthId, status: { notIn: ['verified', 'excluded'] } },
      });
      if (waiting > 0) {
        throw new ConflictException(
          waiting === 1
            ? '1 ticket still needs review. Review or remove it before closing the month.'
            : `${waiting} tickets still need review. Review or remove them before closing the month.`,
        );
      }
      // A ticket being read has no month yet, and may be dated in this one.
      if ((await tx.ticket.count({ where: { status: 'processing' } })) > 0) {
        throw new ConflictException(
          'Some tickets are still being read. Try again when reading has finished.',
        );
      }
      // Dated in this month but outside it, until a person settles the date or a doubt (6c).
      const outside = await tx.ticket.count({
        where: {
          monthId: null,
          status: { not: 'excluded' },
          shiftDate: {
            gte: new Date(Date.UTC(month.year, month.month - 1, 1)),
            lt: new Date(Date.UTC(month.year, month.month, 1)),
          },
        },
      });
      if (outside > 0) {
        throw new ConflictException(
          outside === 1
            ? '1 ticket dated in this month is waiting for a date or a check.'
            : `${outside} tickets dated in this month are waiting for a date or a check.`,
        );
      }
      // Another ticket not typed in yet may hold shifts of this month (D68).
      const untyped = await tx.ticket.count({
        where: { freeForm: true, status: 'needs_manual_entry', monthId: null },
      });
      if (untyped > 0) {
        throw new ConflictException(
          untyped === 1
            ? '1 other ticket is not typed in yet. Type it in or remove it before closing the month.'
            : `${untyped} other tickets are not typed in yet. Type them in or remove them before closing the month.`,
        );
      }
      // Closing deletes everything: a change after the last download would reach no file (D66).
      const changed = await lastChange(tx, monthId, month.lastActivityAt);
      if (changed.pdfs > pdfs || changed.any > excel) {
        throw new ConflictException(
          'You changed something after your last download. Download the files again first.',
        );
      }
      await this.markClosing(tx, monthId, userId);
    }, LONG);
  }

  /**
   * The summary that outlives the purge (6.4): the ready tickets and their minutes, the Excel's
   * grand total. The purge job is added in the same transaction, so neither exists without the other.
   */
  private async markClosing(tx: Tx, monthId: string, userId: string | null) {
    const ready = await tx.ticket.aggregate({
      where: { monthId, status: 'verified' },
      _count: { _all: true },
      _sum: { totalMinutes: true },
    });
    await tx.month.update({
      where: { id: monthId },
      data: {
        status: 'closing',
        closedById: userId,
        summaryTicketCount: ready._count._all,
        summaryTotalMinutes: ready._sum.totalMinutes ?? 0,
      },
    });
    await this.queue(monthId, tx);
  }

  private queue(monthId: string, tx?: Tx) {
    return this.boss.send(
      PURGE_MONTH,
      { monthId },
      { singletonKey: monthId, ...(tx && { db: fromPrisma(tx) }) },
    );
  }

  /** Deletes a closing month (6.4). Safe to run again at any point; does nothing to other months. */
  async purge(monthId: string) {
    const month = await this.prisma.month.findUnique({ where: { id: monthId } });
    if (month?.status !== 'closing') return;
    for (;;) {
      const tickets = await this.prisma.ticket.findMany({
        where: { monthId },
        select: { id: true, uploadId: true, s3KeyPage: true },
        take: BATCH,
      });
      if (tickets.length === 0) break;
      await this.deleteTickets(tickets);
    }
    await this.prisma.$transaction(async (tx) => {
      await lockNewMonth(tx); // before the month's lock, as everywhere (the lists may go)
      await lockMonth(tx, monthId);
      const again = await tx.month.findUniqueOrThrow({ where: { id: monthId } });
      if (again.status !== 'closing') return;
      // Nothing joins a closing month (the reader and saves check under this lock): a ticket here
      // means something changed meanwhile, so the job is tried again rather than closing over it.
      if ((await tx.ticket.count({ where: { monthId } })) > 0) {
        throw new Error(`Month ${monthId} still has tickets; trying again.`);
      }
      await tx.workplaceGroup.deleteMany({ where: { monthId } });
      await tx.download.deleteMany({ where: { monthId } });
      await tx.auditEntry.deleteMany({ where: { monthId } });
      await this.dropListsIfIdle(tx);
      await tx.month.update({
        where: { id: monthId },
        data: { status: 'closed', closedAt: new Date() },
      });
    }, LONG);
  }

  /**
   * Tickets with their scans, history and readings (by cascade), and each upload left with no
   * tickets. Files go first: a crash after them leaves rows the next run deletes again, while the
   * other order could leave scans no row points to.
   */
  private async deleteTickets(tickets: { id: string; uploadId: string; s3KeyPage: string }[]) {
    const ids = tickets.map((t) => t.id);
    // An upload whose every ticket goes now, and that is no longer being split, goes too, with any
    // page the splitter stored just before a crash (D56): nothing else can still need its pages.
    const candidates = await this.prisma.upload.findMany({
      where: {
        id: { in: [...new Set(tickets.map((t) => t.uploadId))] },
        s3KeyOriginal: null,
        tickets: { every: { id: { in: ids } } },
      },
      select: { id: true },
    });
    // Another ticket's shifts share its scan (D68): a shift in another month still needs it.
    // shortcut: a shift added to that scan between this look and the delete loses its scan; its
    // month's PDFs then refuse with "a scan is missing" rather than leave hours out. Rare.
    const kept = await this.prisma.ticket.findMany({
      where: { s3KeyPage: { in: tickets.map((t) => t.s3KeyPage) }, id: { notIn: ids } },
      select: { s3KeyPage: true },
    });
    const needed = new Set(kept.map((t) => t.s3KeyPage));
    await this.storage.removeMany(
      [...new Set(tickets.map((t) => t.s3KeyPage))].filter((k) => !needed.has(k)),
    );
    for (const u of candidates) await this.storage.removePrefix(`pages/${u.id}/`);
    await this.prisma.$transaction(async (tx) => {
      // Entries written while a ticket waited outside any month (D46) carry no month id.
      await tx.auditEntry.deleteMany({ where: { entity: 'Ticket', entityId: { in: ids } } });
      await tx.ticket.deleteMany({ where: { id: { in: ids } } });
      const empty = (
        await tx.upload.findMany({
          where: {
            id: { in: candidates.map((u) => u.id) },
            s3KeyOriginal: null,
            tickets: { none: {} },
          },
          select: { id: true },
        })
      ).map((u) => u.id);
      await tx.auditEntry.deleteMany({ where: { entity: 'Upload', entityId: { in: empty } } });
      await tx.upload.deleteMany({ where: { id: { in: empty } } });
    }, LONG);
  }

  /**
   * The lists go with the last open month (5.4), but not while a file is being split or read: its
   * tickets would be read without them, or start a new month that needs them. The caller holds the
   * new-month lock, so no month is being created meanwhile.
   */
  private async dropListsIfIdle(tx: Tx) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('names'))`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('workplaces'))`;
    const busy =
      (await tx.month.count({ where: { status: 'open' } })) +
      (await tx.ticket.count({ where: { status: 'processing' } })) +
      (await tx.upload.count({ where: { s3KeyOriginal: { not: null } } }));
    if (busy === 0) await tx.listEntry.deleteMany();
  }

  /**
   * The nightly check (6.1, 6.4): a month 60 days past its last day is closed even if nobody
   * downloaded it; a month left `closing` is purged again; then what no month holds any more.
   */
  async check() {
    // Both clocks must agree: the settings' date (which tests fix) and the database's own, so a
    // wrong clock on one machine alone never deletes a month early.
    const [{ day }] = await this.prisma.$queryRaw<[{ day: string }]>`
      SELECT to_char(now() AT TIME ZONE 'Asia/Jerusalem', 'YYYY-MM-DD') AS day`;
    const today = this.config.settings().today;
    const months = await this.prisma.month.findMany({
      where: { status: { in: ['open', 'closing'] } },
    });
    for (const m of months) {
      if (m.status === 'closing') await this.queue(m.id);
      else if (today >= autoDeleteOn(m) && day >= autoDeleteOn(m)) {
        await this.prisma.$transaction(async (tx) => {
          await lockMonth(tx, m.id);
          const again = await tx.month.findUniqueOrThrow({ where: { id: m.id } });
          if (again.status === 'open') await this.markClosing(tx, m.id, null);
        }, LONG);
      }
    }
    await this.deleteStrays();
    // An upload left with no tickets (all removed or read again elsewhere): kept a week, then gone.
    const empty = await this.prisma.upload.findMany({
      where: {
        s3KeyOriginal: null,
        tickets: { none: {} },
        createdAt: { lt: new Date(Date.now() - 7 * 24 * 3600_000) },
      },
      select: { id: true },
    });
    for (const { id } of empty) {
      await this.storage.removePrefix(`pages/${id}/`);
      await this.prisma.$transaction(async (tx) => {
        const gone = await tx.upload.deleteMany({
          where: { id, s3KeyOriginal: null, tickets: { none: {} } },
        });
        if (gone.count) {
          await tx.auditEntry.deleteMany({ where: { entity: 'Upload', entityId: id } });
        }
      });
    }
    // The lists, if the last open month closed while a file was being read.
    await this.prisma.$transaction(async (tx) => {
      await lockNewMonth(tx);
      await this.dropListsIfIdle(tx);
    }, LONG);
  }

  /**
   * A removed ticket dated in a month already closed belongs to no month (6.1.7), and nothing else
   * would ever delete it. Only those go: one removed while waiting for a date may still be dated in
   * an open month, and stays until that month closes.
   */
  private async deleteStrays() {
    const closed = await this.prisma.month.findMany({ where: { status: 'closed' } });
    const where = {
      monthId: null,
      status: 'excluded' as const,
      OR: [
        { flags: { some: { code: 'MONTH_CLOSED' } } },
        ...closed.map((m) => ({
          shiftDate: {
            gte: new Date(Date.UTC(m.year, m.month - 1, 1)),
            lt: new Date(Date.UTC(m.year, m.month, 1)),
          },
        })),
      ],
    };
    for (;;) {
      const strays = await this.prisma.ticket.findMany({
        where,
        select: { id: true, uploadId: true, s3KeyPage: true },
        take: BATCH,
      });
      if (strays.length === 0) break;
      await this.deleteTickets(strays);
    }
  }
}
