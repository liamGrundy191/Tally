// Times are integer minutes. No floating point, no rounding.
import { stripInvisible } from './text.ts';

export const MINUTES_PER_DAY = 1440;

/**
 * Splits "HH:MM", "H:MM", "HHMM" or "HMM" into hours and minutes. Minutes must be two digits,
 * so "8.5" (decimal hours) and "8" are rejected rather than guessed.
 */
function splitTime(raw: string): { h: number; m: number } | null {
  const s = stripInvisible(raw).replace(/\s+/g, '');
  const match = /^(\d{1,2})[:.]?(\d{2})$/.exec(s);
  if (!match) return null;
  return { h: Number(match[1]), m: Number(match[2]) };
}

/**
 * Minutes after midnight (0–1439). With `allow24` (end times), "24:00" means midnight and
 * returns 0; the shift-length rule then treats it as the end of the start day.
 */
export function parseClock(raw: string, opts: { allow24?: boolean } = {}): number | null {
  const t = splitTime(raw);
  if (!t || t.m > 59) return null;
  if (t.h === 24 && t.m === 0 && opts.allow24) return 0;
  if (t.h > 23) return null;
  return t.h * 60 + t.m;
}

/** Total worked as written ("HH:MM"), in minutes. Hours above 23 are allowed here; the range rule flags them. */
export function parseDuration(raw: string): number | null {
  const t = splitTime(raw);
  if (!t || t.m > 59) return null;
  return t.h * 60 + t.m;
}

/** end − start; if end is earlier than start the shift crossed midnight, so add 24 hours. */
export function shiftMinutes(start: number, end: number): number {
  return end >= start ? end - start : end + MINUTES_PER_DAY - start;
}

export const formatMinutes = (minutes: number) =>
  `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;
