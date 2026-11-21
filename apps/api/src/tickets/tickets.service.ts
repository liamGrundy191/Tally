// Reviewing tickets (sections 4.1 and 8): a person corrects or confirms a ticket's values, removes
// it, or has it read again. Every save runs the rule checks again on the saved values, and nothing
// is settled without the checks or a person.
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  FIELD_KEYS,
  type FieldKey,
  type Flag,
  type listTicketsSchema,
  type saveTicketSchema,
  checkTicketValues,
  englishName,
  hasHebrew,
  normaliseName,
} from '@tally/shared';
import { fromPrisma, PgBoss } from 'pg-boss';
import type { z } from 'zod';
import { audit } from '../audit.ts';
import {
  type Prisma,
  PrismaClient,
  type Ticket,
  TicketStatus,
} from '../generated/prisma/client.ts';
import { monthOf } from '../months/months.service.ts';
import { Organiser, lockMonth } from '../months/organiser.ts';
import { READ_UPLOAD } from '../queue.ts';
import { ReadingConfig } from '../reading/config.ts';
import { Storage } from '../storage.ts';

type Tx = Prisma.TransactionClient;

/** Doubts about the reading. A save settles them: the value was either corrected or confirmed. */
const READING_FLAGS = [
  'PASS_DISAGREEMENT',
  'FIELD_UNREADABLE',
  'CORRECTION_MARKS',
  'MATCH_AMBIGUOUS',
  'WORKPLACE_NOT_ON_LIST',
  'MARKERS_NOT_FOUND',
  'IMAGE_BLURRY',
  'IMAGE_DARK',
  'EXTRACTION_ERROR',
];
/** The questions about a month (5.2, 5.3), answered at POST /flags/:id/resolve. */
const QUESTIONS = ['WORKPLACE_SIMILAR', 'POSSIBLE_DUPLICATE'];
/** Every other flag but VOIDED_TICKET is a rule check, raised again (or not) by every save. */
const isRuleFlag = (code: string) =>
  !READING_FLAGS.includes(code) && !QUESTIONS.includes(code) && code !== 'VOIDED_TICKET';

/** Answered "keep both" duplicate questions about a ticket, from either side. */
const keptBothAbout = (id: string): Prisma.FlagWhereInput => ({
  code: 'POSSIBLE_DUPLICATE',
  resolution: 'keep_both',
  OR: [{ ticketId: id }, { relatedTicketId: id }],
});

const STALE = 'Someone else changed this ticket. Reload it.';
const PAGE_SIZE = 50;

const TICKET = {
  id: true,
  uploadId: true,
  monthId: true,
  pageIndex: true,
  status: true,
  verifiedHow: true,
  version: true,
  firstName: true,
  workerName: true,
  workplaceRaw: true,
  workplaceGroupId: true,
  shiftDate: true,
  startMinutes: true,
  endMinutes: true,
  totalMinutes: true,
  totalFromMath: true,
  excludedReason: true,
  replacedById: true,
  createdAt: true,
} satisfies Prisma.TicketSelect;

/** A ticket's values as stored, by the box they were written in. */
const stored = (t: Ticket): Record<FieldKey, string | number | null> => ({
  firstName: t.firstName,
  workplace: t.workplaceRaw,
  date: t.shiftDate ? t.shiftDate.toISOString().slice(0, 10) : null,
  startTime: t.startMinutes,
  endTime: t.endMinutes,
  totalWorked: t.totalMinutes,
});

@Injectable()
export class TicketsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly boss: PgBoss,
    private readonly storage: Storage,
    private readonly config: ReadingConfig,
    private readonly organiser: Organiser,
  ) {}

  /** The ticket, all its flags, the tickets it may duplicate, and links to their scans. */
  async get(id: string) {
    const found = await this.prisma.ticket.findUnique({
      where: { id },
      select: {
        ...TICKET,
        s3KeyPage: true,
        suggestions: true,
        flags: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            code: true,
            field: true,
            detail: true,
            relatedTicketId: true,
            resolvedAt: true,
            resolution: true,
          },
        },
      },
    });
    if (!found) throw new NotFoundException('There is no such ticket.');
    const { s3KeyPage, ...ticket } = found;
    const relatedIds = ticket.flags
      .filter((f) => f.code === 'POSSIBLE_DUPLICATE' && f.relatedTicketId)
      .map((f) => f.relatedTicketId!);
    const related = await this.prisma.ticket.findMany({
      where: { id: { in: [...new Set(relatedIds)] } },
      select: { ...TICKET, s3KeyPage: true },
    });
    return {
      ...ticket,
      imageUrl: await this.storage.signGet(s3KeyPage),
      related: await Promise.all(
        related.map(async ({ s3KeyPage, ...r }) => ({
          ...r,
          imageUrl: await this.storage.signGet(s3KeyPage),
        })),
      ),
    };
  }

  async list(q: z.output<typeof listTicketsSchema>) {
    const where: Prisma.TicketWhereInput = {
      ...(q.month && { monthId: q.month === 'none' ? null : q.month }),
      ...(q.status && { status: q.status }),
      ...(q.flag && { flags: { some: { code: q.flag, resolvedAt: null } } }),
    };
    const [total, tickets] = await Promise.all([
      this.prisma.ticket.count({ where }),
      this.prisma.ticket.findMany({
        where,
        orderBy: [{ createdAt: 'asc' }, { pageIndex: 'asc' }],
        skip: (q.page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        select: {
          ...TICKET,
          flags: { where: { resolvedAt: null }, select: { code: true, field: true } },
        },
      }),
    ]);
    return { total, tickets };
  }

  /** Each upload still held, newest first, with its tickets counted by status (section 8). */
  async progress() {
    const [uploads, counts] = await Promise.all([
      this.prisma.upload.findMany({ orderBy: { createdAt: 'desc' } }),
      this.prisma.ticket.groupBy({ by: ['uploadId', 'status'], _count: { _all: true } }),
    ]);
    return uploads.map((u) => ({
      id: u.id,
      filename: u.originalFilename,
      createdAt: u.createdAt,
      pages: u.pageCount,
      splitting: u.s3KeyOriginal !== null,
      failedPages: u.failedPages,
      tickets: Object.fromEntries(
        Object.values(TicketStatus).map((s) => [
          s,
          counts.find((c) => c.uploadId === u.id && c.status === s)?._count._all ?? 0,
        ]),
      ),
    }));
  }

  /**
   * Saves a person's values. A doubt about the reading is settled by the save; the rule checks
   * run again on the new values, and a flag the person confirms as written (`accept`) is kept as
   * answered. The questions about the month are asked again when what they are about changed.
   */
  async save(userId: string, id: string, body: z.output<typeof saveTicketSchema>) {
    const months = await this.prisma.$transaction(async (tx) => {
      const checked = checkTicketValues(body.values, this.config.settings());
      const fields = checked.fields;
      const workerName = body.workerName === null ? null : englishName(body.workerName);
      const accepted = new Set<string>(body.accept);
      const flags: Flag[] = [...checked.flags];
      // Without it the ticket has no Excel row (5.2).
      if (!workerName) {
        flags.push({
          code: 'NAME_NOT_CONFIRMED',
          field: 'firstName',
          detail: { written: fields.firstName },
        });
      }
      // 6c: only a date nothing is open about joins its month.
      const dateSettled =
        fields.shiftDate !== null &&
        !flags.some((f) => f.field === 'date' && !accepted.has(f.code));
      const target = dateSettled ? await monthOf(tx, new Date(fields.shiftDate!)) : null;
      const t = await this.locked(tx, id, body.version, target?.id);
      // Only a warning the person was shown can be confirmed: a new one waits for the next save.
      if (body.accept.some((code) => !t.flags.some((f) => f.code === code))) {
        throw new BadRequestException(
          'Check the ticket again: something you confirmed was not flagged.',
        );
      }

      let monthId: string | null = null;
      if (target) {
        const month = await tx.month.findUniqueOrThrow({ where: { id: target.id } });
        if (month.status === 'open') monthId = month.id;
        else {
          flags.push({
            code: 'MONTH_CLOSED',
            field: 'date',
            detail: { year: month.year, month: month.month },
          });
        }
      }

      const before = stored(t);
      const after: Record<FieldKey, string | number | null> = {
        firstName: fields.firstName,
        workplace: fields.workplace,
        date: fields.shiftDate,
        startTime: fields.startMinutes,
        endTime: fields.endMinutes,
        totalWorked: fields.totalMinutes,
      };
      const changed = FIELD_KEYS.filter((k) => before[k] !== after[k]);
      const nameChanged = workerName !== t.workerName;
      const monthChanged = monthId !== t.monthId;
      // "Keep both" was answered about the old values: the pair is asked again (flags more).
      const keptBoth =
        changed.length > 0 || nameChanged
          ? (await tx.flag.deleteMany({ where: keptBothAbout(id) })).count
          : 0;
      // What the questions are about: the workplace, the month, the day and the name (5.2, 5.3);
      // a ticket not grouped yet has not been asked about at all.
      const mayAsk =
        monthChanged ||
        nameChanged ||
        keptBoth > 0 ||
        (monthId !== null && t.workplaceGroupId === null) ||
        changed.some((k) => k === 'firstName' || k === 'workplace' || k === 'date');

      const at = { resolvedAt: new Date(), resolvedById: userId };
      const close = (ids: string[], resolution: string) =>
        ids.length > 0
          ? tx.flag.updateMany({ where: { id: { in: ids } }, data: { ...at, resolution } })
          : null;
      const reading = t.flags.filter((f) => READING_FLAGS.includes(f.code));
      const wasChanged = (field: string | null) =>
        field ? changed.includes(field as FieldKey) : changed.length > 0;
      await close(
        reading.filter((f) => wasChanged(f.field)).map((f) => f.id),
        'changed',
      );
      await close(
        reading.filter((f) => !wasChanged(f.field)).map((f) => f.id),
        'confirmed',
      );
      // An earlier "as written" was for earlier values: every rule check starts again.
      await close(
        t.flags.filter((f) => isRuleFlag(f.code)).map((f) => f.id),
        'changed',
      );
      const voided = t.flags.filter((f) => f.code === 'VOIDED_TICKET');
      if (accepted.has('VOIDED_TICKET')) {
        await close(
          voided.map((f) => f.id),
          'accepted',
        );
      }
      if (mayAsk) {
        // Deleted, not answered: the organiser asks again about the new values.
        await tx.flag.deleteMany({
          where: {
            resolvedAt: null,
            code: { in: QUESTIONS },
            OR: [{ ticketId: id }, { relatedTicketId: id }],
          },
        });
      }
      await tx.flag.createMany({
        data: flags.map((f) => ({
          ticketId: id,
          code: f.code,
          field: f.field ?? null,
          detail: (f.detail ?? {}) as Prisma.InputJsonValue,
          ...(accepted.has(f.code) && { ...at, resolution: 'accepted' }),
        })),
      });

      const stillOpen =
        (voided.length > 0 && !accepted.has('VOIDED_TICKET')) ||
        flags.some((f) => !accepted.has(f.code));
      const questionsOpen = !mayAsk && t.flags.some((f) => QUESTIONS.includes(f.code));
      // A save that may raise new questions waits for the organiser; it then turns verified.
      const status = stillOpen || questionsOpen || mayAsk ? 'needs_review' : 'verified';
      const typedIn =
        (await tx.flag.count({ where: { ticketId: id, code: 'EXTRACTION_ERROR' } })) > 0;
      await this.write(tx, id, body.version, {
        monthId,
        firstName: fields.firstName,
        workerName,
        workplaceRaw: fields.workplace,
        shiftDate: fields.shiftDate ? new Date(fields.shiftDate) : null,
        startMinutes: fields.startMinutes,
        endMinutes: fields.endMinutes,
        totalMinutes: fields.totalMinutes,
        totalFromMath: t.totalFromMath && !changed.includes('totalWorked'),
        ...((monthChanged || changed.includes('workplace')) && { workplaceGroupId: null }),
        status,
        verifiedHow: stillOpen
          ? null
          : typedIn
            ? 'manual'
            : changed.length > 0 || nameChanged
              ? 'corrected'
              : 'confirmed',
      });

      // Every confirmed name joins the names list, with its Hebrew spelling (5.4).
      if (workerName) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('names'))`;
        // "Mary Ann" is the list's "Mary-Ann": compared as the reader compares names (5.1).
        const entry =
          (await tx.listEntry.findMany({ where: { kind: 'name' } })).find(
            (e) => normaliseName(e.name) === normaliseName(workerName),
          ) ?? (await tx.listEntry.create({ data: { kind: 'name', name: workerName } }));
        const written = fields.firstName;
        if (written && hasHebrew(written)) {
          if (!entry.spellings.some((s) => normaliseName(s) === normaliseName(written))) {
            await tx.listEntry.update({
              where: { id: entry.id },
              data: { spellings: { push: written } },
            });
          }
        }
      }

      const auditMonth = monthId ?? t.monthId;
      const pick = (v: Record<FieldKey, string | number | null>, name: string | null) => ({
        ...Object.fromEntries(changed.map((k) => [k, v[k]])),
        ...(nameChanged && { workerName: name }),
      });
      const keys = [...changed, ...(nameChanged ? ['workerName'] : [])];
      await audit(tx, {
        userId,
        action: 'save-ticket',
        entity: 'Ticket',
        entityId: id,
        ...(auditMonth && { monthId: auditMonth }),
        // Without a month the entry would outlive the values' purge (6.4): it names the boxes only.
        before: auditMonth
          ? { status: t.status, ...pick(before, t.workerName) }
          : { status: t.status },
        after: {
          status,
          ...(auditMonth ? pick(after, workerName) : { changed: keys }),
          accepted: [...accepted],
        },
      });
      return [...new Set([monthId, t.monthId])].filter((m) => m !== null);
    });
    for (const m of months) await this.organiser.organise(m);
    return this.get(id);
  }

  /** Removes a ticket from the month (6.1): it leaves the Excel and the workplace PDF. */
  async exclude(userId: string, id: string, version: number) {
    const monthId = await this.prisma.$transaction(async (tx) => {
      const t = await this.locked(tx, id, version);
      await this.write(tx, id, version, {
        status: 'excluded',
        excludedReason: 'removed',
        excludedById: userId,
      });
      // Its questions, and the duplicate questions other tickets have about it, need no answer.
      await tx.flag.updateMany({
        where: { resolvedAt: null, OR: [{ ticketId: id }, { relatedTicketId: id }] },
        data: { resolvedAt: new Date(), resolvedById: userId, resolution: 'ticket_removed' },
      });
      await audit(tx, {
        userId,
        action: 'exclude-ticket',
        entity: 'Ticket',
        entityId: id,
        ...(t.monthId && { monthId: t.monthId }),
        before: { status: t.status },
        after: { status: 'excluded' },
      });
      return t.monthId;
    });
    if (monthId) await this.organiser.organise(monthId);
  }

  /**
   * Reads a ticket again from its scan, straight away (section 8). Everything the reader set is
   * set again; answered questions stay, except "keep both", which is asked again.
   */
  async reprocess(userId: string, id: string, version: number) {
    const monthId = await this.prisma.$transaction(async (tx) => {
      const found = await tx.ticket.findUnique({ where: { id }, select: { uploadId: true } });
      if (!found) throw new NotFoundException('There is no such ticket.');
      // One reading job per upload at a time: two reprocesses at once would start two.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`upload:${found.uploadId}`}))`;
      const t = await this.locked(tx, id, version);
      const reading = await tx.ticket.count({
        where: { uploadId: t.uploadId, status: 'processing' },
      });
      if (reading > 0) {
        throw new ConflictException('This upload is still being read. Try again when it finishes.');
      }
      await tx.flag.deleteMany({
        where: { resolvedAt: null, OR: [{ ticketId: id }, { relatedTicketId: id }] },
      });
      await tx.flag.deleteMany({ where: keptBothAbout(id) });
      await this.write(tx, id, version, {
        status: 'processing',
        monthId: null,
        workplaceGroupId: null,
        verifiedHow: null,
        readRound: { increment: 1 },
      });
      // shortcut: an older reading job of this upload that pg-boss retries at this moment could
      // read the ticket too (one reading paid twice, saved once); rare, so not built around. A
      // job that used up its retries leaves tickets processing, which blocks reading any ticket of
      // that upload again until it is fixed by hand (Phase 4 hardening).
      await this.boss.send(
        READ_UPLOAD,
        { uploadId: t.uploadId, speed: 'now' },
        { db: fromPrisma(tx) },
      );
      await audit(tx, {
        userId,
        action: 'reprocess-ticket',
        entity: 'Ticket',
        entityId: id,
        ...(t.monthId && { monthId: t.monthId }),
        before: { status: t.status },
        after: { status: 'processing' },
      });
      return t.monthId;
    });
    // Its duplicate questions went with it: the other tickets may be verified again.
    if (monthId) await this.organiser.organise(monthId);
  }

  /**
   * The ticket under its months' locks (no organiser runs meanwhile), with its open flags. Refuses
   * a removed ticket, one being read, one in a month that is not open, and a stale version.
   */
  private async locked(tx: Tx, id: string, version: number, alsoMonth?: string) {
    const first = await tx.ticket.findUnique({ where: { id }, select: { monthId: true } });
    if (!first) throw new NotFoundException('There is no such ticket.');
    const months = [first.monthId, alsoMonth ?? null].filter((m) => m !== null);
    // Always in the same order, so two saves cannot wait for each other.
    for (const m of [...new Set(months)].sort()) await lockMonth(tx, m);
    const t = await tx.ticket.findUniqueOrThrow({
      where: { id },
      include: { month: true, flags: { where: { resolvedAt: null } } },
    });
    if (t.status === 'excluded') throw new ConflictException('This ticket was removed.');
    if (t.status === 'processing') throw new ConflictException('This ticket is still being read.');
    if (t.month && t.month.status !== 'open')
      throw new ConflictException('This month is being closed or is closed.');
    if (t.version !== version) throw new ConflictException(STALE);
    return t;
  }

  /** Writes only if nobody changed the ticket since it was read; otherwise nothing is kept. */
  private async write(
    tx: Tx,
    id: string,
    version: number,
    data: Prisma.TicketUncheckedUpdateManyInput,
  ) {
    const done = await tx.ticket.updateMany({
      where: { id, version },
      data: { ...data, version: { increment: 1 } },
    });
    if (done.count === 0) throw new ConflictException(STALE);
  }
}
