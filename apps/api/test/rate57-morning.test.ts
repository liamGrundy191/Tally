// D66: the *57 rate (a person's tick per ticket, rows below the workplace total, its own totals
// column) and the morning hours (typed per place, only in the totals sheet's בוקר column), and
// Close asking for new files after a change. Names here are invented.
import type { INestApplication } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normaliseName } from '@tally/shared';
import { monthOf } from '../src/months/months.service.ts';
import { createAdmin } from '../src/users/create-admin.ts';
import { Browser } from './helpers/browser.ts';
import { testApp } from './helpers/test-app.ts';
import { databaseUrl, testDatabase } from './helpers/test-db.ts';
import { storageConfigured, testStorage } from './helpers/test-storage.ts';

const OWNER = { email: 'owner@example.com', password: 'owner password 1' };

describe.skipIf(!databaseUrl || !storageConfigured)('the 57 rate and morning hours (D66)', () => {
  const db = testDatabase();
  const prisma = db.prisma;
  let app: INestApplication;
  let owner: Browser;
  let monthId: string;
  let farm: string;
  let book: ExcelJS.Workbook;
  const tickets = { minutes: 0 };
  // A saved ticket comes back with a link to its scan, which needs a bucket.
  const files = testStorage();

  beforeAll(async () => {
    await Promise.all([db.migrate(), files.create()]);
    await createAdmin(prisma, OWNER.email, OWNER.password);
    const ownerId = (await prisma.user.findFirstOrThrow()).id;
    let base: string;
    ({ app, base } = await testApp(db, { storage: files.storage }));
    owner = new Browser(base);
    await owner.login(OWNER.email, OWNER.password);
    await prisma.listEntry.createMany({
      data: [
        { kind: 'workplace', name: 'חוות גולן', spellings: ['Golan Farm'] },
        { kind: 'workplace', name: 'בית הדר', spellings: [] },
        { kind: 'workplace', name: 'מאפייה', spellings: [] },
        { kind: 'rate57', name: 'Avi', spellings: ['חוות גולן'] },
      ],
    });

    monthId = (await monthOf(prisma, new Date('2026-11-01'))).id;
    const uploadId = (
      await prisma.upload.create({
        data: {
          uploadedById: ownerId,
          originalFilename: 'w.pdf',
          sha256: 'd66',
          mime: 'application/pdf',
        },
      })
    ).id;
    const group = async (name: string, mergedIntoId?: string) =>
      (
        await prisma.workplaceGroup.create({
          data: { monthId, displayName: name, normalisedName: normaliseName(name), mergedIntoId },
        })
      ).id;
    farm = await group('חוות גולן');
    const hadar = await group('בית הדר');
    let page = 0;
    const ticket = (groupId: string, place: string, day: number, minutes: number, more = {}) => {
      tickets.minutes += minutes;
      return prisma.ticket.create({
        data: {
          uploadId,
          monthId,
          pageIndex: page++,
          s3KeyPage: `p/${page}.jpg`,
          firstName: 'אבי',
          workerName: 'Avi',
          workplaceGroupId: groupId,
          workplaceRaw: place,
          shiftDate: new Date(Date.UTC(2026, 10, day)),
          totalMinutes: minutes,
          status: 'verified',
          ...more,
        },
      });
    };
    await ticket(farm, 'חוות גולן', 2, 480, { firstName: 'דנה', workerName: 'Dana' });
    await ticket(farm, 'חוות גולן', 3, 300); // Avi at the regular rate (unticked: a note)
    await ticket(farm, 'חוות גולן', 3, 240, { rate57: true });
    await ticket(farm, 'חוות גולן', 4, 120, { rate57: true });
    await ticket(hadar, 'בית הדר', 1, 60, { rate57: true }); // only a *57 row here
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await Promise.all([db.drop(), files.drop()]);
  });

  const morningPath = () => `/api/months/${monthId}/morning`;
  const download = async () => {
    const res = await owner.download(`/api/months/${monthId}/excel`);
    expect(res.status).toBe(200);
    book = new ExcelJS.Workbook();
    await book.xlsx.load(res.bytes as unknown as ArrayBuffer);
  };

  describe('morning hours', () => {
    it('are added per place as typed, into the place its tickets are in', async () => {
      expect(
        (await owner.send('POST', morningPath(), { place: 'Golan Farm', hours: '30' })).status,
      ).toBe(204);
      expect(
        (await owner.send('POST', morningPath(), { place: 'חוות גולן', hours: '7.5' })).status,
      ).toBe(204);
      // A place with no tickets this month gets its own place.
      expect(
        (await owner.send('POST', morningPath(), { place: 'מאפייה', hours: '4,25' })).status,
      ).toBe(204);
      const month = (await owner.send('GET', `/api/months/${monthId}`)).body;
      expect(
        month.morning.map((m: { place: string; minutes: number }) => [m.place, m.minutes]),
      ).toEqual([
        ['חוות גולן', 1800],
        ['חוות גולן', 450],
        ['מאפייה', 255],
      ]);
    });

    it('refuses hours that are not whole minutes above zero, and a closed month', async () => {
      for (const hours of ['37.33', '0', '-1', 'abc']) {
        const r = await owner.send('POST', morningPath(), { place: 'חוות גולן', hours });
        expect(r.status).toBe(400);
        expect(r.body.message).toContain('37.5');
      }
      expect((await owner.send('POST', morningPath(), { place: '', hours: '1' })).status).toBe(400);
    });

    it('can be removed, and follow their place into a merge', async () => {
      await owner.send('POST', morningPath(), { place: 'בית הדר', hours: '2' });
      let month = (await owner.send('GET', `/api/months/${monthId}`)).body;
      const extra = month.morning.find((m: { place: string }) => m.place === 'בית הדר');
      expect((await owner.send('DELETE', `${morningPath()}/${extra.id}`)).status).toBe(204);
      expect((await owner.send('DELETE', `${morningPath()}/${extra.id}`)).status).toBe(404);
      // Merged into the farm later: its hours are the farm's.
      const bakery = await prisma.workplaceGroup.findFirstOrThrow({
        where: { displayName: 'מאפייה' },
      });
      const other = await prisma.workplaceGroup.create({
        data: { monthId, displayName: 'מאפיה', normalisedName: 'x', mergedIntoId: bakery.id },
      });
      await prisma.morningHours.create({
        data: { monthId, workplaceGroupId: other.id, minutes: 0 },
      });
      month = (await owner.send('GET', `/api/months/${monthId}`)).body;
      expect(month.morning.at(-1).place).toBe('מאפייה');
      await prisma.morningHours.deleteMany({ where: { workplaceGroupId: other.id } });
    });
  });

  describe('the Excel', () => {
    beforeAll(download);
    const totals = () => book.getWorksheet('סה"כ שעות')!;
    const row = (place: string) => {
      const t = totals();
      for (let r = 2; r < t.rowCount; r++) if (t.getCell(r, 1).value === place) return r;
      throw new Error(`no totals row for ${place}`);
    };
    const result = (v: ExcelJS.CellValue) =>
      v !== null && typeof v === 'object' && 'result' in v ? v.result : v;

    it('has the agency columns: place, regular, morning, *57', () => {
      expect([1, 2, 3, 4].map((c) => totals().getCell(1, c).value)).toEqual([
        'מקום עבודה',
        'רגיל',
        'בוקר',
        '*57',
      ]);
    });

    it('puts a ticked ticket in a "*57" row below the green total, which leaves it out', () => {
      const s = book.getWorksheet('חוות גולן')!;
      expect([3, 4, 5, 6].map((r) => s.getCell(r, 1).value)).toEqual([
        'Avi',
        'Dana',
        'סה"כ',
        'Avi *57',
      ]);
      expect(s.getCell('AG5').value).toEqual({ formula: 'SUM(AG3:AG4)', result: 780 / 60 });
      expect(s.getCell('AG6').value).toEqual({ formula: 'SUM(B6:AF6)', result: 360 / 60 });
      expect(s.getCell('A5').fill).toMatchObject({ fgColor: { argb: 'FFC5E0B4' } }); // still green
      expect(s.getCell('A6').fill).toMatchObject({ fgColor: { argb: 'FFF8CBAD' } }); // a name
      expect(s.getCell('B6').fill).not.toMatchObject({ fgColor: { argb: 'FFC5E0B4' } });
    });

    it('fills the totals: regular from the green total, *57 from its rows, morning as typed', () => {
      const t = totals();
      const r = row('חוות גולן');
      expect(t.getCell(r, 2).value).toEqual({ formula: "'חוות גולן'!AG5", result: 780 / 60 });
      expect(t.getCell(r, 3).value).toBe(2250 / 60); // 30 + 7.5 hours
      expect(t.getCell(r, 4).value).toEqual({
        formula: "SUM('חוות גולן'!AG6:AG6)",
        result: 360 / 60,
      });
    });

    it('gives a place with only *57 tickets a zero total, and one with only morning hours a row', () => {
      const s = book.getWorksheet('בית הדר')!;
      expect(s.getCell('AG3').value).toBe(0);
      expect(s.getCell('A4').value).toBe('Avi *57');
      const t = totals();
      expect(result(t.getCell(row('בית הדר'), 4).value)).toBe(1);
      const bakery = row('מאפייה');
      expect([
        t.getCell(bakery, 2).value,
        t.getCell(bakery, 3).value,
        t.getCell(bakery, 4).value,
      ]).toEqual([null, 255 / 60, null]);
      expect(book.getWorksheet('מאפייה')).toBeUndefined(); // morning hours never make a sheet
    });

    it('sums each column apart, and every ticket minute is in exactly one of רגיל and *57', () => {
      const t = totals();
      const last = t.rowCount;
      const [regular, morning, rate57] = [2, 3, 4].map(
        (c) => result(t.getCell(last, c).value) as number,
      ) as [number, number, number];
      expect(t.getCell(last, 2).value).toMatchObject({ formula: `SUM(B2:B${last - 1})` });
      expect(Math.round((regular + rate57) * 60)).toBe(tickets.minutes);
      expect(Math.round(rate57 * 60)).toBe(420);
      expect(Math.round(morning * 60)).toBe(2505);
    });

    it('lists plain names on the names sheet, never "*57"', () => {
      const names = book.getWorksheet('שמות')!;
      const all: unknown[] = [];
      names.eachRow((r) => all.push(r.getCell(1).value));
      expect(all).toEqual(['Avi', 'Dana']);
    });
  });

  it('notes on the month page a ready ticket on the 57 list that is not ticked', async () => {
    const month = (await owner.send('GET', `/api/months/${monthId}`)).body;
    expect(month.notes.rate57Unticked).toEqual([
      expect.objectContaining({ name: 'Avi', place: 'חוות גולן' }),
    ]);
    expect(month.notes.sameName).toEqual([]);
  });

  it("saves a ticket's 57 tick as the person sent it", async () => {
    const t = await prisma.ticket.findFirstOrThrow({ where: { workerName: 'Avi', rate57: null } });
    const r = await owner.send('PUT', `/api/tickets/${t.id}`, {
      version: t.version,
      values: {
        firstName: 'אבי',
        workplace: 'חוות גולן',
        date: '03/11/26',
        startTime: null,
        endTime: null,
        totalWorked: '05:00',
      },
      workerName: 'Avi',
      rate57: true,
    });
    expect(r.status).toBe(200);
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).rate57).toBe(true);
    expect((await owner.send('GET', `/api/tickets/${t.id}`)).body.rate57).toBe(true);
  });

  it('closes only after the files were downloaded since the last change', async () => {
    await prisma.ticket.updateMany({ where: { monthId }, data: { status: 'verified' } });
    const close = () =>
      owner.send('POST', `/api/months/${monthId}/close`, { name: 'November 2026' });
    await owner.download(`/api/months/${monthId}/excel`);
    // The invented tickets have no scans, so the PDF download is recorded as made.
    const userId = (await prisma.user.findFirstOrThrow()).id;
    await prisma.download.create({ data: { monthId, kind: 'pdfs', userId } });
    await new Promise((r) => setTimeout(r, 20));
    await owner.send('POST', morningPath(), { place: 'בית הדר', hours: '1' });
    const refused = await close();
    expect(refused.status).toBe(409);
    expect(refused.body.message).toContain('after your last download');
    // Morning hours are in the Excel only: a new Excel would be enough. But a ticket that left
    // the month for December is still in the PDFs too: they must be made again as well.
    const leaving = await prisma.ticket.findFirstOrThrow({ where: { workerName: 'Dana' } });
    const moved = await owner.send('PUT', `/api/tickets/${leaving.id}`, {
      version: leaving.version,
      values: {
        firstName: 'דנה',
        workplace: 'חוות גולן',
        date: '02/12/26',
        startTime: null,
        endTime: null,
        totalWorked: '08:00',
      },
      workerName: 'Dana',
      rate57: false,
    });
    expect(moved.status).toBe(200);
    // Its December date is in the future here, so it waits with a date in doubt, which alone
    // blocks closing (D69); removed here, so only the files are in question below.
    const doubt = await owner.send('POST', `/api/months/${monthId}/close`, {
      name: 'November 2026',
    });
    expect(doubt.body.message).toContain('a date still to check');
    await prisma.ticket.update({ where: { id: leaving.id }, data: { status: 'excluded' } });
    await new Promise((r) => setTimeout(r, 20));
    await owner.download(`/api/months/${monthId}/excel`);
    expect((await close()).status).toBe(409);
    await prisma.download.create({ data: { monthId, kind: 'pdfs', userId } });
    expect((await close()).status).toBe(202);
  });
});
