// T3.3 "Done when": closing a month deletes everything of it but its summary, in the database and in
// file storage, while another open month is untouched (6.1, 6.4). Names here are invented.
import type { INestApplication } from '@nestjs/common';
import { imageToJpeg, pdfToImages } from '@tally/shared/imaging';
import { PDFDocument } from 'pdf-lib';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DownloadKind, MonthStatus } from '../src/generated/prisma/client.ts';
import { monthOf } from '../src/months/months.service.ts';
import { Purger } from '../src/months/purge.ts';
import { CHECK_MONTHS } from '../src/queue.ts';
import { ReadingConfig } from '../src/reading/config.ts';
import { Storage } from '../src/storage.ts';
import { createAdmin } from '../src/users/create-admin.ts';
import { startWorker } from '../src/worker.ts';
import { Browser } from './helpers/browser.ts';
import { testApp } from './helpers/test-app.ts';
import { databaseUrl, testDatabase } from './helpers/test-db.ts';
import { storageConfigured, testStorage } from './helpers/test-storage.ts';

const OWNER = { email: 'owner@example.com', password: 'owner password 1' };

async function until(check: () => Promise<boolean>, ms = 60_000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('Timed out waiting.');
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe('deleting files in storage', () => {
  it('throws when storage reports a file it could not delete', async () => {
    const s3 = { send: async () => ({ Errors: [{ Key: 'pages/x/0.jpg', Message: 'Denied' }] }) };
    const storage = new Storage(s3 as never, 'bucket');
    await expect(storage.removeMany(['pages/x/0.jpg'])).rejects.toThrow(/could not be deleted/);
  });

  it('asks nothing of storage for no files', async () => {
    const s3 = { send: async () => expect.unreachable() };
    await new Storage(s3 as never, 'bucket').removeMany([]);
  });
});

describe.skipIf(!databaseUrl || !storageConfigured)('closing a month (T3.3)', () => {
  const db = testDatabase();
  const prisma = db.prisma;
  const files = testStorage();
  // The 60-day check's "today" (6.1); the worker never deletes by the real clock in a test.
  let today = '2026-11-20';
  const reading = ReadingConfig.fromEnv({ ...process.env, EXTRACTOR: 'fake' });
  const config = new ReadingConfig(
    reading.extractor,
    () => ({ ...reading.settings(), today }),
    false,
  );
  let app: INestApplication;
  let owner: Browser;
  let base: string;
  let ownerId: string;
  let purger: Purger;
  let scans: Buffer[];
  let page = 0;

  /** A month's place and ready tickets, each with a real scan in storage. */
  async function seed(year: number, month: number, place: string) {
    const monthId = (await monthOf(prisma, new Date(Date.UTC(year, month - 1, 1)))).id;
    const groupId = (
      await prisma.workplaceGroup.create({
        data: { monthId, displayName: place, normalisedName: place },
      })
    ).id;
    return { monthId, groupId };
  }
  async function ticket(
    uploadId: string,
    monthId: string | null,
    groupId: string | null,
    name: string,
    more: Record<string, unknown> = {},
  ) {
    const key = `pages/${uploadId}/${page}.jpg`;
    await files.storage.put(key, scans[page % scans.length]!, 'image/jpeg');
    return prisma.ticket.create({
      data: {
        uploadId,
        monthId,
        pageIndex: page++,
        s3KeyPage: key,
        firstName: name,
        workerName: name,
        workplaceGroupId: groupId,
        workplaceRaw: 'as written',
        shiftDate: new Date(Date.UTC(2026, 10, 3)),
        totalMinutes: 480,
        status: 'verified',
        ...more,
      },
    });
  }
  const upload = async (name: string) =>
    (
      await prisma.upload.create({
        data: {
          uploadedById: ownerId,
          originalFilename: name,
          sha256: name,
          mime: 'application/pdf',
          pageCount: 3,
        },
      })
    ).id;
  const close = (monthId: string, name: string) =>
    owner.send('POST', `/api/months/${monthId}/close`, { name });
  const downloadBoth = async (monthId: string) => {
    expect((await owner.download(`/api/months/${monthId}/excel`)).status).toBe(200);
    expect((await owner.download(`/api/months/${monthId}/pdfs`)).status).toBe(200);
  };
  const status = async (monthId: string) =>
    (await prisma.month.findUniqueOrThrow({ where: { id: monthId } })).status;
  const closed = (monthId: string) =>
    until(async () => (await status(monthId)) === ('closed' satisfies MonthStatus));
  const kinds = async (monthId: string) =>
    (await prisma.download.findMany({ where: { monthId } })).map((d) => d.kind).sort();

  beforeAll(async () => {
    await Promise.all([db.migrate(), files.create()]);
    await createAdmin(prisma, OWNER.email, OWNER.password);
    ownerId = (await prisma.user.findFirstOrThrow()).id;
    ({ app, base } = await testApp(db, { storage: files.storage, reading: config }));
    owner = new Browser(base);
    await owner.login(OWNER.email, OWNER.password);
    purger = app.get(Purger);
    const doc = await PDFDocument.create();
    for (let i = 0; i < 4; i++) doc.addPage([200 + i * 10, 150]);
    scans = await Promise.all(
      (await pdfToImages(Buffer.from(await doc.save()))).map((p) => imageToJpeg(p)),
    );
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await files.drop();
    await db.drop();
  });

  describe('refusals', () => {
    let oct: { monthId: string; groupId: string };
    let waiting: { id: string; version: number };

    beforeAll(async () => {
      const u = await upload('october.pdf');
      oct = await seed(2026, 10, 'חוות אוקטובר');
      await ticket(u, oct.monthId, oct.groupId, 'Kwame', {
        shiftDate: new Date(Date.UTC(2026, 9, 3)),
      });
      waiting = await ticket(u, oct.monthId, oct.groupId, 'Dana', {
        shiftDate: new Date(Date.UTC(2026, 9, 4)),
        status: 'needs_review',
      });
    });

    it('needs a login and a known month', async () => {
      const stranger = new Browser(base);
      expect((await stranger.send('POST', `/api/months/${oct.monthId}/close`, {})).status).toBe(
        401,
      );
      expect((await close('not-a-month', 'October 2026')).status).toBe(404);
      expect((await close(crypto.randomUUID(), 'October 2026')).status).toBe(404);
      // The month is checked before what was sent.
      expect(
        (await owner.send('POST', `/api/months/${crypto.randomUUID()}/close`, {})).status,
      ).toBe(404);
    });

    it('refuses until the month’s name is typed', async () => {
      const res = await close(oct.monthId, 'October 2025');
      expect(res.status).toBe(400);
      expect(res.body.message).toBe("To close it, type the month's name: October 2026.");
    });

    it('refuses until the Excel and the workplace PDFs were both downloaded', async () => {
      let res = await close(oct.monthId, 'October 2026');
      expect(res.status).toBe(409);
      expect(res.body.message).toBe(
        'Download the Excel and the workplace PDFs before closing the month.',
      );
      expect((await owner.download(`/api/months/${oct.monthId}/excel`)).status).toBe(200);
      // One workplace's PDF is not "the PDFs".
      expect(
        (await owner.download(`/api/months/${oct.monthId}/pdfs?workplace=${oct.groupId}`)).status,
      ).toBe(200);
      expect(await kinds(oct.monthId)).toEqual<DownloadKind[]>(['excel']);
      res = await close(oct.monthId, 'October 2026');
      expect(res.status).toBe(409);
      expect((await owner.download(`/api/months/${oct.monthId}/pdfs`)).status).toBe(200);
      expect(await kinds(oct.monthId)).toEqual<DownloadKind[]>(['excel', 'pdfs']);
    });

    it('refuses while a ticket still needs review (Q14)', async () => {
      const res = await close(oct.monthId, 'October 2026');
      expect(res.status).toBe(409);
      expect(res.body.message).toBe(
        '1 ticket still needs review. Review or remove it before closing the month.',
      );
      expect(await status(oct.monthId)).toBe('open');
    });

    it('closes once every ticket is ready or removed, and only once', async () => {
      expect(
        (
          await owner.send('POST', `/api/tickets/${waiting.id}/exclude`, {
            version: waiting.version,
          })
        ).status,
      ).toBe(204);
      // A ticket being read may be dated in this month.
      const u = await upload('still-reading.pdf');
      const reading = await ticket(u, null, null, 'Ann', { status: 'processing', shiftDate: null });
      let res = await close(oct.monthId, 'October 2026');
      expect(res.status).toBe(409);
      expect(res.body.message).toBe(
        'Some tickets are still being read. Try again when reading has finished.',
      );
      await prisma.ticket.delete({ where: { id: reading.id } });
      // A ticket dated in October that waits outside it for a person (6c).
      const outside = await ticket(u, null, null, 'Ben', {
        status: 'needs_review',
        shiftDate: new Date(Date.UTC(2026, 9, 31)),
      });
      res = await close(oct.monthId, 'October 2026');
      expect(res.status).toBe(409);
      expect(res.body.message).toBe(
        '1 ticket dated in this month is waiting for a date or a check.',
      );
      await prisma.ticket.delete({ where: { id: outside.id } });
      expect((await close(oct.monthId, ' october  2026 ')).status).toBe(202);
      const m = await prisma.month.findUniqueOrThrow({ where: { id: oct.monthId } });
      expect(m).toMatchObject({
        status: 'closing',
        closedById: ownerId,
        summaryTicketCount: 1,
        summaryTotalMinutes: 480,
      });
      expect((await close(oct.monthId, 'October 2026')).status).toBe(409);
    });

    it('builds no file of a month being closed, and records no download', async () => {
      const before = (await kinds(oct.monthId)).length;
      expect((await owner.download(`/api/months/${oct.monthId}/excel`)).status).toBe(409);
      expect((await owner.download(`/api/months/${oct.monthId}/pdfs`)).status).toBe(409);
      expect(await kinds(oct.monthId)).toHaveLength(before);
    });
  });

  describe('the purge', () => {
    it('does nothing to an open month, or to one already closed', async () => {
      const u = await upload('open.pdf');
      const jan = await seed(2027, 1, 'חוות ינואר');
      const t = await ticket(u, jan.monthId, jan.groupId, 'Ann');
      await purger.purge(jan.monthId);
      expect(await prisma.ticket.count({ where: { id: t.id } })).toBe(1);
      expect(await files.keys()).toContain(t.s3KeyPage);
      expect(await status(jan.monthId)).toBe('open');
    });

    it('keeps everything when storage fails, and finishes when tried again', async () => {
      const u = await upload('flaky.pdf');
      const feb = await seed(2027, 2, 'חוות פברואר');
      const t = await ticket(u, feb.monthId, feb.groupId, 'Ann');
      await prisma.month.update({ where: { id: feb.monthId }, data: { status: 'closing' } });
      const removeMany = files.storage.removeMany;
      files.storage.removeMany = async () => {
        throw new Error('Storage is down.');
      };
      try {
        await expect(purger.purge(feb.monthId)).rejects.toThrow('Storage is down.');
      } finally {
        files.storage.removeMany = removeMany;
      }
      expect(await prisma.ticket.count({ where: { id: t.id } })).toBe(1);
      expect(await status(feb.monthId)).toBe('closing');
      // The scans already gone (a crash after storage, before the database): it still finishes.
      await files.storage.removeMany([t.s3KeyPage]);
      await purger.purge(feb.monthId);
      expect(await status(feb.monthId)).toBe('closed');
      expect(await prisma.ticket.count({ where: { id: t.id } })).toBe(0);
      expect(await prisma.upload.count({ where: { id: u } })).toBe(0);
      await purger.purge(feb.monthId); // closed: nothing to do
    });
  });

  it('closes a month: nothing of it is left but its summary, and the other month is untouched', async () => {
    // November and December are open. U1 holds November only; U2 a page of each month and a
    // ticket waiting for a date, so it stays.
    const u1 = await upload('november.pdf');
    const u2 = await upload('both.pdf');
    const nov = await seed(2026, 11, 'חוות זבולון');
    const novMerged = (
      await prisma.workplaceGroup.create({
        data: {
          monthId: nov.monthId,
          displayName: 'חוות זבולון הישנה',
          normalisedName: 'old',
          mergedIntoId: nov.groupId,
        },
      })
    ).id;
    const n1 = await ticket(u1, nov.monthId, nov.groupId, 'Zebulon');
    const n2 = await ticket(u1, nov.monthId, nov.groupId, 'Zipporah', {
      status: 'excluded',
      excludedReason: 'removed',
      excludedById: ownerId,
    });
    const n3 = await ticket(u2, nov.monthId, nov.groupId, 'Zelda');
    const dec = await seed(2026, 12, 'חוות דצמבר');
    const d1 = await ticket(u2, dec.monthId, dec.groupId, 'Dana', {
      shiftDate: new Date(Date.UTC(2026, 11, 3)),
    });
    const wait = await ticket(u2, null, null, 'Moshe', { status: 'needs_review', shiftDate: null });
    // A page stored by the splitter just before a crash: no ticket row points at it.
    const orphan = `pages/${u1}/99.jpg`;
    await files.storage.put(orphan, scans[0]!, 'image/jpeg');
    await prisma.flag.create({
      data: { ticketId: n1.id, code: 'FIELD_UNREADABLE', field: 'firstName', detail: {} },
    });
    await prisma.flag.create({ data: { ticketId: d1.id, code: 'CORRECTION_MARKS', detail: {} } });
    for (const t of [n1, d1]) {
      await prisma.reading.create({
        data: {
          ticketId: t.id,
          pass: 'A',
          model: 'fake',
          promptVersion: 'v3',
          inputTokens: 1,
          outputTokens: 1,
          listsKey: 'k',
          answer: { name: t.firstName },
        },
      });
    }
    const audit = (entity: string, entityId: string, monthId?: string) =>
      prisma.auditEntry.create({
        data: { userId: ownerId, action: 'test', entity, entityId, monthId, after: {} },
      });
    await audit('Ticket', n1.id, nov.monthId);
    await audit('Ticket', n1.id); // written while it waited outside any month (D46)
    await audit('Upload', u1);
    await audit('Upload', u2);
    await audit('Ticket', d1.id, dec.monthId);
    await prisma.listEntry.create({ data: { kind: 'workplace', name: 'חוות דצמבר' } });
    await downloadBoth(dec.monthId);

    const decRows = () =>
      Promise.all([
        prisma.ticket.findMany({ where: { id: { in: [d1.id, wait.id] } }, orderBy: { id: 'asc' } }),
        prisma.flag.findMany({ where: { ticketId: d1.id } }),
        prisma.reading.findMany({ where: { ticketId: d1.id } }),
        prisma.workplaceGroup.findMany({ where: { monthId: dec.monthId } }),
        prisma.download.findMany({ where: { monthId: dec.monthId }, orderBy: { id: 'asc' } }),
        prisma.auditEntry.findMany({
          where: { OR: [{ monthId: dec.monthId }, { entityId: u2 }] },
          orderBy: { id: 'asc' },
        }),
        prisma.upload.findMany({ where: { id: u2 } }),
        prisma.listEntry.findMany(),
        prisma.month.findUniqueOrThrow({ where: { id: dec.monthId } }),
      ]);
    const decBefore = await decRows();
    const decKeys = [d1.s3KeyPage, wait.s3KeyPage];

    await downloadBoth(nov.monthId);
    expect((await close(nov.monthId, 'November 2026')).status).toBe(202);
    await startWorker(app);
    await closed(nov.monthId);

    // Every table of the app's schema, every row as text: nothing of November is left but the
    // summary. The job queue's own schema is not scanned: its finished jobs hold ids only, never
    // values, and are deleted after a day (new queues) or a week (D56).
    const gone = [
      nov.groupId,
      novMerged,
      n1.id,
      n2.id,
      n3.id,
      u1,
      n1.s3KeyPage,
      n3.s3KeyPage,
      'Zebulon',
      'Zipporah',
      'Zelda',
      'חוות זבולון',
    ];
    const tables = await prisma.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = ${db.schema} AND table_type = 'BASE TABLE'
        AND table_name <> '_prisma_migrations'`;
    expect(tables.length).toBeGreaterThan(10);
    for (const { table_name } of tables) {
      const rows = await prisma.$queryRawUnsafe<{ row: string }[]>(
        `SELECT t::text AS row FROM "${db.schema}"."${table_name}" t`,
      );
      for (const { row } of rows) {
        if (table_name === 'Month' && row.startsWith(`(${nov.monthId},`)) continue;
        for (const g of gone) expect(row, `${table_name}: ${g}`).not.toContain(g);
        if (table_name !== 'Month') expect(row, table_name).not.toContain(nov.monthId);
      }
    }
    expect(await prisma.month.findUniqueOrThrow({ where: { id: nov.monthId } })).toMatchObject({
      status: 'closed',
      closedById: ownerId,
      summaryTicketCount: 2,
      summaryTotalMinutes: 960,
      closedAt: expect.any(Date),
    });

    const keys = await files.keys();
    for (const k of [n1.s3KeyPage, n2.s3KeyPage, n3.s3KeyPage, orphan]) {
      expect(keys).not.toContain(k);
    }
    for (const k of decKeys) expect(keys).toContain(k);
    expect(await decRows()).toEqual(decBefore);
  }, 120_000);

  describe('the daily check', () => {
    it('is scheduled every night in Israel time', async () => {
      const [schedule] = await app.get(PgBoss).getSchedules(CHECK_MONTHS);
      expect(schedule).toMatchObject({ cron: '0 3 * * *', options: { tz: 'Asia/Jerusalem' } });
    });

    it('deletes a month 60 days after its last day, even if nobody downloaded it', async () => {
      const u = await upload('summer.pdf');
      const aug = await seed(2026, 8, 'חוות אוגוסט'); // deleted from 30 Oct 2026
      const sep = await seed(2026, 9, 'חוות ספטמבר'); // deleted from 29 Nov 2026
      const a = await ticket(u, aug.monthId, aug.groupId, 'Ann', {
        shiftDate: new Date(Date.UTC(2026, 7, 3)),
      });
      const s = await ticket(u, sep.monthId, sep.groupId, 'Sam', {
        shiftDate: new Date(Date.UTC(2026, 8, 3)),
      });
      today = '2026-11-20';
      await purger.check();
      await closed(aug.monthId);
      expect(await prisma.month.findUniqueOrThrow({ where: { id: aug.monthId } })).toMatchObject({
        closedById: null,
        summaryTicketCount: 1,
      });
      expect(await prisma.ticket.count({ where: { id: a.id } })).toBe(0);
      expect(await status(sep.monthId)).toBe('open');
      expect(await prisma.ticket.count({ where: { id: s.id } })).toBe(1);
    });

    it('finishes a month left half closed', async () => {
      const stuck = await prisma.month.create({
        data: { year: 2025, month: 1, status: 'closing' },
      });
      await purger.check();
      await closed(stuck.id);
    });

    it('deletes removed tickets that belong to no month only once their month is closed', async () => {
      const u = await upload('strays.pdf');
      const removed = { status: 'excluded', excludedReason: 'removed', excludedById: ownerId };
      // Dated in November, which is closed.
      const inClosed = await ticket(u, null, null, 'Ann', removed);
      // Read into a month already closed (6.1.7), whatever its date says now.
      const flagged = await ticket(u, null, null, 'Bea', {
        ...removed,
        shiftDate: new Date(Date.UTC(2026, 8, 5)),
      });
      await prisma.flag.create({
        data: { ticketId: flagged.id, code: 'MONTH_CLOSED', field: 'date', detail: {} },
      });
      // Dated in September, still open: it may yet be wanted there.
      const inOpen = await ticket(u, null, null, 'Cal', {
        ...removed,
        shiftDate: new Date(Date.UTC(2026, 8, 6)),
      });
      const waiting = await ticket(u, null, null, 'Ben', { status: 'needs_review' });
      await purger.check();
      for (const t of [inClosed, flagged]) {
        expect(await prisma.ticket.count({ where: { id: t.id } })).toBe(0);
        expect(await files.keys()).not.toContain(t.s3KeyPage);
      }
      for (const t of [inOpen, waiting]) {
        expect(await prisma.ticket.count({ where: { id: t.id } })).toBe(1);
        expect(await files.keys()).toContain(t.s3KeyPage);
      }
      expect(await prisma.upload.count({ where: { id: u } })).toBe(1);
    });

    it('deletes an upload left with no tickets after a week, with its pages and history', async () => {
      const old = await upload('old-empty.pdf');
      const recent = await upload('recent-empty.pdf');
      await prisma.upload.update({
        where: { id: old },
        data: { createdAt: new Date(Date.now() - 8 * 24 * 3600_000) },
      });
      await files.storage.put(`pages/${old}/0.jpg`, scans[0]!, 'image/jpeg');
      await prisma.auditEntry.create({
        data: { userId: ownerId, action: 'upload', entity: 'Upload', entityId: old },
      });
      await purger.check();
      expect(await prisma.upload.count({ where: { id: old } })).toBe(0);
      expect(await prisma.auditEntry.count({ where: { entityId: old } })).toBe(0);
      expect(await files.keys()).not.toContain(`pages/${old}/0.jpg`);
      expect(await prisma.upload.count({ where: { id: recent } })).toBe(1);
    });

    it('deletes nothing early when only one of the two clocks says it is time', async () => {
      const u = await upload('future.pdf');
      const m = await seed(2030, 1, 'חוות עתיד'); // deleted from 1 April 2030
      await ticket(u, m.monthId, m.groupId, 'Ann', { shiftDate: new Date(Date.UTC(2030, 0, 3)) });
      today = '2031-01-01'; // the settings say so; the database's clock does not
      try {
        await purger.check();
      } finally {
        today = '2026-11-20';
      }
      expect(await status(m.monthId)).toBe('open');
    });
  });

  it('deletes the lists only with the last open month, and never while a file is being read', async () => {
    const empty = async (year: number, month: number) => {
      const m = await prisma.month.create({ data: { year, month, status: 'closing' } });
      await purger.purge(m.id);
      expect(await status(m.id)).toBe('closed');
    };
    // Close every month still open, while a ticket is being read: the lists stay.
    const u = await upload('reading.pdf');
    const reading = await ticket(u, null, null, 'Ann', { status: 'processing' });
    for (const m of await prisma.month.findMany({ where: { status: 'open' } })) {
      await prisma.month.update({ where: { id: m.id }, data: { status: 'closing' } });
      await purger.purge(m.id);
    }
    expect(await prisma.listEntry.count()).toBeGreaterThan(0);
    // A file still being split into pages: the lists stay.
    await prisma.ticket.delete({ where: { id: reading.id } });
    await prisma.upload.update({ where: { id: u }, data: { s3KeyOriginal: 'uploads/x' } });
    await empty(2025, 2);
    expect(await prisma.listEntry.count()).toBeGreaterThan(0);
    // Nothing open, nothing being read: the nightly check deletes them (5.4)…
    await prisma.upload.update({ where: { id: u }, data: { s3KeyOriginal: null } });
    await purger.check();
    expect(await prisma.listEntry.count()).toBe(0);
    // …and so does closing a month when nothing else is open.
    await prisma.listEntry.create({ data: { kind: 'name', name: 'Ann' } });
    await empty(2025, 3);
    expect(await prisma.listEntry.count()).toBe(0);
  });
});
