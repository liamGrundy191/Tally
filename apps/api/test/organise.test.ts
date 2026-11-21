// T1.5 "Done when": tickets are grouped by workplace, and the questions only a person can answer
// (same place? same ticket?) are asked once and stay answered (5.2, 5.3). Names are invented.
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
