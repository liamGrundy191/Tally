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
 * Hours as typed ("37.5", "4.25", "37:30", "37.00") as exact minutes, or null. A decimal must end
 * in .0, .00, .5, .25, .50 or .75: "7.30" or "7.3" is often written for 7:30 but would read as 7 h 18 min, so it
 * is asked, never guessed. Durations are whole minutes and are never rounded.
 */
export function hoursToMinutes(text: string): number | null {
  const t = text.trim();
  const clock = /^(\d{1,3}):([0-5]\d)$/.exec(t);
  const minutes = clock
    ? Number(clock[1]) * 60 + Number(clock[2])
    : /^\d{1,3}(?:[.,](?:0|00|5|50|25|75))?$/.test(t)
      ? Math.round(Number(t.replace(',', '.')) * 60) // exact: quarters of an hour only
      : null;
  return minutes !== null && minutes > 0 ? minutes : null;
}
