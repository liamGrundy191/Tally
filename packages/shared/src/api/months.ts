// Closing a month (6.1): the request body, shared by the API and the web app.
import { z } from 'zod';

/** The month's name as typed in the Close window ("November 2026"), checked again by the server. */
export const closeMonthSchema = z.object({ name: z.string().max(50) });

/** Morning hours for one place (D66): the place as chosen, the hours as typed ("37.5"). */
export const addMorningSchema = z.object({
  place: z.string().trim().min(1, 'Choose the workplace.').max(200),
  hours: z.string().trim().max(10),
});

/**
 * Hours written as a decimal ("37.5", "4.25") as exact minutes, or null when they are not a whole
 * number of minutes above zero (37.33): durations are whole minutes and are never rounded.
 */
export function hoursToMinutes(text: string): number | null {
  const m = /^(\d{1,3})(?:[.,](\d{1,2}))?$/.exec(text.trim());
  if (!m) return null;
  const hundredths = Number((m[2] ?? '').padEnd(2, '0')); // ".5" is 50 hundredths
  if ((hundredths * 60) % 100 !== 0) return null;
  const minutes = Number(m[1]) * 60 + (hundredths * 60) / 100;
  return minutes > 0 ? minutes : null;
}
