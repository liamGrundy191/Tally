// Reviewing a ticket (plan sections 4.1 and 8): the request bodies, shared by the API and the web
// app so both check them the same way. Messages are shown to the user.
import { z } from 'zod';
import { hasHebrew, nameProblem } from '../rules/names.ts';
import { FIELD_KEYS, FLAG_CODES, type FieldKey } from '../rules/schemas.ts';

/**
 * Flags a person may confirm as written ("I checked the paper"). The others are settled only by
 * a new value: an empty box, a time or date that does not exist, or a date in the future.
 */
export const ACCEPTABLE_FLAGS = [
  'TIME_MATH_MISMATCH',
  'HOURS_OUT_OF_RANGE',
  'DATE_TOO_OLD',
  'SCRIPT_UNEXPECTED',
  'VOIDED_TICKET',
] as const;

const version = z.int().min(0);
const value = z.string().max(200).nullable();

/** Values as written on the paper: the date as DD/MM/YY, times as 08:30 (section 4.1). */
export const saveTicketSchema = z.object({
  version,
  values: z.object(
    Object.fromEntries(FIELD_KEYS.map((k) => [k, value])) as Record<FieldKey, typeof value>,
  ),
  /** The name in English letters for the worker's Excel row (5.2); null leaves it unconfirmed. */
  workerName: z
    .string()
    .trim()
    .min(1, 'Type the name in English letters.')
    .max(100, 'The name can have at most 100 characters.')
    .refine((n) => !hasHebrew(n), 'Type the name in English letters.')
    .refine((n) => nameProblem(n) === null, 'The name can only have letters.')
    .nullable(),
  accept: z
    .array(z.enum(ACCEPTABLE_FLAGS, { error: 'This cannot be confirmed as written: correct it.' }))
    .max(10)
    .default([]),
  /** The person ticked "57 rate" (D66). */
  rate57: z.boolean().default(false),
});

/**
 * A shift's hours on another ticket (D68), as exact minutes: "8", "7:30", or a decimal ending in
 * .25, .5 or .75 ("7.5", "7,75"). Any other decimal is refused, never guessed: "7.30" is often
 * written for 7:30 but reads as 7 h 18 min.
 */
export function shiftHours(text: string): number | null {
  const t = text.trim();
  const clock = /^(\d{1,2}):(\d{2})$/.exec(t);
  const minutes = clock
    ? Number(clock[2]) < 60
      ? Number(clock[1]) * 60 + Number(clock[2])
      : null
    : /^\d{1,2}(?:[.,](?:5|50|25|75))?$/.test(t)
      ? Math.round(Number(t.replace(',', '.')) * 60) // exact: quarters of an hour only
      : null;
  return minutes !== null && minutes > 0 ? minutes : null;
}

export const SHIFT_HOURS_PROBLEM = 'Type the hours like 8, 7:30 or 7.5.';
const MAX_SHIFTS = 62;

/** Another ticket (D68): who and where once, then each shift on it, typed from the scan. */
export const saveFreeFormSchema = z.object({
  workerName: saveTicketSchema.shape.workerName.unwrap(),
  workplace: z
    .string()
    .trim()
    .min(1, 'Type the workplace.')
    .max(200, 'The workplace can have at most 200 characters.'),
  rate57: z.boolean().default(false),
  shifts: z
    .array(
      z
        .object({
          /** A shift saved before, with the version the person saw; none for a new line. */
          id: z.uuid().optional(),
          version: version.optional(),
          date: z.string().trim().min(1, 'Type the date.').max(20),
          hours: z
            .string()
            .trim()
            .max(10)
            .refine((h) => shiftHours(h) !== null, SHIFT_HOURS_PROBLEM),
          accept: z
            .array(z.enum(ACCEPTABLE_FLAGS, { error: 'This cannot be confirmed: correct it.' }))
            .max(10)
            .default([]),
        })
        .refine((s) => (s.id === undefined) === (s.version === undefined), 'Reload the ticket.'),
    )
    .min(1, 'Add at least one shift.')
    .max(MAX_SHIFTS, `A ticket can have at most ${MAX_SHIFTS} shifts.`),
  /** Shifts saved before and removed from the form, with the version the person saw. */
  remove: z
    .array(z.object({ id: z.uuid(), version }))
    .max(MAX_SHIFTS)
    .default([]),
});

/** Exclude and reprocess name the version the person saw, like a save. */
export const ticketVersionSchema = z.object({ version });

export const TICKET_STATUSES = [
  'processing',
  'verified',
  'needs_review',
  'needs_manual_entry',
  'excluded',
] as const;

/** `month=none` lists the tickets waiting outside any month for a date (6c). */
export const listTicketsSchema = z.object({
  month: z.union([z.uuid(), z.literal('none')]).optional(),
  status: z.enum(TICKET_STATUSES).optional(),
  /** Tickets with this flag still open. */
  flag: z.enum(FLAG_CODES).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
});
