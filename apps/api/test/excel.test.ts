// T3.1 "Done when": a month's Excel file (section 6.2), reopened with exceljs: every sheet, the rows
// per worker, a day with two kept tickets, the formulas, right-to-left view, safe sheet names and
// formula-injection escaping. Names here are invented.
import type { INestApplication } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { safe, sheetNames } from '../src/months/excel.ts';
import { monthOf } from '../src/months/months.service.ts';
import { createAdmin } from '../src/users/create-admin.ts';
import { Browser } from './helpers/browser.ts';
import { testApp } from './helpers/test-app.ts';
import { databaseUrl, testDatabase } from './helpers/test-db.ts';

const OWNER = { email: 'owner@example.com', password: 'owner password 1' };
const LONG = 'מקום עבודה עם שם ארוך מאוד מאוד מאוד';
const BAD = "ג'ו/קפה: [מרכז]?*";
const INJECT = '=HYPERLINK("x")';

describe('safe sheet names and text cells', () => {
  it('removes forbidden characters, cuts to 31 and numbers names that collide', () => {
    const names = sheetNames([
      'a/b\\c?d*e[f]g:h',
      'x'.repeat(40),
      'X'.repeat(40),
      "'q'",
      '',
      'שמות',
      'abc',
    ]);
    expect(names[0]).toBe('abcdefgh');
    expect(names[1]).toBe('x'.repeat(31));
    expect(names[2]).toBe('X'.repeat(27) + ' (2)'); // Excel compares sheet names ignoring capitals
    expect(names[3]).toBe('q');
    expect(names[4]).toBe('מקום עבודה');
    expect(names[5]).toBe('שמות (2)'); // the names sheet already has it
    expect(names[6]).toBe('abc'); // control characters
    for (const n of names) expect(n.length).toBeLessThanOrEqual(31);
  });

  it('puts an apostrophe before text Excel could take as a formula', () => {
    for (const s of ['=1+1', '+1', '-Ann', '@SUM(1)', '\tx', '\rx']) expect(safe(s)).toBe(`'${s}`);
    expect(safe('Dana')).toBe('Dana');
    expect(safe('דנה-כהן')).toBe('דנה-כהן');
  });
});

describe.skipIf(!databaseUrl)('the month Excel (T3.1)', () => {
  const db = testDatabase();
  const prisma = db.prisma;
  let app: INestApplication;
  let owner: Browser;
  let base: string;
  let monthId: string;
  let book: ExcelJS.Workbook;
  let headers: Headers;
  const all = { minutes: 0 };
  const byPlace = new Map<string, number>(); // place name → minutes
  const placeOf = new Map<string, string>(); // group id → place name
  let golan: string;
  let merged: string;

  beforeAll(async () => {
    await db.migrate();
    const ownerId = await createAdmin(prisma, OWNER.email, OWNER.password).then(
      async () => (await prisma.user.findFirstOrThrow()).id,
    );
    ({ app, base } = await testApp(db));
    owner = new Browser(base);
    await owner.login(OWNER.email, OWNER.password);

    monthId = (await monthOf(prisma, new Date('2026-11-01'))).id;
    const uploadId = (
      await prisma.upload.create({
        data: {
          uploadedById: ownerId,
          originalFilename: 'week.pdf',
          sha256: 'excel',
          mime: 'application/pdf',
          pageCount: 1,
        },
      })
    ).id;
    const group = async (displayName: string, mergedIntoId?: string) => {
      const { id } = await prisma.workplaceGroup.create({
        data: { monthId, displayName, normalisedName: displayName, mergedIntoId },
      });
      placeOf.set(id, displayName);
      return id;
    };
    let page = 0;
    const ticket = (
      groupId: string | null,
      day: number | null,
      minutes: number | null,
      more = {},
    ) =>
      prisma.ticket.create({
        data: {
          uploadId,
          monthId,
          pageIndex: page++,
          s3KeyPage: `p/${page}.jpg`,
          firstName: 'Kwame',
          workerName: 'Kwame',
          workplaceGroupId: groupId,
          workplaceRaw: 'as written',
          shiftDate: day === null ? null : new Date(Date.UTC(2026, 10, day)),
          totalMinutes: minutes,
          status: 'verified',
          ...more,
        },
      });
    const verified = async (groupId: string, day: number, minutes: number, more = {}) => {
      all.minutes += minutes;
      const place = placeOf.get(groupId)!;
      byPlace.set(place, (byPlace.get(place) ?? 0) + minutes);
      return ticket(groupId, day, minutes, more);
    };

    golan = await group('חוות גולן');
    const hadar = await group('בית הדר');
    merged = await group('חוות הגולן', golan);
    const waiting = await group('מקום ממתין');
    await group('מקום ריק');
    const first = await verified(golan, 2, 480);
    await verified(golan, 3, 300, { workerName: 'kwame ' }); // the same row (5.2)
    await verified(golan, 5, 480);
    await verified(golan, 5, 270); // "Keep both": one cell holds their sum
    await verified(golan, 2, 500, { firstName: 'דנה', workerName: 'Dana' });
    await verified(hadar, 4, 60, { firstName: 'אן', workerName: '-Ann' });
    for (const name of [`${LONG} א`, `${LONG} ב`, BAD, INJECT])
      await verified(await group(name), 1, 60);
    // Left out: not ready yet.
    await ticket(waiting, 6, 480, { status: 'needs_review' });
    await ticket(golan, 7, 480, { status: 'needs_manual_entry' });
    await ticket(null, 8, null, { status: 'processing' });
    // Removed (the sheet `לא נכללו`), including one removed before it was ever read.
    const removed = { status: 'excluded' as const, excludedById: ownerId };
    await ticket(null, 9, null, {
      ...removed,
      excludedReason: 'removed',
      firstName: null,
      workerName: null,
      workplaceRaw: null,
    });
    await ticket(golan, 2, 470, { ...removed, excludedReason: 'replaced', replacedById: first.id });
    await ticket(hadar, 4, 60, {
      ...removed,
      excludedReason: 'duplicate',
      firstName: '@SUM(1)',
      workerName: null,
    });

    const res = await owner.download(`/api/months/${monthId}/excel`);
    expect(res.status).toBe(200);
    headers = res.headers;
    order = (
      await prisma.workplaceGroup.findMany({
        where: { monthId, mergedIntoId: null },
        orderBy: { displayName: 'asc' },
      })
    ).map((g) => g.displayName);
    book = new ExcelJS.Workbook();
    await book.xlsx.load(res.bytes as unknown as ArrayBuffer);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await db.drop();
  });

  const sheet = (name: string) => book.getWorksheet(name)!;
  let order: string[] = [];
  /** The places with ready tickets, in the order the database sorts their names. */
  const places = () => order.filter((n) => byPlace.has(n));
  const day = (d: number) => d + 1; // column B is day 1

  it('is an xlsx download named after the month', () => {
    expect(headers.get('content-type')).toContain(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(headers.get('content-disposition')).toBe('attachment; filename="hours-2026-11.xlsx"');
  });

  it('has the totals sheet, one sheet per workplace with ready tickets, the names and the removed', () => {
    const names = book.worksheets.map((w) => w.name);
    expect(names[0]).toBe('סה"כ שעות');
    expect(names.slice(-2)).toEqual(['שמות', 'לא נכללו']);
    // The places in the month page's order (by name), each sheet named after its place.
    expect(names.slice(1, -2)).toEqual(sheetNames(places()));
    expect(new Set(names.slice(1, -2))).toEqual(
      new Set([
        'חוות גולן',
        'בית הדר',
        `${LONG} א`.slice(0, 31),
        `${LONG} ב`.slice(0, 27).trimEnd() + ' (2)',
        "ג'וקפה מרכז",
        INJECT,
      ]),
    );
    for (const n of names) expect(n.length).toBeLessThanOrEqual(31);
    for (const w of book.worksheets) expect(w.views[0]?.rightToLeft).toBe(true);
  });

  it('gives each worker one row of days, a day with two kept tickets their sum, and formulas', () => {
    const s = sheet('חוות גולן');
    expect(s.getCell('A1').value).toBe('עובד');
    for (let d = 1; d <= 31; d++) expect(s.getCell(1, day(d)).value).toBe(d);
    expect(s.getCell('AG1').value).toBe('סה"כ');
    // Empty, but boxed like the rest.
    expect((s.getRow(2).values as unknown[]).filter((v) => v != null)).toEqual([]);
    expect([3, 4].map((r) => s.getCell(r, 1).value)).toEqual(['Dana', 'Kwame']);
    // Exact minutes ÷ 60, shown with two decimals; nothing is rounded.
    expect(s.getCell(3, day(2)).value).toBe(500 / 60);
    expect(s.getCell(3, day(2)).numFmt).toBe('0.00');
    // Whole hours without decimals: 8, not 8.00 (Liam, D64).
    expect([s.getCell(4, day(2)).numFmt, s.getCell(4, day(3)).numFmt]).toEqual(['0', '0']);
    expect(s.getCell(4, day(5)).numFmt).toBe('0.00'); // 12.50
    expect(s.getCell(3, day(1)).value).toBeNull();
    expect(s.getCell(4, day(2)).value).toBe(480 / 60);
    expect(s.getCell(4, day(3)).value).toBe(300 / 60);
    expect(s.getCell(4, day(5)).value).toBe(750 / 60);
    expect(s.getCell('AG3').value).toEqual({ formula: 'SUM(B3:AF3)', result: 500 / 60 });
    expect(s.getCell('AG4').value).toEqual({ formula: 'SUM(B4:AF4)', result: 1530 / 60 });
    expect(s.getCell('A5').value).toBe('סה"כ');
    expect(s.getCell(5, day(2)).value).toEqual({ formula: 'SUM(C3:C4)', result: 980 / 60 });
    expect(s.getCell('AG5').value).toEqual({ formula: 'SUM(AG3:AG4)', result: 2030 / 60 });
    expect(s.rowCount).toBe(5);
  });

  it('looks like the agency’s own file: Arial, bold headings, orange and green, a grid (D64)', () => {
    const s = sheet('חוות גולן');
    const thin = { style: 'thin', color: { argb: 'FF000000' } };
    const grid = { top: thin, left: thin, bottom: thin, right: thin };
    const fill = (argb: string) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
    const heading = { name: 'Arial', size: 12, bold: true };
    // The heading row and the names column: bold, centred, light orange.
    for (const a of ['A1', 'B1', 'AG1', 'A3', 'A4']) {
      expect(s.getCell(a).font).toMatchObject(heading);
      expect(s.getCell(a).fill).toEqual(fill('FFF8CBAD'));
      expect(s.getCell(a).alignment).toMatchObject({ horizontal: 'center' });
      expect(s.getCell(a).border).toEqual(grid);
    }
    // Every day has a box, even an empty one; the row's total is bold.
    for (const a of ['B3', 'C3', 'AF4', 'B2', 'AG2']) expect(s.getCell(a).border).toEqual(grid);
    expect(s.getCell('B3').font).toMatchObject({ name: 'Arial', size: 11 });
    expect(s.getCell('B3').font.bold).toBeFalsy();
    expect(s.getCell('AG3').font).toMatchObject({ name: 'Arial', size: 11, bold: true });
    // The total row: light green, its name and the grand total bold.
    for (const a of ['A5', 'C5', 'AG5']) expect(s.getCell(a).fill).toEqual(fill('FFC5E0B4'));
    expect(s.getCell('A5').font).toMatchObject(heading);
    expect(s.getCell('AG5').font).toMatchObject(heading);
    expect(s.getCell('C5').font.bold).toBeFalsy();
    expect([s.getColumn(1).width, s.getColumn(2).width, s.getColumn(33).width]).toEqual([
      16, 5.6, 8.8,
    ]);
    expect(s.getRow(3).height).toBe(15.6);

    const t = sheet('סה"כ שעות');
    const last = t.rowCount;
    for (const a of ['A1', 'B1']) {
      expect(t.getCell(a).font).toMatchObject(heading);
      expect(t.getCell(a).fill).toEqual(fill('FFFFFF00'));
    }
    expect(t.getCell('A2').font).toMatchObject(heading);
    expect(t.getCell('B2').font).toMatchObject({ name: 'Arial', size: 12 });
    expect(t.getCell('B2').font.bold).toBeFalsy();
    for (const a of ['A2', 'B2']) {
      expect(t.getCell(a).alignment).toMatchObject({ horizontal: 'center' });
      expect(t.getCell(a).border).toEqual(grid);
    }
    for (const c of [1, 2]) {
      expect(t.getCell(last, c).font).toMatchObject({ name: 'Arial', size: 14, bold: true });
      expect(t.getCell(last, c).fill).toEqual(fill('FFFFFF00'));
    }
    expect([t.getColumn(1).width, t.getColumn(2).width]).toEqual([22, 13]);
  });

  it('adds up each workplace on the totals sheet, pointing at that sheet’s last row', () => {
    const t = sheet('סה"כ שעות');
    expect([t.getCell('A1').value, t.getCell('B1').value]).toEqual(['מקום עבודה', 'שעות']);
    const sheets = book.worksheets.slice(1, -2);
    sheets.forEach((w, i) => {
      const place = places()[i]!;
      // The place's full name, as text, beside a formula pointing at its sheet's grand total.
      expect(String(t.getCell(i + 2, 1).value).replace(/^'/, '')).toBe(place);
      const quoted = `'${w.name.replace(/'/g, "''")}'`;
      expect(t.getCell(i + 2, 2).value).toEqual({
        formula: `${quoted}!AG${w.rowCount}`,
        result: byPlace.get(place)! / 60,
      });
    });
    expect(byPlace.get('חוות גולן')).toBe(2030);
    const last = sheets.length + 2;
    expect(t.getCell(last, 1).value).toBe('סה"כ');
    expect(t.getCell(last, 2).value).toEqual({
      formula: `SUM(B2:B${last - 1})`,
      result: all.minutes / 60,
    });
  });

  it('lists each confirmed name once with its Hebrew spelling, ready to paste as the names list', () => {
    const rows = sheet('שמות').getSheetValues().filter(Boolean) as unknown[][];
    expect(rows.map((r) => r.slice(1))).toEqual([["'-Ann", 'אן'], ['Dana', 'דנה'], ['Kwame']]);
  });

  it('lists the removed tickets, even one never read, and leaves them out of every grid', () => {
    const s = sheet('לא נכללו');
    expect(s.getRow(1).values).toEqual([
      undefined,
      'מקום עבודה',
      'עובד',
      'תאריך',
      'שעות',
      'סיבה',
      'הוסר על ידי',
    ]);
    const rows = [2, 3, 4].map((r) => s.getRow(r));
    expect(rows.map((r) => r.getCell(5).value).sort()).toEqual(
      ['הוחלף בכרטיס חדש', 'הוסר', 'נסרק פעמיים'].sort(),
    );
    for (const r of rows) expect(r.getCell(6).value).toBe(OWNER.email);
    const unread = rows.find((r) => r.getCell(5).value === 'הוסר')!;
    expect([unread.getCell(1).value, unread.getCell(2).value, unread.getCell(4).value]).toEqual([
      null,
      null,
      null,
    ]);
    expect(unread.getCell(3).value).toEqual(new Date(Date.UTC(2026, 10, 9)));
    const replaced = rows.find((r) => r.getCell(5).value === 'הוחלף בכרטיס חדש')!;
    expect(replaced.getCell(1).value).toBe('חוות גולן');
    expect(replaced.getCell(4).value).toBe(470 / 60);
    const twice = rows.find((r) => r.getCell(5).value === 'נסרק פעמיים')!;
    expect(twice.getCell(2).value).toBe("'@SUM(1)");
    expect(s.rowCount).toBe(4);
    // The grids hold only the ready tickets: the replaced ticket's 470 is not on day 2.
    expect(sheet('חוות גולן').getCell(5, day(2)).value).toEqual({
      formula: 'SUM(C3:C4)',
      result: 980 / 60,
    });
    expect(book.getWorksheet('מקום ממתין')).toBeUndefined();
    expect(book.getWorksheet('מקום ריק')).toBeUndefined();
  });

  it('writes text that looks like a formula as text, with an apostrophe', () => {
    const t = sheet('סה"כ שעות');
    const cells = t.getColumn(1).values.filter((v) => typeof v === 'string');
    expect(cells).toContain(`'${INJECT}`);
    expect(sheet('בית הדר').getCell('A3').value).toBe("'-Ann");
    for (const w of book.worksheets) {
      w.eachRow((row) =>
        row.eachCell((c) => {
          if (c.type === ExcelJS.ValueType.Formula) {
            expect((c.value as ExcelJS.CellFormulaValue).formula).toMatch(/^(SUM\(|'.*'!AG\d+$)/);
          }
        }),
      );
    }
  });

  it('needs a login, a real month, and a month that is still open', async () => {
    expect((await new Browser(base).download(`/api/months/${monthId}/excel`)).status).toBe(401);
    expect((await owner.download('/api/months/not-a-month/excel')).status).toBe(404);
    expect(
      (await owner.download('/api/months/00000000-0000-4000-8000-000000000000/excel')).status,
    ).toBe(404);
    for (const status of ['closing', 'closed'] as const) {
      const m = await prisma.month.create({
        data: { year: 2025, month: status === 'closing' ? 1 : 2, status },
      });
      expect((await owner.download(`/api/months/${m.id}/excel`)).status).toBe(409);
    }
  });

  describe('refuses rather than leave hours out', () => {
    const refused = async (change: () => Promise<unknown>, undo: () => Promise<unknown>) => {
      await change();
      try {
        const res = await owner.send('GET', `/api/months/${monthId}/excel`);
        return res;
      } finally {
        await undo();
      }
    };
    const SORTING = 'Some tickets are still being sorted. Try again in a minute.';
    const anyReady = () =>
      prisma.ticket.findFirstOrThrow({ where: { monthId, status: 'verified' } });
    const set = (id: string, data: object) => prisma.ticket.update({ where: { id }, data });

    it('waits while a ready ticket is not sorted into a workplace yet', async () => {
      const t = await anyReady();
      const res = await refused(
        () => set(t.id, { workplaceGroupId: null }),
        () => set(t.id, { workplaceGroupId: t.workplaceGroupId }),
      );
      expect(res).toMatchObject({ status: 409, body: { message: SORTING } });
    });

    it('waits while a ready ticket is still in a place merged away', async () => {
      const t = await anyReady();
      const res = await refused(
        () => set(t.id, { workplaceGroupId: merged }),
        () => set(t.id, { workplaceGroupId: t.workplaceGroupId }),
      );
      expect(res).toMatchObject({ status: 409, body: { message: SORTING } });
    });

    it('waits while a ready ticket is dated in another month', async () => {
      const t = await anyReady();
      const res = await refused(
        () => set(t.id, { shiftDate: new Date(Date.UTC(2026, 11, 1)) }),
        () => set(t.id, { shiftDate: t.shiftDate }),
      );
      expect(res).toMatchObject({ status: 409, body: { message: SORTING } });
    });

    it('refuses a ready ticket with no hours or no date', async () => {
      const t = await anyReady();
      for (const data of [{ totalMinutes: null }, { shiftDate: null }]) {
        const res = await refused(
          () => set(t.id, data),
          () => set(t.id, { totalMinutes: t.totalMinutes, shiftDate: t.shiftDate }),
        );
        expect(res.status).toBe(500);
      }
    });
  });

  it('is never kept by the browser', async () => {
    const res = await owner.download(`/api/months/${monthId}/excel`);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });
});
