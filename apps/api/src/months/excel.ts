// The month's Excel file (section 6.2): a totals sheet, one sheet per workplace with a row per
// worker and a column per day, the names, and the removed tickets. Only ready (verified) tickets
// are counted (6.1). Minutes stay whole numbers; a cell holds exact minutes ÷ 60 and only shows two
// decimals (D37).
import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { hasHebrew } from '@tally/shared';
import ExcelJS from 'exceljs';
import { type Prisma, PrismaClient } from '../generated/prisma/client.ts';
import { rowKey } from './organiser.ts';
import { MonthsService } from './months.service.ts';

// The columns, in one place (6.2).
const TOTALS = 'סה"כ שעות';
const NAMES = 'שמות';
const REMOVED = 'לא נכללו';
const TOTAL = 'סה"כ';
// The agency's columns (D66): ticket hours, morning hours typed by a person, and the *57 rate.
const TOTALS_HEADINGS = ['מקום עבודה', 'רגיל', 'בוקר', '*57'];
const WORKER = 'עובד';
const DAYS = 31; // columns B to AF; AG is the row's total
const TOTAL_COLUMN = DAYS + 2;
const REMOVED_HEADINGS = ['מקום עבודה', 'עובד', 'תאריך', 'שעות', 'סיבה', 'הוסר על ידי'];
const REASONS: Record<string, string> = {
  removed: 'הוסר',
  replaced: 'הוחלף בכרטיס חדש',
  duplicate: 'נסרק פעמיים',
};
/** Whole hours show as 8, others with two decimals as 7.50 (Liam, D64; D37). */
const hours = (minutes: number) => (minutes % 60 === 0 ? '0' : '0.00');
const RTL = { views: [{ rightToLeft: true }] };

// The look of the agency's own file (D64), as fixed colours so it shows the same on any computer.
const thin = { style: 'thin', color: { argb: 'FF000000' } } as const;
const GRID: Partial<ExcelJS.Borders> = { top: thin, left: thin, bottom: thin, right: thin };
const fill = (argb: string): ExcelJS.Fill => ({
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb },
});
const ORANGE = fill('FFF8CBAD');
const GREEN = fill('FFC5E0B4');
const YELLOW = fill('FFFFFF00');
const font = (size: number, bold = false): Partial<ExcelJS.Font> => ({ name: 'Arial', size, bold });
const CENTER: Partial<ExcelJS.Alignment> = { horizontal: 'center' };
const ROW_HEIGHT = 15.6;

/**
 * A workplace sheet: orange heading row and names, a box for every day, a green total row, and
 * below it the *57 rows the total leaves out (D66).
 */
function styleWorkplace(s: ExcelJS.Worksheet, totalRow: number) {
  const last = s.rowCount;
  s.getColumn(1).width = 16;
  for (let c = 2; c <= DAYS + 1; c++) s.getColumn(c).width = 5.6;
  s.getColumn(TOTAL_COLUMN).width = 8.8;
  for (let r = 1; r <= last; r++) {
    s.getRow(r).height = ROW_HEIGHT;
    for (let c = 1; c <= TOTAL_COLUMN; c++) {
      const cell = s.getCell(r, c);
      cell.border = GRID;
      if (r === 1 || (c === 1 && r !== totalRow)) {
        cell.font = font(12, true);
        cell.fill = ORANGE;
        cell.alignment = CENTER;
      } else if (r === totalRow) {
        cell.font = font(12, c === 1 || c === TOTAL_COLUMN);
        cell.fill = GREEN;
        if (c === 1) cell.alignment = CENTER;
      } else {
        cell.font = font(11, c === TOTAL_COLUMN);
      }
    }
  }
}

/** The totals sheet: yellow headings, bold centred places, a large yellow total. */
function styleTotals(s: ExcelJS.Worksheet) {
  const last = s.rowCount;
  s.getColumn(1).width = 22;
  for (let c = 2; c <= TOTALS_HEADINGS.length; c++) s.getColumn(c).width = 13;
  for (let r = 1; r <= last; r++) {
    s.getRow(r).height = ROW_HEIGHT;
    for (let c = 1; c <= TOTALS_HEADINGS.length; c++) {
      const cell = s.getCell(r, c);
      cell.border = GRID;
      cell.alignment = CENTER;
      if (r === 1 || r === last) cell.fill = YELLOW;
      cell.font = r === last ? font(14, true) : font(12, r === 1 || c === 1);
    }
  }
}

/** Text Excel could take as a formula gets a leading apostrophe (6.2); tab and CR too (OWASP). */
export const safe = (s: string) => (/^[=+\-@\t\r]/.test(s) ? `'${s}` : s);

/**
 * Workplace sheet names (6.2): the forbidden characters removed, at most 31 characters, and
 * ` (2)`, ` (3)` when two names (compared ignoring capitals, as Excel does) would be the same.
 */
export function sheetNames(names: string[]) {
  const taken = new Set([TOTALS, NAMES, REMOVED, 'History'].map((n) => n.toLowerCase()));
  const cut = (s: string, max: number) => {
    let r = s.slice(0, max);
    if (/[\uD800-\uDBFF]$/.test(r)) r = r.slice(0, -1); // never half a character
    return r.trimEnd().replace(/'+$/, ''); // Excel refuses an apostrophe at either end
  };
  return names.map((name) => {
    const base =
      name
        .replace(/[\\/?*[\]:]|\p{Cc}/gu, '') // and control characters
        .trim()
        .replace(/^'+|'+$/g, '')
        .trim() || 'מקום עבודה';
    for (let i = 1; ; i++) {
      const suffix = i === 1 ? '' : ` (${i})`;
      const sheet = cut(base, 31 - suffix.length) + suffix;
      if (!taken.has(sheet.toLowerCase())) {
        taken.add(sheet.toLowerCase());
        return sheet;
      }
    }
  });
}

const quoted = (sheet: string) => `'${sheet.replace(/'/g, "''")}'`;
const SORTING = 'Some tickets are still being sorted. Try again in a minute.';

/**
 * The month's ready tickets by workplace and row, as the month page groups them: what the Excel
 * and the workplace PDFs are made from, so the two always agree (principle 7). Call it inside a
 * RepeatableRead transaction. Refuses rather than leave a ready ticket out (6.1).
 */
export async function readyPlaces(
  tx: Prisma.TransactionClient,
  months: MonthsService,
  monthId: string,
) {
  const month = await tx.month.findUnique({ where: { id: monthId } });
  if (!month) throw new NotFoundException('There is no such month.');
  // A closing month is being deleted; the last download comes before Close (6.1).
  if (month.status !== 'open') {
    throw new ConflictException('This month is being closed or is closed.');
  }
  const ready = await tx.ticket.findMany({
    where: { monthId, status: 'verified' },
    select: { id: true, s3KeyPage: true },
  });
  // The scan's key stays on the server: the month page's rows never carry it.
  const keyOf = new Map(ready.map((t) => [t.id, t.s3KeyPage]));
  const places = (await months.rows(monthId, tx))
    .map((p) => ({
      groupId: p.groupId,
      name: p.name,
      rows: p.rows
        .map((r) => ({
          name: r.name,
          tickets: r.tickets
            .filter((t) => t.status === 'verified')
            .map((t) => ({ ...t, s3KeyPage: keyOf.get(t.id)! })),
        }))
        .filter((r) => r.tickets.length > 0),
    }))
    .filter((p) => p.rows.length > 0);

  // Never leave out hours without a word (6.1): every ready ticket needs its row and its cell.
  const placed = places.flatMap((p) => p.rows.flatMap((r) => r.tickets));
  if (placed.some((t) => t.totalMinutes === null || !t.shiftDate)) {
    throw new InternalServerErrorException(
      'A ready ticket has no date or hours, so the file was not made.',
    );
  }
  // Reading marks a clean ticket ready at once, but it joins a workplace only once its whole
  // upload is read (D45). Until then the file would miss it, so the download waits.
  const ids = new Set(placed.map((t) => t.id));
  const inMonth = (d: Date) =>
    d.getUTCFullYear() === month.year && d.getUTCMonth() + 1 === month.month;
  if (
    ids.size !== ready.length ||
    ready.some((t) => !ids.has(t.id)) ||
    placed.some((t) => !inMonth(t.shiftDate!))
  ) {
    throw new ConflictException(SORTING);
  }
  return { month, places };
}

@Injectable()
export class ExcelExporter {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly months: MonthsService,
  ) {}

  async export(monthId: string) {
    // One consistent picture: a removal or a merge half way through cannot move a ticket twice.
    const { month, places, excluded, morning } = await this.prisma.$transaction(
      async (tx) => ({
        ...(await readyPlaces(tx, this.months, monthId)),
        morning: await this.months.morning(monthId, tx),
        excluded: await tx.ticket.findMany({
          where: { monthId, status: 'excluded' },
          orderBy: [{ shiftDate: 'asc' }, { createdAt: 'asc' }],
          include: { workplaceGroup: true, excludedBy: { select: { email: true } } },
        }),
      }),
      { isolationLevel: 'RepeatableRead' },
    );

    const book = new ExcelJS.Workbook();
    book.calcProperties.fullCalcOnLoad = true;
    const totals = book.addWorksheet(TOTALS, RTL);
    totals.addRow(TOTALS_HEADINGS);
    const names = sheetNames(places.map((p) => p.name));
    // Morning hours by place (D66); a place with no ready ticket still gets its totals row.
    const morningOf = new Map<string, { place: string; minutes: number }>();
    for (const m of morning) {
      const was = morningOf.get(m.groupId)?.minutes ?? 0;
      morningOf.set(m.groupId, { place: m.place, minutes: was + m.minutes });
    }
    const sums = [0, 0, 0]; // רגיל, בוקר, *57

    /** One totals row; a column with nothing is left empty, for the person to fill in. */
    const totalsRow = (
      place: string,
      cells: ({ formula: string; minutes: number } | number | null)[],
    ) => {
      const row = totals.addRow([safe(place)]);
      cells.forEach((cell, i) => {
        if (cell === null) return;
        const minutes = typeof cell === 'number' ? cell : cell.minutes;
        const c = row.getCell(i + 2);
        c.value =
          typeof cell === 'number' ? minutes / 60 : { formula: cell.formula, result: minutes / 60 };
        c.numFmt = hours(minutes);
        sums[i]! += minutes;
      });
    };

    places.forEach((p, i) => {
      const s = book.addWorksheet(names[i]!, RTL);
      const sheet = quoted(names[i]!);
      s.addRow([WORKER, ...Array.from({ length: DAYS }, (_, d) => d + 1), TOTAL]);
      s.addRow([]);
      /** A worker's row of days and its total, as its minutes. */
      const workerRow = (
        label: string,
        tickets: (typeof p.rows)[number]['tickets'],
        byDay?: number[],
      ) => {
        const minutes = new Array<number>(DAYS + 1).fill(0);
        for (const t of tickets) minutes[t.shiftDate!.getUTCDate()]! += t.totalMinutes!;
        const row = s.addRow([safe(label)]);
        let rowTotal = 0;
        for (let d = 1; d <= DAYS; d++) {
          if (minutes[d] === 0) continue;
          row.getCell(d + 1).value = minutes[d]! / 60;
          row.getCell(d + 1).numFmt = hours(minutes[d]!);
          if (byDay) byDay[d]! += minutes[d]!;
          rowTotal += minutes[d]!;
        }
        const n = row.number;
        row.getCell(TOTAL_COLUMN).value = { formula: `SUM(B${n}:AF${n})`, result: rowTotal / 60 };
        row.getCell(TOTAL_COLUMN).numFmt = hours(rowTotal);
        return rowTotal;
      };
      // A worker's ticked tickets (D66) make a row of their own, "<name> *57", below the total.
      const split = (rate57: boolean) =>
        p.rows
          .map((r) => ({
            name: r.name,
            tickets: r.tickets.filter((t) => (t.rate57 === true) === rate57),
          }))
          .filter((r) => r.tickets.length > 0);

      const byDay = new Array<number>(DAYS + 1).fill(0);
      let regular = 0;
      for (const r of split(false)) regular += workerRow(r.name, r.tickets, byDay);
      const total = s.addRow([TOTAL]);
      const end = total.number - 1;
      for (let d = 1; d <= DAYS + 1; d++) {
        const minutes = d <= DAYS ? byDay[d]! : regular;
        const c = s.getColumn(d + 1).letter;
        // With no regular worker the range would be empty (and SUM(B3:B2) would count the header).
        total.getCell(d + 1).value =
          end >= 3 ? { formula: `SUM(${c}3:${c}${end})`, result: minutes / 60 } : 0;
        total.getCell(d + 1).numFmt = hours(minutes);
      }
      let rate57 = 0;
      for (const r of split(true)) rate57 += workerRow(`${r.name} *57`, r.tickets);
      styleWorkplace(s, total.number);

      const am = morningOf.get(p.groupId)?.minutes ?? 0;
      morningOf.delete(p.groupId);
      totalsRow(p.name, [
        { formula: `${sheet}!AG${total.number}`, minutes: regular },
        am > 0 ? am : null,
        rate57 > 0
          ? { formula: `SUM(${sheet}!AG${total.number + 1}:AG${s.rowCount})`, minutes: rate57 }
          : null,
      ]);
    });
    for (const { place, minutes } of morningOf.values()) totalsRow(place, [null, minutes, null]);

    const sum = totals.addRow([TOTAL]);
    const lastPlace = sum.number - 1;
    ['B', 'C', 'D'].forEach((c, i) => {
      const cell = sum.getCell(i + 2);
      cell.value = { formula: `SUM(${c}2:${c}${lastPlace})`, result: sums[i]! / 60 };
      cell.numFmt = hours(sums[i]!);
    });
    styleTotals(totals);

    // Each confirmed name once, with its Hebrew spellings: pasted, it is the names list (5.4).
    // Rows of one name at two places are one person here, compared as rows are (5.2).
    const people = new Map<string, { name: string; spellings: Set<string> }>();
    for (const r of places.flatMap((p) => p.rows)) {
      const key = rowKey(r.name);
      const person = people.get(key) ?? { name: r.name, spellings: new Set<string>() };
      for (const t of r.tickets) {
        if (t.firstName && hasHebrew(t.firstName)) person.spellings.add(t.firstName);
      }
      people.set(key, person);
    }
    const namesSheet = book.addWorksheet(NAMES, RTL);
    for (const p of [...people.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      namesSheet.addRow([safe(p.name), ...[...p.spellings].map(safe)]);
    }

    const removed = book.addWorksheet(REMOVED, RTL);
    removed.addRow(REMOVED_HEADINGS);
    for (const t of excluded) {
      const place = t.workplaceGroup?.displayName ?? t.workplaceRaw;
      const name = t.workerName ?? t.firstName;
      const row = removed.addRow([
        place === null ? null : safe(place),
        name === null ? null : safe(name),
        t.shiftDate,
        t.totalMinutes === null ? null : t.totalMinutes / 60,
        REASONS[t.excludedReason ?? ''] ?? t.excludedReason,
        t.excludedBy ? safe(t.excludedBy.email) : null,
      ]);
      row.getCell(3).numFmt = 'dd/mm/yy';
      row.getCell(4).numFmt = hours(t.totalMinutes ?? 0);
    }

    const file = Buffer.from(await book.xlsx.writeBuffer());
    const mm = String(month.month).padStart(2, '0');
    return { file, filename: `hours-${month.year}-${mm}.xlsx` };
  }
}
