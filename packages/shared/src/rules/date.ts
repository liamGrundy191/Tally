// Dates are plain calendar dates as ISO strings (YYYY-MM-DD). No time zones, no Date objects
// in the rules, so a shift date can never move by a day.
import { stripInvisible } from './text.ts';

export type DateReading =
  { ok: true; date: string } | { ok: false; reason: 'unparseable' | 'not_a_date' };

/** Ticket dates are DD/MM/YY (day first). Two-digit years are 20YY. */
export function parseTicketDate(raw: string): DateReading {
  const s = stripInvisible(raw).replace(/\s+/g, '');
  const match =
    /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(s) ??
    /^(\d{2})(\d{2})(\d{2}|\d{4})$/.exec(s);
  if (!match) return { ok: false, reason: 'unparseable' };
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = match[3]!.length === 2 ? 2000 + Number(match[3]) : Number(match[3]);
  if (
    year < 1900 ||
    year > 2099 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month)
  ) {
    return { ok: false, reason: 'not_a_date' };
  }
  return { ok: true, date: `${year}-${pad(month)}-${pad(day)}` };
}

const pad = (n: number) => String(n).padStart(2, '0');

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

const dayNumber = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d) / 86_400_000;
};

/** Whole days from `from` to `to` (negative if `to` is earlier). */
export const daysBetween = (from: string, to: string) => dayNumber(to) - dayNumber(from);

/** Today's calendar date in a time zone, as YYYY-MM-DD. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export const AGENCY_TIME_ZONE = 'Asia/Jerusalem';
