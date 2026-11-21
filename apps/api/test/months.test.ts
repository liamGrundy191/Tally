// T1.3 "Done when": months are created from ticket dates; the month list and summary; the lists
// that help reading are saved once and used by every month (5.4, D42). Names here are invented.
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { monthOf } from '../src/months/months.service.ts';
import { createAdmin } from '../src/users/create-admin.ts';
import { Browser } from './helpers/browser.ts';
import { testApp } from './helpers/test-app.ts';
import { databaseUrl, testDatabase } from './helpers/test-db.ts';

const OWNER = { email: 'owner@example.com', password: 'owner password 1' };

describe.skipIf(!databaseUrl)('months and lists (T1.3)', () => {
  const db = testDatabase();
  const prisma = db.prisma;
  let app: INestApplication;
  let owner: Browser;
  let base: string;

  beforeAll(async () => {
    await db.migrate();
    await createAdmin(prisma, OWNER.email, OWNER.password);
    ({ app, base } = await testApp(db));
    owner = new Browser(base);
    await owner.login(OWNER.email, OWNER.password);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await db.drop();
  });

  describe('months', () => {
    it('creates a month when its first ticket arrives, once, even for tickets arriving together', async () => {
      const months = await Promise.all(
        ['2026-11-01', '2026-11-13', '2026-11-30', '2026-11-13'].map((d) =>
          monthOf(prisma, new Date(d)),
        ),
      );
      expect(new Set(months.map((m) => m.id)).size).toBe(1);
      expect(months[0]).toMatchObject({ year: 2026, month: 11, status: 'open' });
      expect(await monthOf(prisma, new Date('2026-12-01'))).toMatchObject({ month: 12 });
      expect(await prisma.month.count()).toBe(2);
    });

    it('lists the months newest first, with their tickets counted by status', async () => {
      const user = await prisma.user.findFirstOrThrow();
      const upload = await prisma.upload.create({
        data: {
          uploadedById: user.id,
          originalFilename: 'a.pdf',
          sha256: 'a',
          mime: 'application/pdf',
        },
      });
      const november = await monthOf(prisma, new Date('2026-11-13'));
      const statuses = ['verified', 'verified', 'needs_review', 'excluded'] as const;
      await prisma.ticket.createMany({
        data: statuses.map((status, pageIndex) => ({
          uploadId: upload.id,
          monthId: november.id,
          pageIndex,
          s3KeyPage: `p${pageIndex}`,
          status,
        })),
      });
      // A ticket whose date is not settled yet belongs to no month.
      await prisma.ticket.create({ data: { uploadId: upload.id, pageIndex: 9, s3KeyPage: 'p9' } });

      const { status, body } = await owner.send('GET', '/api/months');
      expect(status).toBe(200);
      expect(body.map((m: { month: number }) => m.month)).toEqual([12, 11]);
      expect(body[1]).toMatchObject({
        id: november.id,
        year: 2026,
        month: 11,
        status: 'open',
        tickets: {
          processing: 0,
          verified: 2,
          needs_review: 1,
          needs_manual_entry: 0,
          excluded: 1,
        },
      });
      expect(body[0].tickets).toMatchObject({ verified: 0, needs_review: 0 });
    });

    it('shows one month, and says when there is no such month', async () => {
      const november = await monthOf(prisma, new Date('2026-11-13'));
      expect((await owner.send('GET', `/api/months/${november.id}`)).body).toMatchObject({
        month: 11,
        tickets: { verified: 2 },
      });
      for (const id of ['00000000-0000-4000-8000-000000000000', 'not-an-id']) {
        expect(await owner.send('GET', `/api/months/${id}`)).toMatchObject({
          status: 404,
          body: { message: 'There is no such month.' },
        });
      }
    });

    it('needs a login', async () => {
      expect((await new Browser(base).send('GET', '/api/months')).status).toBe(401);
    });
  });

  describe('the lists that help reading', () => {
    const put = (kind: string, text: string) => owner.send('PUT', `/api/lists/${kind}`, { text });

    it('saves a pasted list and gives it back, sorted', async () => {
      const saved = await put('workplace', 'Golan Farm = חוות גולן\nבית הדר\n');
      expect(saved).toMatchObject({
        status: 200,
        body: [
          { name: 'בית הדר', spellings: [] },
          { name: 'חוות גולן', spellings: ['Golan Farm'] },
        ],
      });
      expect((await owner.send('GET', '/api/lists/workplace')).body).toEqual(saved.body);
      expect((await owner.send('GET', '/api/lists/name')).body).toEqual([]);
    });

    it('replaces a list entirely, and records who did it without the names', async () => {
      await put('name', 'Kwame\nDana');
      const { body } = await put('name', 'דנה = Dana');
      expect(body).toEqual([{ name: 'Dana', spellings: ['דנה'] }]);
      const entries = await prisma.auditEntry.findMany({
        where: { action: 'replace-list', entityId: 'name' },
        orderBy: { createdAt: 'asc' },
      });
      expect(entries.map((e) => [e.before, e.after])).toEqual([
        [{ entries: 0 }, { entries: 2 }],
        [{ entries: 2 }, { entries: 1 }],
      ]);
      expect(JSON.stringify(entries)).not.toMatch(/Dana|Kwame/);
    });

    it('is still there when a new month starts: lists belong to no month (D42)', async () => {
      await monthOf(prisma, new Date('2027-01-05'));
      expect((await owner.send('GET', '/api/lists/name')).body).toEqual([
        { name: 'Dana', spellings: ['דנה'] },
      ]);
    });

    it('refuses an unknown list and a line that is too long', async () => {
      expect(await put('workers', 'Dana')).toMatchObject({ status: 404 });
      expect(await put('name', 'x'.repeat(201))).toMatchObject({
        status: 400,
        body: { message: 'Line 1 is longer than 200 characters.' },
      });
      expect((await owner.send('GET', '/api/lists/name')).body).toHaveLength(1);
    });

    it('needs a login', async () => {
      expect((await new Browser(base).send('GET', '/api/lists/name')).status).toBe(401);
    });
  });
});
