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
import { MonthsService } from './months.service.ts';

// The columns, in one place (6.2).
const TOTALS = 'סה"כ שעות';
const NAMES = 'שמות';
const REMOVED = 'לא נכללו';
const TOTAL = 'סה"כ';
const TOTALS_HEADINGS = ['מקום עבודה', 'שעות'];
const WORKER = 'עובד';
const DAYS = 31; // columns B to AF; AG is the row's total
const TOTAL_COLUMN = DAYS + 2;
const REMOVED_HEADINGS = ['מקום עבודה', 'עובד', 'תאריך', 'שעות', 'סיבה', 'הוסר על ידי'];
const REASONS: Record<string, string> = {
  removed: 'הוסר',
  replaced: 'הוחלף בכרטיס חדש',
  duplicate: 'נסרק פעמיים',
};
const HOURS = '0.00';
const RTL = { views: [{ rightToLeft: true }] };

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
  const places = (await months.rows(monthId, tx))
    .map((p) => ({
      groupId: p.groupId,
      name: p.name,
      rows: p.rows
        .map((r) => ({
          name: r.name,
          tickets: r.tickets.filter((t) => t.status === 'verified'),
        }))
        .filter((r) => r.tickets.length > 0),
    }))
    .filter((p) => p.rows.length > 0);
  const ready = await tx.ticket.findMany({
    where: { monthId, status: 'verified' },
    select: { id: true },
  });

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
    const { month, places, excluded } = await this.prisma.$transaction(
      async (tx) => ({
        ...(await readyPlaces(tx, this.months, monthId)),
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
    let all = 0;
    places.forEach((p, i) => {
      const s = book.addWorksheet(names[i]!, RTL);
      s.addRow([WORKER, ...Array.from({ length: DAYS }, (_, d) => d + 1), TOTAL]);
      s.addRow([]);
      const byDay = new Array<number>(DAYS + 1).fill(0);
      for (const r of p.rows) {
        const minutes = new Array<number>(DAYS + 1).fill(0);
        for (const t of r.tickets) minutes[t.shiftDate!.getUTCDate()]! += t.totalMinutes!;
        const row = s.addRow([safe(r.name)]);
        let rowTotal = 0;
        for (let d = 1; d <= DAYS; d++) {
          if (minutes[d] === 0) continue;
          row.getCell(d + 1).value = minutes[d]! / 60;
          row.getCell(d + 1).numFmt = HOURS;
          byDay[d]! += minutes[d]!;
          rowTotal += minutes[d]!;
        }
        const n = row.number;
        row.getCell(TOTAL_COLUMN).value = { formula: `SUM(B${n}:AF${n})`, result: rowTotal / 60 };
        row.getCell(TOTAL_COLUMN).numFmt = HOURS;
      }
      const last = s.addRow([TOTAL]);
      const end = last.number - 1;
      let placeTotal = 0;
      for (let d = 1; d <= DAYS + 1; d++) {
        const minutes = d <= DAYS ? byDay[d]! : placeTotal;
        const c = s.getColumn(d + 1).letter;
        last.getCell(d + 1).value = { formula: `SUM(${c}3:${c}${end})`, result: minutes / 60 };
        last.getCell(d + 1).numFmt = HOURS;
        placeTotal += d <= DAYS ? minutes : 0;
      }
      all += placeTotal;
      const t = totals.addRow([safe(p.name)]);
      t.getCell(2).value = {
        formula: `${quoted(names[i]!)}!AG${last.number}`,
        result: placeTotal / 60,
      };
      t.getCell(2).numFmt = HOURS;
    });
    const sum = totals.addRow([TOTAL]);
    sum.getCell(2).value = { formula: `SUM(B2:B${sum.number - 1})`, result: all / 60 };
    sum.getCell(2).numFmt = HOURS;

    // Each confirmed name once, with its Hebrew spellings: pasted, it is the names list (5.4).
    // Rows of one name at two places are one person here, compared as rows are (5.2).
    const people = new Map<string, { name: string; spellings: Set<string> }>();
    for (const r of places.flatMap((p) => p.rows)) {
      const key = r.name.toLowerCase().replace(/\s+/g, ' ').trim();
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
      row.getCell(4).numFmt = HOURS;
    }

    const file = Buffer.from(await book.xlsx.writeBuffer());
    const mm = String(month.month).padStart(2, '0');
    return { file, filename: `hours-${month.year}-${mm}.xlsx` };
  }
}
