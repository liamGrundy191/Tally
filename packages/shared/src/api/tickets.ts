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
