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
  type RawTicketValues,
  type listTicketsSchema,
  type saveFreeFormSchema,
  type saveTicketSchema,
  checkTicketValues,
  englishName,
  formatMinutes,
  hasHebrew,
  normaliseName,
  shiftHours,
  TEMPLATE_V1,
} from '@tally/shared';
import { prepareTicket } from '@tally/shared/imaging';
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
import { Organiser, listPlace, lockMonth } from '../months/organiser.ts';
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
const OTHER_TICKET = 'This is another ticket, not a Tally ticket: type it in with its own form.';
/** Boxes another ticket's form does not have (D68). */
const NOT_ON_OTHER_TICKETS: string[] = ['firstName', 'startTime', 'endTime'];
/** Saving every shift of a scan can take longer than Prisma's 5 seconds. */
const LONG = { timeout: 120_000, maxWait: 60_000 };
/** One save or removal of a scan's shifts at a time (D68); taken before any month's lock. */
const lockScan = (tx: Tx, t: { uploadId: string; pageIndex: number }) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`scan:${t.uploadId}:${t.pageIndex}`}))`;
const PAGE_SIZE = 50;

const TICKET = {
  id: true,
  uploadId: true,
  monthId: true,
  pageIndex: true,
  shiftIndex: true,
  freeForm: true,
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
  rate57: true,
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
    // Another ticket (D68): every shift typed from the same scan, so any of them opens the form.
    const shifts = ticket.freeForm
      ? await this.prisma.ticket.findMany({
          where: { uploadId: ticket.uploadId, pageIndex: ticket.pageIndex },
          orderBy: { shiftIndex: 'asc' },
          select: {
            ...TICKET,
            month: { select: { status: true } },
            flags: {
              where: { resolvedAt: null },
              orderBy: { createdAt: 'asc' },
              select: { id: true, code: true, field: true, detail: true, relatedTicketId: true },
            },
          },
        })
      : [];
    // Another ticket's shifts each have their own duplicate questions (D68).
    const relatedIds = [...ticket.flags, ...shifts.flatMap((t) => t.flags)]
      .filter((f) => f.code === 'POSSIBLE_DUPLICATE' && f.relatedTicketId)
      .map((f) => f.relatedTicketId!);
    const related = await this.prisma.ticket.findMany({
      where: { id: { in: [...new Set(relatedIds)] } },
      select: { ...TICKET, s3KeyPage: true },
    });
    return {
      ...ticket,
      shifts: shifts.map(({ month, ...t }) => ({
        ...t,
        // Removed, or in a month being closed: shown, never changed by the form.
        readOnly: t.status === 'excluded' || (month !== null && month.status !== 'open'),
      })),
      imageUrl: await this.storage.signGet(s3KeyPage),
      related: await Promise.all(
        related.map(async ({ s3KeyPage, ...r }) => ({
          ...r,
          imageUrl: await this.storage.signGet(s3KeyPage),
        })),
      ),
    };
  }

  /**
   * The scan straightened as the reader saw it, made again on each request: it is not stored (D42).
   * 404 when the corner markers are not found; the screen then shows the whole scan.
   */
  async slip(id: string) {
    const t = await this.prisma.ticket.findUnique({ where: { id }, select: { s3KeyPage: true } });
    if (!t) throw new NotFoundException('There is no such ticket.');
    const page = await this.storage.get(t.s3KeyPage);
    if (!page) throw new NotFoundException('The scan of this ticket is missing.');
    const image = Buffer.concat(await page.body.toArray());
    const prepared = await prepareTicket(image, TEMPLATE_V1, { crops: false });
    if (!prepared.markersFound)
      throw new NotFoundException('The corner markers were not found on this scan.');
    return prepared.ticket.data;
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

  /**
   * Each upload still held, newest first, with its tickets counted by status (section 8), and
   * when it last moved (`activeAt`): a ticket sent to be read again makes an old upload active.
   */
  async progress() {
    const [uploads, counts, reading] = await Promise.all([
      this.prisma.upload.findMany({ orderBy: { createdAt: 'desc' } }),
      // One per page: another ticket's later shifts are not pages of the upload (D68).
      // shortcut: a page whose first shift was removed, or closed with its month, is no longer
      // counted; display only. Count distinct pages if it confuses anyone.
      this.prisma.ticket.groupBy({
        by: ['uploadId', 'status'],
        where: { shiftIndex: 0 },
        _count: { _all: true },
      }),
      this.prisma.ticket.groupBy({
        by: ['uploadId'],
        where: { status: 'processing' },
        _max: { updatedAt: true },
      }),
    ]);
    return uploads.map((u) => {
      const ticketAt = reading.find((r) => r.uploadId === u.id)?._max.updatedAt;
      return {
        id: u.id,
        filename: u.originalFilename,
        createdAt: u.createdAt,
        activeAt: ticketAt && ticketAt > u.updatedAt ? ticketAt : u.updatedAt,
        pages: u.pageCount,
        splitting: u.s3KeyOriginal !== null,
        failedPages: u.failedPages,
        tickets: Object.fromEntries(
          Object.values(TicketStatus).map((s) => [
            s,
            counts.find((c) => c.uploadId === u.id && c.status === s)?._count._all ?? 0,
          ]),
        ),
      };
    });
  }

  /**
   * Saves a person's values. A doubt about the reading is settled by the save; the rule checks
   * run again on the new values, and a flag the person confirms as written (`accept`) is kept as
   * answered. The questions about the month are asked again when what they are about changed.
   */
  async save(userId: string, id: string, body: z.output<typeof saveTicketSchema>) {
    const months = await this.prisma.$transaction(async (tx) => {
      const line = await this.prepare(tx, body.values, body.workerName, body.accept, false);
      const t = await this.locked(tx, id, body.version, line.target?.id);
      if (t.freeForm) throw new BadRequestException(OTHER_TICKET);
      return this.apply(tx, userId, t, body.version, line, body.rate57, false);
    });
    for (const m of months) await this.organiser.organise(m);
    return this.get(id);
  }

  /**
   * Saves another ticket (D68): each shift is a ticket of its own with the same scan, so it joins
   * its own month and is checked, grouped and exported like any ticket. The form names every
   * shift it can change, with the version it saw: one added or changed meanwhile is a conflict.
   */
  async saveFreeForm(userId: string, id: string, body: z.output<typeof saveFreeFormSchema>) {
    const done = await this.prisma.$transaction(async (tx) => {
      const scan = await tx.ticket.findUnique({ where: { id } });
      if (!scan) throw new NotFoundException('There is no such ticket.');
      if (!scan.freeForm) {
        throw new BadRequestException('This is a Tally ticket: check it with the ticket form.');
      }
      const lines = [];
      for (const s of body.shifts) {
        const values = {
          firstName: null,
          workplace: body.workplace,
          date: s.date,
          startTime: null,
          endTime: null,
          totalWorked: formatMinutes(shiftHours(s.hours)!),
        };
        lines.push(await this.prepare(tx, values, body.workerName, s.accept, true));
      }
      await lockScan(tx, scan);
      const where = { uploadId: scan.uploadId, pageIndex: scan.pageIndex };
      const before = await tx.ticket.findMany({ where, select: { monthId: true } });
      const locks = new Set(
        [...before.map((t) => t.monthId), ...lines.map((l) => l.target?.id ?? null)].filter(
          (m) => m !== null,
        ),
      );
      // Always in the same order, so two saves cannot wait for each other.
      for (const m of [...locks].sort()) await lockMonth(tx, m);
      const shifts = await tx.ticket.findMany({
        where,
        include: { month: true, flags: { where: { resolvedAt: null } } },
        orderBy: { shiftIndex: 'asc' },
      });
      // Gone, or a shift that joined a month not locked here: it changed before the locks.
      if (shifts.length === 0 || shifts.some((t) => t.monthId !== null && !locks.has(t.monthId))) {
        throw new ConflictException(STALE);
      }
      const open = shifts.filter(
        (t) => t.status !== 'excluded' && (t.month === null || t.month.status === 'open'),
      );
      const named = [
        ...body.shifts.flatMap((s) => (s.id ? [{ id: s.id, version: s.version! }] : [])),
        ...body.remove,
      ];
      const seen = (n: { id: string; version: number }) =>
        open.some((t) => t.id === n.id && t.version === n.version);
      if (
        named.length !== open.length ||
        new Set(named.map((n) => n.id)).size !== named.length ||
        !named.every(seen)
      ) {
        throw new ConflictException(STALE);
      }

      const months = new Set<string>();
      for (const r of body.remove) {
        const t = open.find((o) => o.id === r.id)!;
        // The ticket it replaced is removed because of it: those hours would be lost.
        if ((await tx.ticket.count({ where: { replacedById: t.id } })) > 0) {
          throw new BadRequestException(
            'A shift that replaced a duplicate ticket cannot be removed. Change it instead.',
          );
        }
        // Its questions go with it, on both sides; the organiser asks the others again.
        await tx.flag.deleteMany({
          where: { code: { in: QUESTIONS }, OR: [{ ticketId: t.id }, { relatedTicketId: t.id }] },
        });
        await tx.auditEntry.deleteMany({ where: { entity: 'Ticket', entityId: t.id } });
        await tx.ticket.delete({ where: { id: t.id } });
        if (t.monthId) {
          // It leaves no row behind: Close there asks for new files (D66).
          await tx.month.update({ where: { id: t.monthId }, data: { lastActivityAt: new Date() } });
          months.add(t.monthId);
        }
      }
      let next = Math.max(...shifts.map((t) => t.shiftIndex)) + 1;
      const saved: string[] = [];
      for (const [i, s] of body.shifts.entries()) {
        const t =
          open.find((o) => o.id === s.id) ??
          (await tx.ticket.create({
            data: {
              ...where,
              shiftIndex: next++,
              s3KeyPage: scan.s3KeyPage,
              freeForm: true,
              status: 'needs_manual_entry',
            },
            include: { month: true, flags: { where: { resolvedAt: null } } },
          }));
        for (const m of await this.apply(tx, userId, t, t.version, lines[i]!, body.rate57, true)) {
          months.add(m);
        }
        saved.push(t.id);
      }
      if (body.remove.length > 0) {
        // Under a shift that stays, so it is deleted with it (6.4).
        await audit(tx, {
          userId,
          action: 'remove-shifts',
          entity: 'Ticket',
          entityId: saved[0]!,
          before: { shifts: open.length },
          after: { shifts: body.shifts.length },
        });
      }
      return { months: [...months], first: saved[0]! };
    }, LONG);
    for (const m of done.months) await this.organiser.organise(m);
    return this.get(done.first);
  }

  /**
   * The checks on a person's values, and the month the date puts them in. Done before any month
   * is locked: finding a new month takes the new-month lock, which comes first everywhere.
   */
  private async prepare(
    tx: Tx,
    values: RawTicketValues,
    name: string | null,
    accept: readonly string[],
    freeForm: boolean,
  ) {
    const checked = checkTicketValues(values, this.config.settings());
    const fields = {
      ...checked.fields,
      workplace: await listPlace(tx, checked.fields.workplace),
    };
    const workerName = name === null ? null : englishName(name);
    const accepted = new Set<string>(accept);
    // Another ticket has no first-name box and no start or end time (D68).
    const flags: Flag[] = checked.flags.filter(
      (f) => !(freeForm && f.code === 'FIELD_EMPTY' && NOT_ON_OTHER_TICKETS.includes(f.field!)),
    );
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
      fields.shiftDate !== null && !flags.some((f) => f.field === 'date' && !accepted.has(f.code));
    const target = dateSettled ? await monthOf(tx, new Date(fields.shiftDate!)) : null;
    return { fields, workerName, accepted, flags, target };
  }

  /**
   * Saves one ticket's checked values under its months' locks. A doubt about the reading is
   * settled by the save; a flag the person confirms as written is kept as answered. Gives the
   * months to organise.
   */
  private async apply(
    tx: Tx,
    userId: string,
    t: Awaited<ReturnType<typeof this.locked>>,
    version: number,
    line: Awaited<ReturnType<typeof this.prepare>>,
    rate57: boolean,
    typed: boolean,
  ) {
    const { fields, workerName, accepted, flags, target } = line;
    const id = t.id;
    // Only a warning the person was shown can be confirmed: a new one waits for the next save.
    // `t.flags` are the open ones: a warning already answered cannot be confirmed again.
    if ([...accepted].some((code) => !t.flags.some((f) => f.code === code && !f.resolvedAt))) {
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
    // Answers about the old month name its places and tickets: they would outlive its purge (6.4).
    if (monthChanged) {
      // The ticket leaves no row behind in its old month: Close there asks for new files (D66).
      if (t.monthId) {
        await tx.month.update({ where: { id: t.monthId }, data: { lastActivityAt: new Date() } });
      }
      await tx.flag.deleteMany({
        where: {
          ticketId: id,
          resolvedAt: { not: null },
          code: { in: QUESTIONS },
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
      typed || (await tx.flag.count({ where: { ticketId: id, code: 'EXTRACTION_ERROR' } })) > 0;
    await this.write(tx, id, version, {
      monthId,
      firstName: fields.firstName,
      workerName,
      workplaceRaw: fields.workplace,
      shiftDate: fields.shiftDate ? new Date(fields.shiftDate) : null,
      startMinutes: fields.startMinutes,
      endMinutes: fields.endMinutes,
      totalMinutes: fields.totalMinutes,
      totalFromMath: t.totalFromMath && !changed.includes('totalWorked'),
      rate57,
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
  }

  /** Removes a ticket from the month (6.1): it leaves the Excel and the workplace PDF. */
  async exclude(userId: string, id: string, version: number) {
    const first = await this.prisma.ticket.findUnique({ where: { id } });
    if (first?.freeForm) return this.excludeScan(userId, first, version);
    const monthId = await this.prisma.$transaction(async (tx) => {
      const t = await this.locked(tx, id, version);
      await this.excludeOne(tx, userId, t, version);
      return t.monthId;
    });
    if (monthId) await this.organiser.organise(monthId);
  }

  /** Another ticket is removed whole (D68): every shift typed from its scan that can change. */
  private async excludeScan(
    userId: string,
    scan: { id: string; uploadId: string; pageIndex: number },
    version: number,
  ) {
    const months = await this.prisma.$transaction(async (tx) => {
      await lockScan(tx, scan);
      const where = { uploadId: scan.uploadId, pageIndex: scan.pageIndex };
      const before = await tx.ticket.findMany({ where, select: { monthId: true } });
      const locks = [...new Set(before.map((t) => t.monthId).filter((m) => m !== null))].sort();
      for (const m of locks) await lockMonth(tx, m);
      const shifts = await tx.ticket.findMany({
        where,
        include: { month: true, flags: { where: { resolvedAt: null } } },
      });
      const asked = shifts.find((t) => t.id === scan.id);
      if (
        !asked ||
        asked.version !== version ||
        shifts.some((t) => t.monthId !== null && !locks.includes(t.monthId))
      ) {
        throw new ConflictException(STALE);
      }
      if (asked.status === 'excluded') throw new ConflictException('This ticket was removed.');
      const open = shifts.filter(
        (t) => t.status !== 'excluded' && (t.month === null || t.month.status === 'open'),
      );
      for (const t of open) await this.excludeOne(tx, userId, t, t.version);
      return [...new Set(open.map((t) => t.monthId).filter((m) => m !== null))];
    }, LONG);
    for (const m of months) await this.organiser.organise(m);
  }

  private async excludeOne(
    tx: Tx,
    userId: string,
    t: { id: string; status: TicketStatus; monthId: string | null },
    version: number,
  ) {
    await this.write(tx, t.id, version, {
      status: 'excluded',
      excludedReason: 'removed',
      excludedById: userId,
    });
    // Its questions, and the duplicate questions other tickets have about it, need no answer.
    await tx.flag.updateMany({
      where: { resolvedAt: null, OR: [{ ticketId: t.id }, { relatedTicketId: t.id }] },
      data: { resolvedAt: new Date(), resolvedById: userId, resolution: 'ticket_removed' },
    });
    await audit(tx, {
      userId,
      action: 'exclude-ticket',
      entity: 'Ticket',
      entityId: t.id,
      ...(t.monthId && { monthId: t.monthId }),
      before: { status: t.status },
      after: { status: 'excluded' },
    });
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
      if (t.freeForm) throw new BadRequestException('Other tickets are not read: type it in.');
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
      // It leaves its month: Close there asks for new files (D66).
      if (t.monthId) {
        await tx.month.update({ where: { id: t.monthId }, data: { lastActivityAt: new Date() } });
      }
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
