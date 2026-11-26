// D68: other tickets (not Tally's), never read; a person types each one from its scan, with one or
// more shifts, each a ticket of its own sharing the scan. Names here are invented.
import type { INestApplication } from '@nestjs/common';
import { imageToJpeg, pdfToImages } from '@tally/shared/imaging';
import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Purger } from '../src/months/purge.ts';
import { ReadingConfig } from '../src/reading/config.ts';
import { createAdmin } from '../src/users/create-admin.ts';
import { Browser } from './helpers/browser.ts';
import { slipsPdf } from './helpers/slips.ts';
import { testApp } from './helpers/test-app.ts';
import { databaseUrl, testDatabase } from './helpers/test-db.ts';
import { storageConfigured, testStorage } from './helpers/test-storage.ts';

const OWNER = { email: 'owner@example.com', password: 'owner password 1' };
const STALE = 'Someone else changed this ticket. Reload it.';

describe.skipIf(!databaseUrl || !storageConfigured)('other tickets, typed in (D68)', () => {
  const db = testDatabase();
  const prisma = db.prisma;
  const files = testStorage();
  let app: INestApplication;
  let owner: Browser;
  let uploadId: string;
  let page = 0;
  let scan: Buffer;
  const config = new ReadingConfig(
    () => {
      throw new Error('other tickets are never read');
    },
    () => ({ today: '2026-11-21', minShiftHours: 2, maxShiftHours: 16, maxDateAgeDays: 45 }),
    false,
  );

  beforeAll(async () => {
    await Promise.all([db.migrate(), files.create()]);
    await createAdmin(prisma, OWNER.email, OWNER.password);
    let base: string;
    ({ app, base } = await testApp(db, { reading: config, storage: files.storage }));
    owner = new Browser(base);
    await owner.login(OWNER.email, OWNER.password);
    scan = await imageToJpeg((await pdfToImages(Buffer.from(await slipsPdf(1, 'other'))))[0]!);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await files.drop();
    await db.drop();
  });

  beforeEach(async () => {
    await prisma.upload.deleteMany();
    await prisma.workplaceGroup.deleteMany();
    await prisma.download.deleteMany();
    await prisma.month.deleteMany();
    await prisma.listEntry.deleteMany();
    uploadId = (
      await prisma.upload.create({
        data: {
          uploadedById: (await prisma.user.findFirstOrThrow()).id,
          originalFilename: 'other.pdf',
          sha256: `s${Math.random()}`,
          mime: 'application/pdf',
          pageCount: 1,
          freeForm: true,
        },
      })
    ).id;
  });

  /** An other ticket as the splitter leaves it, with its scan in storage. */
  async function other() {
    const s3KeyPage = `pages/${uploadId}/${page}.jpg`;
    await files.storage.put(s3KeyPage, scan, 'image/jpeg');
    return prisma.ticket.create({
      data: {
        uploadId,
        pageIndex: page++,
        s3KeyPage,
        freeForm: true,
        status: 'needs_manual_entry',
      },
    });
  }
  type Shift = { id?: string; version?: number; date: string; hours: string; accept?: string[] };
  const save = (id: string, shifts: Shift[], more: Record<string, unknown> = {}) =>
    owner.send('PUT', `/api/tickets/${id}/free-form`, {
      workerName: 'Kwame',
      workplace: 'Golan Farm',
      shifts,
      ...more,
    });
  /** Every shift of the scan, as the form gets them. */
  const shifts = async (id: string) =>
    (await owner.send('GET', `/api/tickets/${id}`)).body.shifts as {
      id: string;
      version: number;
      status: string;
      readOnly: boolean;
      flags: { code: string }[];
    }[];
  /** The scan's own row, which the form shows as its first, empty line. */
  const head = (t: { id: string; version: number }) => ({ id: t.id, version: t.version });
  const rows = () =>
    prisma.ticket.findMany({ where: { uploadId }, orderBy: { shiftIndex: 'asc' } });

  it('saves each shift as a ticket of its own, in its own month, sharing the scan', async () => {
    const t = await other();
    const res = await save(t.id, [
      { ...head(t), date: '30/10/26', hours: '7:30' },
      { date: '02/11/26', hours: '8' },
      { date: '03/11/26', hours: '7,5' },
    ]);
    expect(res.status).toBe(200);
    const [a, b, c] = await rows();
    for (const s of [a, b, c]) {
      expect(s).toMatchObject({
        status: 'verified',
        verifiedHow: 'manual',
        workerName: 'Kwame',
        workplaceRaw: 'Golan Farm',
        freeForm: true,
        s3KeyPage: t.s3KeyPage,
        startMinutes: null,
        endMinutes: null,
        firstName: null,
      });
    }
    expect([a!.totalMinutes, b!.totalMinutes, c!.totalMinutes]).toEqual([450, 480, 450]);
    const months = await prisma.month.findMany({ orderBy: { month: 'asc' } });
    expect(a!.monthId).toBe(months[0]!.id); // October
    expect([b!.monthId, c!.monthId]).toEqual([months[1]!.id, months[1]!.id]); // November
    // Any shift's id opens the same form.
    expect((await shifts(c!.id)).map((s) => s.id)).toEqual([a!.id, b!.id, c!.id]);
    // November's workplace PDF shows the scan once, though two shifts come from it.
    const pdf = await owner.download(
      `/api/months/${months[1]!.id}/pdfs?workplace=${b!.workplaceGroupId}`,
    );
    expect(pdf.status).toBe(200);
    expect((await PDFDocument.load(pdf.bytes)).getPageCount()).toBe(1);
    // The upload's progress counts pages, not shifts.
    const progress = (await owner.send('GET', '/api/progress')).body as {
      tickets: { verified: number };
    }[];
    expect(progress[0]!.tickets.verified).toBe(1);
  });

  it('refuses hours it would have to guess, and takes 8, 7:30, 7.5 and 7,75', async () => {
    const t = await other();
    const res = await save(t.id, [{ ...head(t), date: '02/11/26', hours: '7.30' }]);
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('Type the hours like 8, 7:30 or 7.5.');
    expect((await save(t.id, [{ ...head(t), date: '02/11/26', hours: '0' }])).status).toBe(400);
    expect((await save(t.id, [{ ...head(t), date: '02/11/26', hours: '7,75' }])).status).toBe(200);
    expect((await rows())[0]!.totalMinutes).toBe(465);
  });

  it('warns about long hours until confirmed; a future date must be corrected', async () => {
    const t = await other();
    await save(t.id, [{ ...head(t), date: '02/11/26', hours: '18' }]);
    let [s] = await shifts(t.id);
    expect(s).toMatchObject({ status: 'needs_review' });
    expect(s!.flags.map((f) => f.code)).toEqual(['HOURS_OUT_OF_RANGE']);
    // A warning on a new line cannot be confirmed before it was shown.
    const early = await save(t.id, [
      { id: s!.id, version: s!.version, date: '02/11/26', hours: '18' },
      { date: '04/11/26', hours: '18', accept: ['HOURS_OUT_OF_RANGE'] },
    ]);
    expect(early.status).toBe(400);
    const ok = await save(t.id, [
      {
        id: s!.id,
        version: s!.version,
        date: '02/11/26',
        hours: '18',
        accept: ['HOURS_OUT_OF_RANGE'],
      },
    ]);
    expect(ok.status).toBe(200);
    [s] = await shifts(t.id);
    expect(s).toMatchObject({ status: 'verified' });

    await save(t.id, [{ id: s!.id, version: s!.version, date: '25/11/26', hours: '8' }]);
    [s] = await shifts(t.id);
    expect(s!.flags.map((f) => f.code)).toEqual(['DATE_IN_FUTURE']);
    expect(s).toMatchObject({ status: 'needs_review' });
    expect((await rows())[0]!.monthId).toBeNull();
  });

  it('names every shift it changes or removes: anything else is a conflict', async () => {
    const t = await other();
    await save(t.id, [
      { ...head(t), date: '02/11/26', hours: '8' },
      { date: '03/11/26', hours: '8' },
    ]);
    const [a, b] = await shifts(t.id);
    // Leaving out a shift is not removing it.
    const missing = await save(t.id, [
      { id: a!.id, version: a!.version, date: '02/11/26', hours: '6' },
    ]);
    expect(missing.status).toBe(409);
    expect(missing.body.message).toBe(STALE);
    // A version someone else has moved on from.
    const old = await save(t.id, [
      { id: a!.id, version: a!.version - 1, date: '02/11/26', hours: '6' },
      { id: b!.id, version: b!.version, date: '03/11/26', hours: '8' },
    ]);
    expect(old.status).toBe(409);
    expect((await rows()).map((r) => r.totalMinutes)).toEqual([480, 480]);

    const monthId = (await rows())[1]!.monthId!;
    const before = (await prisma.month.findUniqueOrThrow({ where: { id: monthId } }))
      .lastActivityAt;
    const removed = await save(
      t.id,
      [{ id: a!.id, version: a!.version, date: '02/11/26', hours: '6' }],
      { remove: [{ id: b!.id, version: b!.version }] },
    );
    expect(removed.status).toBe(200);
    expect((await rows()).map((r) => r.totalMinutes)).toEqual([360]);
    const after = (await prisma.month.findUniqueOrThrow({ where: { id: monthId } })).lastActivityAt;
    expect(after.getTime()).toBeGreaterThan(before.getTime());
  });

  it('never removes a shift that replaced a duplicate ticket', async () => {
    const t = await other();
    await save(t.id, [
      { ...head(t), date: '02/11/26', hours: '8' },
      { date: '03/11/26', hours: '8' },
    ]);
    const [a, b] = await shifts(t.id);
    const older = await prisma.ticket.create({
      data: {
        uploadId,
        pageIndex: page++,
        s3KeyPage: t.s3KeyPage,
        status: 'excluded',
        excludedReason: 'replaced',
        replacedById: b!.id,
      },
    });
    const res = await save(
      t.id,
      [{ id: a!.id, version: a!.version, date: '02/11/26', hours: '8' }],
      {
        remove: [{ id: b!.id, version: b!.version }],
      },
    );
    expect(res.status).toBe(400);
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: older.id } })).replacedById).toBe(
      b!.id,
    );
  });

  it('asks about the same worker, place and day on two scans', async () => {
    const [first, second] = [await other(), await other()];
    await save(first.id, [{ ...head(first), date: '02/11/26', hours: '8' }]);
    await save(second.id, [{ ...head(second), date: '02/11/26', hours: '8' }]);
    const [s] = await shifts(second.id);
    expect(s!.flags.map((f) => f.code)).toContain('POSSIBLE_DUPLICATE');
  });

  it('pre-ticks nothing by itself: the 57 box is what the person saved, on every shift', async () => {
    const t = await other();
    await save(
      t.id,
      [
        { ...head(t), date: '02/11/26', hours: '8' },
        { date: '03/11/26', hours: '8' },
      ],
      {
        rate57: true,
      },
    );
    expect((await rows()).map((r) => r.rate57)).toEqual([true, true]);
  });

  it('removes the whole scan, is never read again, and keeps to its own form', async () => {
    const t = await other();
    await save(t.id, [
      { ...head(t), date: '02/11/26', hours: '8' },
      { date: '03/11/26', hours: '8' },
    ]);
    const [a, b] = await shifts(t.id);
    const reread = await owner.send('POST', `/api/tickets/${b!.id}/reprocess`, {
      version: b!.version,
    });
    expect(reread.status).toBe(400);
    const tally = await owner.send('PUT', `/api/tickets/${a!.id}`, {
      version: a!.version,
      values: {
        firstName: 'Kwame',
        workplace: 'Golan Farm',
        date: '02/11/26',
        startTime: '08:00',
        endTime: '16:00',
        totalWorked: '8:00',
      },
      workerName: 'Kwame',
    });
    expect(tally.status).toBe(400);
    const gone = await owner.send('POST', `/api/tickets/${b!.id}/exclude`, { version: b!.version });
    expect(gone.status).toBe(204);
    expect((await rows()).map((r) => r.status)).toEqual(['excluded', 'excluded']);
    expect((await shifts(a!.id)).every((s) => s.readOnly)).toBe(true);
  });

  it('closing waits for one not typed in yet, and keeps a scan another month still needs', async () => {
    const waiting = await other();
    const t = await other();
    await save(t.id, [
      { ...head(t), date: '30/10/26', hours: '8' },
      { date: '02/11/26', hours: '8' },
    ]);
    const [oct] = await rows().then((r) => r.filter((x) => x.id !== waiting.id));
    const close = async () => {
      await owner.download(`/api/months/${oct!.monthId}/excel`);
      await owner.download(`/api/months/${oct!.monthId}/pdfs`);
      return owner.send('POST', `/api/months/${oct!.monthId}/close`, { name: 'October 2026' });
    };
    const refused = await close();
    expect(refused.status).toBe(409);
    expect(refused.body.message).toBe(
      '1 ticket has no date yet. Fix its date or remove it before closing the month.',
    );
    await owner.send('POST', `/api/tickets/${waiting.id}/exclude`, { version: waiting.version });
    expect((await close()).status).toBe(202);
    await app.get(Purger).purge(oct!.monthId!);
    // October's shift is gone; November's shift still has the scan.
    expect(await prisma.ticket.count({ where: { id: oct!.id } })).toBe(0);
    expect(await files.storage.get(t.s3KeyPage)).not.toBeNull();
  });
});
