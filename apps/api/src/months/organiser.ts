// Sections 5.2 and 5.3, for one month: group tickets by workplace, and ask the questions only a
// person can answer — is this the same place (WORKPLACE_SIMILAR), are these the same ticket
// (POSSIBLE_DUPLICATE). The system never answers them itself. Safe to run any number of times.
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  type DuplicateCandidate,
  findPossibleDuplicates,
  findSimilarWorkplaces,
  normaliseName,
} from '@tally/shared';
import { audit } from '../audit.ts';
import { type Prisma, PrismaClient } from '../generated/prisma/client.ts';

type Tx = Prisma.TransactionClient;
export type Decision = 'same_place' | 'different_place' | 'replace' | 'keep_both' | 'ignore';

/** A workplace is grouped once nothing is in doubt about it except that it is new. */
const WORKPLACE_DOUBTS = [
  'FIELD_UNREADABLE',
  'PASS_DISAGREEMENT',
  'FIELD_EMPTY',
  'MATCH_AMBIGUOUS',
];
const pairKey = (a: string, b: string) => [a, b].sort();

@Injectable()
export class Organiser {
  constructor(private readonly prisma: PrismaClient) {}

  async organise(monthId: string) {
    await this.prisma.$transaction(async (tx) => {
      // One organiser per month at a time: two uploads finishing together must not both add
      // the same group or question.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${monthId}))`;
      await this.group(tx, monthId);
      await this.askSamePlace(tx, monthId);
      await this.askDuplicates(tx, monthId);
    });
  }

  /** Each ticket joins the group of its normalised workplace name, following merges. */
  private async group(tx: Tx, monthId: string) {
    const tickets = await tx.ticket.findMany({
      where: {
        monthId,
        workplaceGroupId: null,
        workplaceRaw: { not: null },
        status: { not: 'excluded' },
      },
      include: { flags: { where: { field: 'workplace', resolvedAt: null } } },
    });
    for (const t of tickets) {
      if (t.flags.some((f) => WORKPLACE_DOUBTS.includes(f.code))) continue;
      const normalisedName = normaliseName(t.workplaceRaw!);
      if (normalisedName === '') continue;
      let group =
        (await tx.workplaceGroup.findFirst({ where: { monthId, normalisedName } })) ??
        (await tx.workplaceGroup.create({
          data: { monthId, normalisedName, displayName: t.workplaceRaw! },
        }));
      while (group.mergedIntoId) {
        group = await tx.workplaceGroup.findUniqueOrThrow({ where: { id: group.mergedIntoId } });
      }
      await tx.ticket.update({ where: { id: t.id }, data: { workplaceGroupId: group.id } });
    }
  }

  /** WORKPLACE_SIMILAR on every ticket of two similar groups, unless already answered. */
  private async askSamePlace(tx: Tx, monthId: string) {
    const groups = await tx.workplaceGroup.findMany({ where: { monthId, mergedIntoId: null } });
    for (const [a, b] of findSimilarWorkplaces(groups)) {
      const groups2 = pairKey(a, b);
      const answered = await tx.flag.findFirst({
        where: {
          code: 'WORKPLACE_SIMILAR',
          resolution: 'different_place',
          detail: { path: ['groups'], equals: groups2 },
        },
      });
      if (answered) continue;
      const names = Object.fromEntries(
        groups.filter((g) => g.id === a || g.id === b).map((g) => [g.id, g.displayName]),
      );
      const tickets = await tx.ticket.findMany({
        where: { workplaceGroupId: { in: groups2 }, status: { not: 'excluded' } },
        include: { flags: { where: { code: 'WORKPLACE_SIMILAR', resolvedAt: null } } },
      });
      for (const t of tickets) {
        const asked = t.flags.some(
          (f) =>
            JSON.stringify((f.detail as { groups?: string[] }).groups) === JSON.stringify(groups2),
        );
        if (!asked) {
          await this.raise(tx, t.id, {
            code: 'WORKPLACE_SIMILAR',
            field: 'workplace',
            detail: { groups: groups2, names: groups2.map((id) => names[id] ?? '') },
          });
        }
      }
    }
  }

  /** POSSIBLE_DUPLICATE on both tickets of a pair, once per pair (5.2). */
  private async askDuplicates(tx: Tx, monthId: string) {
    const tickets = await tx.ticket.findMany({
      where: { monthId, status: { not: 'excluded' } },
      select: {
        id: true,
        workerName: true,
        firstName: true,
        workplaceGroupId: true,
        shiftDate: true,
        startMinutes: true,
        endMinutes: true,
      },
    });
    const candidates: DuplicateCandidate[] = tickets.map((t) => ({
      id: t.id,
      name: t.workerName ?? t.firstName,
      workplaceGroupId: t.workplaceGroupId,
      shiftDate: t.shiftDate ? t.shiftDate.toISOString().slice(0, 10) : null,
      startMinutes: t.startMinutes,
      endMinutes: t.endMinutes,
    }));
    for (const [a, b] of findPossibleDuplicates(candidates)) {
      const asked = await tx.flag.findFirst({
        where: {
          code: 'POSSIBLE_DUPLICATE',
          OR: [
            { ticketId: a, relatedTicketId: b },
            { ticketId: b, relatedTicketId: a },
          ],
        },
      });
      if (asked) continue;
      await this.raise(tx, a, { code: 'POSSIBLE_DUPLICATE', relatedTicketId: b, detail: {} });
      await this.raise(tx, b, { code: 'POSSIBLE_DUPLICATE', relatedTicketId: a, detail: {} });
    }
  }

  /** A new question sends a verified ticket back to a person; it returns once all are answered. */
  private async raise(
    tx: Tx,
    ticketId: string,
    flag: { code: string; field?: string; relatedTicketId?: string; detail: Prisma.InputJsonValue },
  ) {
    await tx.flag.create({ data: { ticketId, ...flag } });
    await tx.ticket.updateMany({
      where: { id: ticketId, status: 'verified' },
      data: { status: 'needs_review' },
    });
  }

  /** Answers a WORKPLACE_SIMILAR or POSSIBLE_DUPLICATE question (5.2, 5.3). */
  async resolve(userId: string, flagId: string, decision: Decision, keepGroupId?: string) {
    const monthId = await this.prisma.$transaction(async (tx) => {
      const flag = await tx.flag.findUnique({
        where: { id: flagId },
        include: { ticket: { include: { month: true } } },
      });
      if (!flag) throw new NotFoundException('There is no such question.');
      if (flag.resolvedAt) throw new ConflictException('This question was already answered.');
      const month = flag.ticket.month;
      if (!month || month.status !== 'open') throw new ConflictException('This month is closed.');
      const at = { resolvedAt: new Date(), resolvedById: userId, resolution: decision };

      if (flag.code === 'WORKPLACE_SIMILAR') {
        if (decision !== 'same_place' && decision !== 'different_place')
          throw new BadRequestException('Answer "same place" or "different place".');
        const groups = (flag.detail as { groups: string[] }).groups;
        const answered = await tx.flag.updateMany({
          where: {
            code: 'WORKPLACE_SIMILAR',
            resolvedAt: null,
            detail: { path: ['groups'], equals: groups },
          },
          data: at,
        });
        // Two answers at once: the second finds the question already answered.
        if (answered.count === 0)
          throw new ConflictException('This question was already answered.');
        if (decision === 'same_place') await this.merge(tx, groups, keepGroupId ?? groups[0]!);
      } else if (flag.code === 'POSSIBLE_DUPLICATE') {
        if (!['replace', 'keep_both', 'ignore'].includes(decision))
          throw new BadRequestException('Answer "replace", "keep both" or "ignore".');
        const pair = await tx.ticket.findMany({
          where: { id: { in: [flag.ticketId, flag.relatedTicketId!] } },
          orderBy: { createdAt: 'asc' },
        });
        const [older, newer] = pair;
        if (!older || !newer) throw new ConflictException('One of the two tickets is gone.');
        const answered = await tx.flag.updateMany({
          where: {
            code: 'POSSIBLE_DUPLICATE',
            resolvedAt: null,
            OR: [
              { ticketId: older.id, relatedTicketId: newer.id },
              { ticketId: newer.id, relatedTicketId: older.id },
            ],
          },
          data: at,
        });
        // Two answers at once: the second finds the question already answered.
        if (answered.count === 0)
          throw new ConflictException('This question was already answered.');
        if (decision === 'replace') {
          await tx.ticket.update({
            where: { id: older.id },
            data: {
              status: 'excluded',
              excludedReason: 'replaced',
              excludedById: userId,
              replacedById: newer.id,
            },
          });
        } else if (decision === 'ignore') {
          await tx.ticket.update({
            where: { id: newer.id },
            data: { status: 'excluded', excludedReason: 'duplicate', excludedById: userId },
          });
        }
      } else {
        throw new BadRequestException('This question is answered by correcting the ticket.');
      }
      await audit(tx, {
        userId,
        monthId: month.id,
        action: 'resolve-flag',
        entity: 'Flag',
        entityId: flag.id,
        after: { code: flag.code, decision },
      });
      await this.backToVerified(tx, month.id);
      return month.id;
    });
    // A merge can bring two tickets of one name into one group: ask about them.
    await this.organise(monthId);
  }

  /** "Same place": one group, with the other spelling added to the workplace list (Liam, 1A). */
  private async merge(tx: Tx, groups: string[], keepId: string) {
    if (!groups.includes(keepId)) throw new BadRequestException('Choose one of the two names.');
    const otherId = groups.find((g) => g !== keepId)!;
    const [keep, other] = await Promise.all([
      tx.workplaceGroup.findUniqueOrThrow({ where: { id: keepId } }),
      tx.workplaceGroup.findUniqueOrThrow({ where: { id: otherId } }),
    ]);
    await tx.workplaceGroup.update({ where: { id: otherId }, data: { mergedIntoId: keepId } });
    await tx.ticket.updateMany({
      where: { workplaceGroupId: otherId },
      data: { workplaceGroupId: keepId },
    });
    const entry = await tx.listEntry.findFirst({
      where: {
        kind: 'workplace',
        OR: [{ name: keep.displayName }, { spellings: { has: keep.displayName } }],
      },
    });
    if (!entry) {
      await tx.listEntry.create({
        data: { kind: 'workplace', name: keep.displayName, spellings: [other.displayName] },
      });
    } else if (entry.name !== other.displayName && !entry.spellings.includes(other.displayName)) {
      await tx.listEntry.update({
        where: { id: entry.id },
        data: { spellings: { push: other.displayName } },
      });
    }
  }

  /** Tickets that were verified before a question, and whose questions are all answered. */
  private async backToVerified(tx: Tx, monthId: string) {
    await tx.ticket.updateMany({
      where: {
        monthId,
        status: 'needs_review',
        verifiedHow: { not: null },
        flags: { none: { resolvedAt: null } },
      },
      data: { status: 'verified' },
    });
  }
}
