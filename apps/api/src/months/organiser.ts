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
const HEBREW = /[\u0590-\u05FF]/;
/**
 * A big month's organising takes longer than Prisma's default 5 seconds; whatever waits for a
 * month's lock must wait as long.
 */
export const LONG = { timeout: 120_000, maxWait: 60_000 };

/**
 * One organiser or answer per month at a time: two uploads finishing together, or an answer
 * while an upload is organised, must not interleave (a ticket could join a group as it is merged).
 */
export const lockMonth = (tx: Tx, monthId: string) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${monthId}))`;

/** One change at a time to the names list or the workplace list (5.4): none is lost. */
export const lockList = (tx: Tx, list: 'names' | 'workplaces') =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${list}))`;

/** A worker's row: names compared as rows are (5.2), in the hours and on the names sheet. */
export const rowKey = (name: string) => name.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * A workplace typed as a list spelling ("Beit Hadar") is stored under its list name, as a read
 * one is (D36, D53), so it joins that place. A spelling two places share stays as typed.
 */
export async function listPlace(tx: Tx, written: string | null) {
  if (written === null) return null;
  const key = normaliseName(written);
  const places = new Set(
    (await tx.listEntry.findMany({ where: { kind: 'workplace' } }))
      .filter((e) => [e.name, ...e.spellings].some((s) => normaliseName(s) === key))
      .map((e) => e.name),
  );
  return places.size === 1 ? [...places][0]! : written;
}

/** The group a group was merged into, following merges to the end. */
async function topGroup(tx: Tx, id: string) {
  let group = await tx.workplaceGroup.findUniqueOrThrow({ where: { id } });
  while (group.mergedIntoId) {
    group = await tx.workplaceGroup.findUniqueOrThrow({ where: { id: group.mergedIntoId } });
  }
  return group;
}

/** Each group's final group, following merges, from all of a month's groups read at once. */
export function finalGroups(groups: { id: string; mergedIntoId: string | null }[]) {
  const byId = new Map(groups.map((g) => [g.id, g.mergedIntoId]));
  const top = (id: string): string => {
    const next = byId.get(id);
    return next ? top(next) : id;
  };
  return top;
}

@Injectable()
export class Organiser {
  constructor(private readonly prisma: PrismaClient) {}

  async organise(monthId: string) {
    await this.prisma.$transaction(async (tx) => {
      await lockMonth(tx, monthId);
      const month = await tx.month.findUniqueOrThrow({ where: { id: monthId } });
      if (month.status !== 'open') return; // a month being deleted gets nothing new
      await this.group(tx, monthId);
      await this.askSamePlace(tx, monthId);
      await this.askDuplicates(tx, monthId);
      // A saved ticket waits here until its questions are asked; or a question went away with a save.
      await this.backToVerified(tx, monthId);
    }, LONG);
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
    const all = await tx.workplaceGroup.findMany({
      where: { monthId },
      include: { _count: { select: { tickets: { where: { status: { not: 'excluded' } } } } } },
    });
    const top = finalGroups(all);
    const unmerged = all.filter((g) => g.mergedIntoId === null);
    const groups = unmerged.filter((g) => g._count.tickets > 0);
    // A place whose tickets were all corrected, removed or read again is no longer asked about,
    // nor are two places a person already made one (a question stored before T2.4's fix).
    const empty = new Set(unmerged.filter((g) => g._count.tickets === 0).map((g) => g.id));
    const stale = (
      await tx.flag.findMany({
        where: { code: 'WORKPLACE_SIMILAR', resolvedAt: null, ticket: { monthId } },
      })
    ).filter((f) => {
      const ids = (f.detail as { groups: string[] }).groups;
      return ids.some((id) => empty.has(id)) || top(ids[0]!) === top(ids[1]!);
    });
    await tx.flag.deleteMany({ where: { id: { in: stale.map((f) => f.id) } } });
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
    await this.prisma.$transaction(async (tx) => {
      const found = await tx.flag.findUnique({ where: { id: flagId }, include: { ticket: true } });
      if (!found) throw new NotFoundException('There is no such question.');
      if (!found.ticket.monthId) throw new ConflictException('This ticket is in no month yet.');
      await lockMonth(tx, found.ticket.monthId);
      // Read again under the lock: the question may have been answered meanwhile.
      const flag = await tx.flag.findUnique({
        where: { id: flagId },
        include: { ticket: { include: { month: true } } },
      });
      // A save changed what it was about, and the question went (or was asked anew).
      if (!flag) throw new ConflictException('This question changed. Reload the page.');
      if (flag.resolvedAt) throw new ConflictException('This question was already answered.');
      const month = flag.ticket.month;
      if (!month || month.status !== 'open') throw new ConflictException('This month is closed.');
      const at = { resolvedAt: new Date(), resolvedById: userId, resolution: decision };
      let merged: Awaited<ReturnType<typeof this.merge>> = null;

      if (flag.code === 'WORKPLACE_SIMILAR') {
        if (decision !== 'same_place' && decision !== 'different_place')
          throw new BadRequestException('Answer "same place" or "different place".');
        const groups = (flag.detail as { groups: string[] }).groups;
        // Every question about the same two places, as they are after earlier merges: once b
        // joined a, "b or c" and "a or c" are one question with one answer.
        const top = finalGroups(await tx.workplaceGroup.findMany({ where: { monthId: month.id } }));
        const pair = (ids: string[]) => pairKey(top(ids[0]!), top(ids[1]!)).join();
        const same = (
          await tx.flag.findMany({
            where: { code: 'WORKPLACE_SIMILAR', resolvedAt: null, ticket: { monthId: month.id } },
            select: { id: true, detail: true },
          })
        ).filter((f) => pair((f.detail as { groups: string[] }).groups) === pair(groups));
        const answered = await tx.flag.updateMany({
          where: { id: { in: same.map((f) => f.id) }, resolvedAt: null },
          data: at,
        });
        // Two answers at once: the second finds the question already answered.
        if (answered.count === 0)
          throw new ConflictException('This question was already answered.');
        if (decision === 'same_place') {
          // The person chooses the name the place keeps (5.3); the system does not pick one.
          if (!keepGroupId) throw new BadRequestException('Choose which name the place keeps.');
          merged = await this.merge(tx, groups, keepGroupId);
        }
      } else if (flag.code === 'POSSIBLE_DUPLICATE') {
        if (!['replace', 'keep_both', 'ignore'].includes(decision))
          throw new BadRequestException('Answer "replace", "keep both" or "ignore".');
        const pair = await tx.ticket.findMany({
          where: { id: { in: [flag.ticketId, flag.relatedTicketId!] } },
          orderBy: [{ createdAt: 'asc' }, { pageIndex: 'asc' }, { id: 'asc' }],
        });
        const [older, newer] = pair;
        if (!older || !newer) throw new ConflictException('One of the two tickets is gone.');
        // A removed ticket cannot replace or be replaced: that could leave the shift with none.
        if (older.status === 'excluded' || newer.status === 'excluded') {
          throw new ConflictException('One of the two tickets was already removed.');
        }
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
        const removed = decision === 'replace' ? older : decision === 'ignore' ? newer : null;
        if (removed) {
          await tx.ticket.update({
            where: { id: removed.id },
            data: {
              status: 'excluded',
              excludedReason: decision === 'replace' ? 'replaced' : 'duplicate',
              excludedById: userId,
              replacedById: decision === 'replace' ? newer.id : null,
            },
          });
          // Other duplicate questions about the removed ticket no longer need an answer.
          await tx.flag.updateMany({
            where: {
              code: 'POSSIBLE_DUPLICATE',
              resolvedAt: null,
              OR: [{ ticketId: removed.id }, { relatedTicketId: removed.id }],
            },
            data: { ...at, resolution: 'ticket_removed' },
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
        after: {
          code: flag.code,
          decision,
          // Which name the place kept (5.3): the places the two ended in, as they were merged.
          ...(decision === 'same_place' && {
            groups: (flag.detail as { groups: string[] }).groups,
            keepGroupId: keepGroupId!,
            ...(merged && {
              kept: { id: merged.keep.id, name: merged.keep.displayName },
              merged: { id: merged.other.id, name: merged.other.displayName },
            }),
          }),
        },
      });
      // A merge can bring two tickets of one name into one group: ask about them in this same
      // transaction, so no ticket is verified without the question (all or nothing).
      await this.askSamePlace(tx, month.id);
      await this.askDuplicates(tx, month.id);
      await this.backToVerified(tx, month.id);
    }, LONG);
  }

  /** "Same place": one group, with the other spelling added to the workplace list (Liam, 1A). */
  private async merge(tx: Tx, groups: string[], keepId: string) {
    if (!groups.includes(keepId)) throw new BadRequestException('Choose one of the two names.');
    // Either group may already have been merged into a third: merge the groups they ended in.
    const keep = await topGroup(tx, keepId);
    const other = await topGroup(
      tx,
      groups.find((g) => g !== keepId)!,
    );
    if (keep.id === other.id) return null;
    // A workplace list replaced meanwhile would otherwise lose the spelling added here.
    await lockList(tx, 'workplaces');
    await tx.workplaceGroup.update({ where: { id: other.id }, data: { mergedIntoId: keep.id } });
    await tx.ticket.updateMany({
      where: { workplaceGroupId: other.id },
      data: { workplaceGroupId: keep.id },
    });
    // The entry holding either name gets the missing one. A name already on the list (for any
    // place) is left alone: one spelling, one place.
    const holding = (name: string) =>
      tx.listEntry.findFirst({
        where: { kind: 'workplace', OR: [{ name }, { spellings: { has: name } }] },
      });
    const [keepEntry, otherEntry] = [
      await holding(keep.displayName),
      await holding(other.displayName),
    ];
    if (keepEntry && otherEntry) return { keep, other };
    const entry = keepEntry ?? otherEntry;
    if (entry) {
      const missing = keepEntry ? other.displayName : keep.displayName;
      await tx.listEntry.update({
        where: { id: entry.id },
        data: { spellings: { push: missing } },
      });
    } else {
      // Named by the Hebrew spelling (D36), as parseList names it, so editing the list keeps it.
      const [name, spelling] =
        HEBREW.test(keep.displayName) || !HEBREW.test(other.displayName)
          ? [keep.displayName, other.displayName]
          : [other.displayName, keep.displayName];
      await tx.listEntry.create({ data: { kind: 'workplace', name, spellings: [spelling] } });
    }
    return { keep, other };
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
