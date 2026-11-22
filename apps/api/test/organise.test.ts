// T1.5 "Done when": tickets are grouped by workplace, and the questions only a person can answer
// (same place? same ticket?) are asked once and stay answered (5.2, 5.3). Names are invented.
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { monthOf } from '../src/months/months.service.ts';
import { Organiser } from '../src/months/organiser.ts';
import { createAdmin } from '../src/users/create-admin.ts';
import { Browser } from './helpers/browser.ts';
import { testApp } from './helpers/test-app.ts';
import { databaseUrl, testDatabase } from './helpers/test-db.ts';

const OWNER = { email: 'owner@example.com', password: 'owner password 1' };
const DAY = new Date('2026-11-13');

describe.skipIf(!databaseUrl)('organising a month (T1.5)', () => {
  const db = testDatabase();
  const prisma = db.prisma;
  let app: INestApplication;
  let owner: Browser;
  let base: string;
  let organiser: Organiser;
  let monthId: string;
  let uploadId: string;
  let page = 0;

  beforeAll(async () => {
    await db.migrate();
    await createAdmin(prisma, OWNER.email, OWNER.password);
    ({ app, base } = await testApp(db));
    organiser = app.get(Organiser);
    owner = new Browser(base);
    await owner.login(OWNER.email, OWNER.password);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await db.drop();
  });

  beforeEach(async () => {
    await prisma.upload.deleteMany();
    await prisma.workplaceGroup.deleteMany();
    await prisma.listEntry.deleteMany();
    await prisma.month.updateMany({ data: { status: 'open', closedAt: null } });
    const user = await prisma.user.findFirstOrThrow();
    monthId = (await monthOf(prisma, DAY)).id;
    uploadId = (
      await prisma.upload.create({
        data: {
          uploadedById: user.id,
          originalFilename: 'a.pdf',
          sha256: `s${Math.random()}`,
          mime: 'application/pdf',
        },
      })
    ).id;
  });

  const ticket = (workplaceRaw: string, extra: Record<string, unknown> = {}) =>
    prisma.ticket.create({
      data: {
        uploadId,
        monthId,
        pageIndex: page++,
        s3KeyPage: `p${page}`,
        workplaceRaw,
        workerName: 'Kwame',
        firstName: 'Kwame',
        shiftDate: DAY,
        startMinutes: 480,
        endMinutes: 720,
        totalMinutes: 240,
        status: 'verified',
        verifiedHow: 'auto',
        ...extra,
      },
    });
  const groups = () => prisma.workplaceGroup.findMany({ where: { monthId } });
  const openFlags = (code: string) =>
    prisma.flag.findMany({ where: { code, resolvedAt: null, ticket: { monthId } } });
  const resolve = (flagId: string, body: unknown) =>
    owner.send('POST', `/api/flags/${flagId}/resolve`, body);
  const get = (id: string) => prisma.ticket.findUniqueOrThrow({ where: { id } });
  const similarFlag = (ticketId: string) =>
    prisma.flag.findFirstOrThrow({ where: { ticketId, code: 'WORKPLACE_SIMILAR' } });

  /** Two similar places with one ticket each, organised; returns the tickets and groups. */
  async function similarPair() {
    const a = await ticket('בית הדר');
    const b = await ticket('בית הדרים', { workerName: 'Dana', firstName: 'Dana' });
    await organiser.organise(monthId);
    const ga = await prisma.workplaceGroup.findUniqueOrThrow({
      where: { id: (await get(a.id)).workplaceGroupId! },
    });
    const gb = await prisma.workplaceGroup.findUniqueOrThrow({
      where: { id: (await get(b.id)).workplaceGroupId! },
    });
    return { a, b, ga, gb };
  }

  it('puts workplaces that differ only by a hyphen or spaces in one group, without asking', async () => {
    const a = await ticket('סופר-פארם');
    const b = await ticket('סופר פארם', { workerName: 'Dana' });
    await organiser.organise(monthId);
    expect(await groups()).toHaveLength(1);
    const [ta, tb] = [await get(a.id), await get(b.id)];
    expect(ta.workplaceGroupId).not.toBeNull();
    expect(ta.workplaceGroupId).toBe(tb.workplaceGroupId);
    expect(await prisma.flag.count()).toBe(0);
    expect(ta.status).toBe('verified');
  });

  it('asks about similar workplaces on every ticket of both, and sends verified tickets back to review', async () => {
    const a = await ticket('בית הדר');
    const a2 = await ticket('בית הדר', { workerName: 'Yossi' });
    const b = await ticket('בית הדרים', { workerName: 'Dana' });
    await organiser.organise(monthId);
    expect(await groups()).toHaveLength(2);
    const flags = await openFlags('WORKPLACE_SIMILAR');
    expect(flags.map((f) => f.ticketId).sort()).toEqual([a.id, a2.id, b.id].sort());
    for (const t of [a, a2, b]) expect((await get(t.id)).status).toBe('needs_review');
  });

  it('merges two spellings when told "same place", and does not ask again', async () => {
    const { a, b, ga, gb } = await similarPair();
    const flag = await similarFlag(a.id);
    expect((await resolve(flag.id, { decision: 'same_place', keepGroupId: ga.id })).status).toBe(
      204,
    );

    const all = await groups();
    expect(all.find((g) => g.id === gb.id)!.mergedIntoId).toBe(ga.id);
    expect(all.find((g) => g.id === ga.id)!.mergedIntoId).toBeNull();
    for (const t of [a, b]) {
      const row = await get(t.id);
      expect(row.workplaceGroupId).toBe(ga.id);
      expect(row.status).toBe('verified');
    }
    expect(await openFlags('WORKPLACE_SIMILAR')).toHaveLength(0);
    expect(
      await prisma.flag.count({ where: { code: 'WORKPLACE_SIMILAR', resolution: 'same_place' } }),
    ).toBe(2);
    expect(await prisma.listEntry.findFirstOrThrow({ where: { kind: 'workplace' } })).toMatchObject(
      { name: ga.displayName, spellings: [gb.displayName] },
    );

    const flagCount = await prisma.flag.count();
    await organiser.organise(monthId);
    expect(await prisma.flag.count()).toBe(flagCount);
  });

  it('keeps two places apart when told "different place", and does not ask again', async () => {
    const { a, ga, gb } = await similarPair();
    const flag = await similarFlag(a.id);
    expect((await resolve(flag.id, { decision: 'different_place' })).status).toBe(204);
    const all = await groups();
    expect(all.every((g) => g.mergedIntoId === null)).toBe(true);
    expect(all.map((g) => g.id).sort()).toEqual([ga.id, gb.id].sort());
    expect(await openFlags('WORKPLACE_SIMILAR')).toHaveLength(0);

    const flagCount = await prisma.flag.count();
    await organiser.organise(monthId);
    expect(await prisma.flag.count()).toBe(flagCount);
    expect(await openFlags('WORKPLACE_SIMILAR')).toHaveLength(0);
  });

  it('follows a chain of merges: all three spellings end in one group with no ticket lost', async () => {
    const a = await ticket('בית הדר');
    const b = await ticket('בית הדרים', { workerName: 'Dana', firstName: 'Dana' });
    const c = await ticket('בית הדרי', { workerName: 'Yossi', firstName: 'Yossi' });
    await organiser.organise(monthId);
    const [ga, gb, gc] = await Promise.all(
      [a, b, c].map(async (t) => (await get(t.id)).workplaceGroupId!),
    );
    const question = async (ticketId: string, x: string, y: string) =>
      (await prisma.flag.findMany({ where: { ticketId, code: 'WORKPLACE_SIMILAR' } })).find((f) => {
        const ids = (f.detail as { groups: string[] }).groups;
        return ids.includes(x) && ids.includes(y);
      })!;

    const ab = await question(a.id, ga!, gb!);
    expect((await resolve(ab.id, { decision: 'same_place', keepGroupId: gb })).status).toBe(204);
    const ac = await question(a.id, ga!, gc!);
    expect((await resolve(ac.id, { decision: 'same_place', keepGroupId: ga })).status).toBe(204);

    const top = (await groups()).filter((g) => g.mergedIntoId === null);
    expect(top).toHaveLength(1);
    for (const t of [a, b, c]) expect((await get(t.id)).workplaceGroupId).toBe(top[0]!.id);
    const { body } = await owner.send('GET', `/api/months/${monthId}`);
    const shown = body.workplaces.flatMap(
      (w: { rows: { tickets: unknown[] }[]; unnamed: unknown[] }) => [
        ...w.rows.flatMap((r) => r.tickets),
        ...w.unnamed,
      ],
    );
    expect(body.workplaces).toHaveLength(1);
    expect(shown).toHaveLength(3);
    // The b/c question was answered by the merges: no "is X the same place as X?" is left.
    expect(await openFlags('WORKPLACE_SIMILAR')).toHaveLength(0);
    for (const t of [a, b, c]) expect((await get(t.id)).status).toBe('verified');
    expect(body.questions).toEqual([]);
  });

  /** Three similar spellings, one ticket each, organised; returns the tickets and groups. */
  async function similarThree() {
    const a = await ticket('בית הדר');
    const b = await ticket('בית הדרים', { workerName: 'Dana', firstName: 'Dana' });
    const c = await ticket('בית הדרי', { workerName: 'Yossi', firstName: 'Yossi' });
    await organiser.organise(monthId);
    const [ga, gb, gc] = await Promise.all(
      [a, b, c].map(async (t) => (await get(t.id)).workplaceGroupId!),
    );
    const question = async (x: string, y: string) =>
      (await openFlags('WORKPLACE_SIMILAR')).find((f) => {
        const ids = (f.detail as { groups: string[] }).groups;
        return ids.includes(x) && ids.includes(y);
      })!;
    return { a, b, c, ga: ga!, gb: gb!, gc: gc!, question };
  }

  it('answers every question about the same two places at once, after a merge', async () => {
    const { a, b, c, ga, gb, gc, question } = await similarThree();
    const ab = await question(ga, gb);
    expect((await resolve(ab.id, { decision: 'same_place', keepGroupId: ga })).status).toBe(204);
    // b is now part of a: "b or c" and "a or c" are one question.
    const bc = await question(gb, gc);
    expect((await resolve(bc.id, { decision: 'different_place' })).status).toBe(204);
    expect(await openFlags('WORKPLACE_SIMILAR')).toHaveLength(0);
    for (const t of [a, b, c]) expect((await get(t.id)).status).toBe('verified');
    const flagCount = await prisma.flag.count();
    await organiser.organise(monthId);
    expect(await prisma.flag.count()).toBe(flagCount);
  });

  it('drops a question already stored about two places that are now one', async () => {
    const { a, b, ga, gb } = await similarPair();
    // As the T1.5 bug left it: the groups merged, the question still open.
    await prisma.workplaceGroup.update({ where: { id: gb.id }, data: { mergedIntoId: ga.id } });
    await prisma.ticket.updateMany({
      where: { workplaceGroupId: gb.id },
      data: { workplaceGroupId: ga.id },
    });
    await organiser.organise(monthId);
    expect(await openFlags('WORKPLACE_SIMILAR')).toHaveLength(0);
    for (const t of [a, b]) expect((await get(t.id)).status).toBe('verified');
  });

  it('lists the open workplace questions on the month, one per pair of places', async () => {
    const { ga, gb, gc } = await similarThree();
    await ticket('בית הדר', { workerName: 'Noa', firstName: 'Noa' });
    await organiser.organise(monthId);
    const month = async () => (await owner.send('GET', `/api/months/${monthId}`)).body;
    let body = await month();
    expect(body.questions).toHaveLength(3);
    const place = body.workplaces.find((w: { groupId: string }) => w.groupId === ga);
    expect(place.spellings).toEqual(['בית הדר']);
    const side = body.questions
      .flatMap((q: { groups: { id: string }[] }) => q.groups)
      .find((g: { id: string }) => g.id === ga);
    expect(side).toMatchObject({ name: 'בית הדר', spellings: ['בית הדר'], tickets: 2 });
    expect(typeof side.ticketId).toBe('string');

    // b joins a: one question left, a or c, with b's ticket and spelling counted in a.
    const ab = body.questions.find((q: { groups: { id: string }[] }) =>
      q.groups.every((g) => [ga, gb].includes(g.id)),
    );
    await resolve(ab.flagId, { decision: 'same_place', keepGroupId: ga });
    body = await month();
    expect(body.questions).toHaveLength(1);
    const [q] = body.questions;
    const names = q.groups.map((g: { name: string }) => g.name).sort();
    expect(names).toEqual(['בית הדר', 'בית הדרי']);
    const merged = q.groups.find((g: { name: string }) => g.name === 'בית הדר');
    expect(merged).toMatchObject({ tickets: 3 });
    expect([...merged.spellings].sort()).toEqual(['בית הדר', 'בית הדרים']);

    // "Same place" with a name chosen from the card, whatever the ids stored in its question.
    const keep = q.groups.find((g: { name: string }) => g.name === 'בית הדרי');
    expect((await resolve(q.flagId, { decision: 'same_place', keepGroupId: keep.id })).status).toBe(
      204,
    );
    body = await month();
    expect(body.questions).toEqual([]);
    expect(body.workplaces).toHaveLength(1);
    expect(body.workplaces[0]).toMatchObject({ groupId: gc, name: 'בית הדרי' });
  });

  it('records the names the place really kept and lost, after an earlier merge', async () => {
    const { ga, gb, gc, question } = await similarThree();
    await resolve((await question(ga, gb)).id, { decision: 'same_place', keepGroupId: ga });
    // A question stored as "b or c": keeping b's side keeps the place b ended in, a.
    const bc = await question(gb, gc);
    await prisma.auditEntry.deleteMany({ where: { action: 'resolve-flag' } });
    expect((await resolve(bc.id, { decision: 'same_place', keepGroupId: gb })).status).toBe(204);
    const [entry] = await prisma.auditEntry.findMany({ where: { action: 'resolve-flag' } });
    expect(entry!.after).toMatchObject({
      decision: 'same_place',
      keepGroupId: gb,
      kept: { id: ga, name: 'בית הדר' },
      merged: { id: gc, name: 'בית הדרי' },
    });
  });

  it('adds the kept name to the list entry that already holds the other one', async () => {
    const { ga, gb, gc, question } = await similarThree();
    await resolve((await question(ga, gb)).id, { decision: 'same_place', keepGroupId: ga });
    // Now keep the newcomer's name: a's name is on the list already, c's is not.
    await resolve((await question(ga, gc)).id, { decision: 'same_place', keepGroupId: gc });
    const entries = await prisma.listEntry.findMany({ where: { kind: 'workplace' } });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.name).toBe('בית הדר');
    expect([...entries[0]!.spellings].sort()).toEqual(['בית הדרי', 'בית הדרים']);
  });

  it('names a new list entry by its Hebrew spelling (D36)', async () => {
    const a = await ticket('Golan Farm');
    const b = await ticket('Golan Farm גולן', { workerName: 'Dana', firstName: 'Dana' });
    await organiser.organise(monthId);
    const keep = (await get(a.id)).workplaceGroupId!;
    expect(
      (await resolve((await similarFlag(b.id)).id, { decision: 'same_place', keepGroupId: keep }))
        .status,
    ).toBe(204);
    expect(
      await prisma.listEntry.findMany({
        where: { kind: 'workplace' },
        select: { name: true, spellings: true },
      }),
    ).toEqual([{ name: 'Golan Farm גולן', spellings: ['Golan Farm'] }]);
  });

  it('asks about duplicates a merge brings together in the same answer, all or nothing', async () => {
    const a = await ticket('בית הדר');
    const b = await ticket('בית הדרים', { startMinutes: 840, endMinutes: 1080 });
    await organiser.organise(monthId);
    const keep = (await get(a.id)).workplaceGroupId!;
    // Organising again later is not needed for the questions: the answer asks them itself.
    const spy = vi.spyOn(organiser, 'organise').mockRejectedValue(new Error('down'));
    try {
      const res = await resolve((await similarFlag(a.id)).id, {
        decision: 'same_place',
        keepGroupId: keep,
      });
      expect(res.status).toBe(204);
    } finally {
      spy.mockRestore();
    }
    const dup = await openFlags('POSSIBLE_DUPLICATE');
    expect(dup.map((f) => f.ticketId).sort()).toEqual([a.id, b.id].sort());
    for (const t of [a, b]) expect((await get(t.id)).status).toBe('needs_review');
  });

  it('lets a reviewer, not only an admin, answer a question and replace a list', async () => {
    const { a } = await similarPair();
    const admin = new Browser(base);
    await admin.login(OWNER.email, OWNER.password);
    const email = `reviewer${Math.random()}@example.com`;
    const invited = await admin.send('POST', '/api/users/invite', { email, role: 'reviewer' });
    const reviewer = new Browser(base);
    const accepted = await reviewer.send('POST', '/api/auth/accept-invite', {
      token: invited.body.inviteUrl.split('#token=')[1],
      password: 'reviewer password',
    });
    expect(accepted.status).toBe(200);
    const flag = await similarFlag(a.id);
    const answered = await reviewer.send('POST', `/api/flags/${flag.id}/resolve`, {
      decision: 'different_place',
    });
    expect(answered.status).toBe(204);
    const put = await reviewer.send('PUT', '/api/lists/workplace', { text: 'בית הדר' });
    expect(put).toMatchObject({ status: 200, body: [{ name: 'בית הדר', spellings: [] }] });
  });

  it('refuses "same place" without saying which name the place keeps, and merges nothing', async () => {
    const { a } = await similarPair();
    const flag = await similarFlag(a.id);
    const res = await resolve(flag.id, { decision: 'same_place' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('Choose which name the place keeps.');
    expect((await groups()).every((g) => g.mergedIntoId === null)).toBe(true);
    expect((await prisma.flag.findUniqueOrThrow({ where: { id: flag.id } })).resolvedAt).toBeNull();
  });

  it('does nothing for a month that is closing', async () => {
    await ticket('בית הדר');
    await ticket('בית הדרים', { workerName: 'Dana', firstName: 'Dana' });
    await prisma.month.update({ where: { id: monthId }, data: { status: 'closing' } });
    await organiser.organise(monthId);
    expect(await groups()).toHaveLength(0);
    expect(await prisma.flag.count()).toBe(0);
  });

  describe('possible duplicates', () => {
    it('settles the other questions about a ticket once it is removed', async () => {
      const base = { workerName: 'Kwame' };
      const a = await ticket('Golan Farm', {
        ...base,
        startMinutes: 480,
        endMinutes: 720,
        createdAt: new Date('2026-11-14T08:00:00Z'),
      });
      const b = await ticket('Golan Farm', {
        ...base,
        startMinutes: 840,
        endMinutes: 1080,
        createdAt: new Date('2026-11-15T08:00:00Z'),
      });
      const c = await ticket('Golan Farm', {
        ...base,
        startMinutes: 1140,
        endMinutes: 1320,
        createdAt: new Date('2026-11-16T08:00:00Z'),
      });
      await organiser.organise(monthId);
      const open = await openFlags('POSSIBLE_DUPLICATE');
      expect(open).toHaveLength(6);
      const bc = open.find((f) => f.ticketId === b.id && f.relatedTicketId === c.id)!;
      expect((await resolve(bc.id, { decision: 'ignore' })).status).toBe(204);

      expect((await get(c.id)).status).toBe('excluded');
      for (const t of [a, b]) expect((await get(t.id)).status).not.toBe('excluded');
      const ac = await prisma.flag.findMany({
        where: {
          code: 'POSSIBLE_DUPLICATE',
          OR: [
            { ticketId: a.id, relatedTicketId: c.id },
            { ticketId: c.id, relatedTicketId: a.id },
          ],
        },
      });
      expect(ac).toHaveLength(2);
      for (const f of ac) expect(f).toMatchObject({ resolution: 'ticket_removed' });
      // Only the question between A and B is left.
      const left = await openFlags('POSSIBLE_DUPLICATE');
      expect(left.map((f) => f.ticketId).sort()).toEqual([a.id, b.id].sort());

      // Any question that still names the removed ticket is refused.
      const res = await resolve(ac[0]!.id, { decision: 'keep_both' });
      expect(res.status).toBe(409);
      expect(JSON.stringify(res.body)).toContain('This question was already answered.');
    });
  });

  describe('possible duplicates', () => {
    async function pair() {
      const older = await ticket('Golan Farm', {
        workerName: 'Kwame',
        startMinutes: 480,
        endMinutes: 720,
        createdAt: new Date('2026-11-14T08:00:00Z'),
      });
      const newer = await ticket('Golan Farm', {
        workerName: 'KWAME',
        startMinutes: 840,
        endMinutes: 1080,
        createdAt: new Date('2026-11-15T08:00:00Z'),
      });
      await organiser.organise(monthId);
      return { older, newer };
    }
    const notAskedAgain = async () => {
      const count = await prisma.flag.count();
      await organiser.organise(monthId);
      expect(await prisma.flag.count()).toBe(count);
      expect(await openFlags('POSSIBLE_DUPLICATE')).toHaveLength(0);
    };

    it('asks about two tickets of one name, place and day that do not overlap', async () => {
      const { older, newer } = await pair();
      const flags = await openFlags('POSSIBLE_DUPLICATE');
      expect(flags).toHaveLength(2);
      expect(flags.find((f) => f.ticketId === older.id)!.relatedTicketId).toBe(newer.id);
      expect(flags.find((f) => f.ticketId === newer.id)!.relatedTicketId).toBe(older.id);
    });

    it('"replace" excludes the older ticket and points it at the newer one', async () => {
      const { older, newer } = await pair();
      const [flag] = await openFlags('POSSIBLE_DUPLICATE');
      expect((await resolve(flag!.id, { decision: 'replace' })).status).toBe(204);
      expect(await get(older.id)).toMatchObject({
        status: 'excluded',
        excludedReason: 'replaced',
        replacedById: newer.id,
      });
      expect((await get(newer.id)).status).not.toBe('excluded');
      await notAskedAgain();
    });

    it('"keep both" keeps both tickets and does not ask again', async () => {
      const { older, newer } = await pair();
      const [flag] = await openFlags('POSSIBLE_DUPLICATE');
      expect((await resolve(flag!.id, { decision: 'keep_both' })).status).toBe(204);
      expect((await get(older.id)).status).not.toBe('excluded');
      expect((await get(newer.id)).status).not.toBe('excluded');
      await notAskedAgain();
    });

    it('"ignore" excludes the newer ticket as a duplicate and does not ask again', async () => {
      const { older, newer } = await pair();
      const [flag] = await openFlags('POSSIBLE_DUPLICATE');
      expect((await resolve(flag!.id, { decision: 'ignore' })).status).toBe(204);
      expect(await get(newer.id)).toMatchObject({
        status: 'excluded',
        excludedReason: 'duplicate',
      });
      expect((await get(older.id)).status).not.toBe('excluded');
      await notAskedAgain();
    });
  });

  it('shows each workplace with one row per name, unnamed tickets apart, and no excluded tickets', async () => {
    await ticket('Golan Farm', { workerName: 'Kwame' });
    await ticket('Golan Farm', { workerName: ' kwame ', startMinutes: 840, endMinutes: 1080 });
    await ticket('Golan Farm', { workerName: 'Dana', startMinutes: 100, endMinutes: 200 });
    await ticket('Golan Farm', { workerName: null, startMinutes: 300, endMinutes: 400 });
    await ticket('Golan Farm', {
      workerName: 'Yossi',
      status: 'excluded',
      verifiedHow: null,
      startMinutes: 500,
      endMinutes: 600,
    });
    await organiser.organise(monthId);
    const { status, body } = await owner.send('GET', `/api/months/${monthId}`);
    expect(status).toBe(200);
    expect(body.workplaces).toHaveLength(1);
    const place = body.workplaces[0];
    expect(place.name).toBe('Golan Farm');
    const key = (r: { name: string }) => r.name.trim().toLowerCase();
    expect(place.rows.map(key)).toEqual(['dana', 'kwame']);
    expect(place.rows.find((r: { name: string }) => key(r) === 'kwame').tickets).toHaveLength(2);
    expect(place.unnamed).toHaveLength(1);
    expect(JSON.stringify(place)).not.toContain('Yossi');
  });

  describe('refusals', () => {
    it('refuses a duplicate answer on a workplace question', async () => {
      const { a } = await similarPair();
      const flag = await similarFlag(a.id);
      expect((await resolve(flag.id, { decision: 'replace' })).status).toBe(400);
      const after = await prisma.flag.findUniqueOrThrow({ where: { id: flag.id } });
      expect(after.resolvedAt).toBeNull();
    });

    it('refuses to answer the same question twice', async () => {
      const { a } = await similarPair();
      const flag = await similarFlag(a.id);
      expect((await resolve(flag.id, { decision: 'different_place' })).status).toBe(204);
      expect((await resolve(flag.id, { decision: 'different_place' })).status).toBe(409);
    });

    it('refuses a question in a closed month', async () => {
      const { a } = await similarPair();
      const flag = await similarFlag(a.id);
      await prisma.month.update({
        where: { id: monthId },
        data: { status: 'closed', closedAt: new Date() },
      });
      expect((await resolve(flag.id, { decision: 'different_place' })).status).toBe(409);
    });

    it('needs a login', async () => {
      const { a } = await similarPair();
      const flag = await similarFlag(a.id);
      const res = await new Browser(base).send('POST', `/api/flags/${flag.id}/resolve`, {
        decision: 'different_place',
      });
      expect(res.status).toBe(401);
    });

    it('says there is no such question for an id that is not one', async () => {
      expect((await resolve('not-an-id', { decision: 'different_place' })).status).toBe(404);
    });
  });

  it('writes an audit entry for every answer', async () => {
    const { a } = await similarPair();
    const flag = await similarFlag(a.id);
    await prisma.auditEntry.deleteMany({ where: { action: 'resolve-flag' } });
    await resolve(flag.id, { decision: 'different_place' });
    const entries = await prisma.auditEntry.findMany({ where: { action: 'resolve-flag' } });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ entity: 'Flag', entityId: flag.id, monthId });
  });
});
