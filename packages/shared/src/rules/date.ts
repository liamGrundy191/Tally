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

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
type MonthKey = { year: number; month: number };

/** A month's name as the app shows it, and as it is typed to close it: "November 2026". */
export const monthName = (m: MonthKey) => `${MONTHS[m.month - 1]} ${m.year}`;

const typed = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();
/** Closing asks for the month's name (6.1); capitals and extra spaces do not matter. */
export const isMonthName = (text: string, m: MonthKey) => typed(text) === typed(monthName(m));

/** The month's last day plus `days`, as YYYY-MM-DD. */
const afterLastDay = (m: MonthKey, days: number) =>
  new Date(Date.UTC(m.year, m.month, days)).toISOString().slice(0, 10);
/** A month is deleted automatically 60 days after its last day (6.1), in Israel's calendar. */
export const autoDeleteOn = (m: MonthKey) => afterLastDay(m, 60);
/** From day 50 a banner warns that the month will be deleted (6.1). */
export const warnFrom = (m: MonthKey) => afterLastDay(m, 50);
