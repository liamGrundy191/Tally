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
    ]);
    expect(names[0]).toBe('abcdefgh');
    expect(names[1]).toBe('x'.repeat(31));
    expect(names[2]).toBe('X'.repeat(27) + ' (2)'); // Excel compares sheet names ignoring capitals
    expect(names[3]).toBe('q');
    expect(names[4]).toBe('מקום עבודה');
    expect(names[5]).toBe('שמות (2)'); // the names sheet already has it
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
    const group = async (displayName: string, mergedIntoId?: string) =>
      (
        await prisma.workplaceGroup.create({
          data: { monthId, displayName, normalisedName: displayName, mergedIntoId },
        })
      ).id;
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
      return ticket(groupId, day, minutes, more);
    };

    const golan = await group('חוות גולן');
    const hadar = await group('בית הדר');
    const merged = await group('חוות הגולן', golan);
    const waiting = await group('מקום ממתין');
    await group('מקום ריק');
    const first = await verified(golan, 2, 480);
    await verified(golan, 3, 300, { workerName: 'kwame ' }); // the same row (5.2)
    await verified(golan, 5, 480);
    await verified(golan, 5, 270); // "Keep both": one cell holds their sum
    await verified(golan, 2, 500, { firstName: 'דנה', workerName: 'Dana' });
    await verified(merged, 20, 120, { firstName: 'Dana', workerName: 'Dana' }); // its place merged
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
    book = new ExcelJS.Workbook();
    await book.xlsx.load(res.bytes as unknown as ArrayBuffer);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await db.drop();
  });

  const sheet = (name: string) => book.getWorksheet(name)!;
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
    expect(s.getRow(2).cellCount).toBe(0);
    expect([3, 4].map((r) => s.getCell(r, 1).value)).toEqual(['Dana', 'Kwame']);
    // Exact minutes ÷ 60, shown with two decimals; nothing is rounded.
    expect(s.getCell(3, day(2)).value).toBe(500 / 60);
    expect(s.getCell(3, day(20)).value).toBe(120 / 60); // from the merged place
    expect(s.getCell(3, day(2)).numFmt).toBe('0.00');
    expect(s.getCell(3, day(1)).value).toBeNull();
    expect(s.getCell(4, day(2)).value).toBe(480 / 60);
    expect(s.getCell(4, day(3)).value).toBe(300 / 60);
    expect(s.getCell(4, day(5)).value).toBe(750 / 60);
    expect(s.getCell('AG3').value).toEqual({ formula: 'SUM(B3:AF3)', result: 620 / 60 });
    expect(s.getCell('AG4').value).toEqual({ formula: 'SUM(B4:AF4)', result: 1530 / 60 });
    expect(s.getCell('A5').value).toBe('סה"כ');
    expect(s.getCell(5, day(2)).value).toEqual({ formula: 'SUM(C3:C4)', result: 980 / 60 });
    expect(s.getCell('AG5').value).toEqual({ formula: 'SUM(AG3:AG4)', result: 2150 / 60 });
    expect(s.rowCount).toBe(5);
  });

  it('adds up each workplace on the totals sheet, pointing at that sheet’s last row', () => {
    const t = sheet('סה"כ שעות');
    expect([t.getCell('A1').value, t.getCell('B1').value]).toEqual(['מקום עבודה', 'שעות']);
    const places = book.worksheets.slice(1, -2);
    places.forEach((w, i) => {
      const a = t.getCell(i + 2, 1).value;
      expect(typeof a === 'string' && a.replace(/^'/, '')).toBeTruthy();
      const quoted = `'${w.name.replace(/'/g, "''")}'`;
      expect((t.getCell(i + 2, 2).value as ExcelJS.CellFormulaValue).formula).toBe(
        `${quoted}!AG${w.rowCount}`,
      );
    });
    const golan = places.findIndex((w) => w.name === 'חוות גולן') + 2;
    expect((t.getCell(golan, 2).value as ExcelJS.CellFormulaValue).result).toBe(2150 / 60);
    const last = places.length + 2;
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

  it('refuses rather than leave out a ready ticket it cannot place', async () => {
    const t = await prisma.ticket.findFirstOrThrow({ where: { monthId, status: 'verified' } });
    await prisma.ticket.update({ where: { id: t.id }, data: { workplaceGroupId: null } });
    try {
      expect((await owner.download(`/api/months/${monthId}/excel`)).status).toBe(500);
    } finally {
      await prisma.ticket.update({
        where: { id: t.id },
        data: { workplaceGroupId: t.workplaceGroupId },
      });
    }
  });
});
