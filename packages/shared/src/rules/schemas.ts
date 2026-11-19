import { z } from 'zod';

export const FIELD_KEYS = [
  'firstName',
  'workplace',
  'date',
  'startTime',
  'endTime',
  'totalWorked',
] as const;
export const FieldKeySchema = z.enum(FIELD_KEYS);
export type FieldKey = z.infer<typeof FieldKeySchema>;

/**
 * One field as the extractor read it. `legible: false` is the honest answer when unsure; the
 * best guess then goes in `suggestion`, which is shown to the reviewer and never used as a value.
 */
export const ExtractedFieldSchema = z.object({
  value: z.string().nullable(),
  legible: z.boolean(),
  suggestion: z.string().nullable(),
});

/**
 * The lists the reader may match handwriting against: the agency's workplaces (D25) and the
 * first names the user uploaded plus clear names from the same batch (D28).
 */
export interface KnownLists {
  workplaces?: readonly string[];
  names?: readonly string[];
}

/** An exact entry of the list or null; always null when there is no list. */
function listMatch(list: readonly string[] = []) {
  const entries = [...new Set(list)];
  return entries.length > 0 ? z.enum(entries as [string, ...string[]]).nullable() : z.null();
}

/**
 * What one extraction pass must return. Anything that does not validate is a failed attempt.
 * `workplaceMatch` and `nameMatch` must be exact list entries (or null).
 */
export function extractionResultSchema(lists: KnownLists = {}) {
  return z.object({
    fields: z.object(
      Object.fromEntries(FIELD_KEYS.map((k) => [k, ExtractedFieldSchema])) as Record<
        FieldKey,
        typeof ExtractedFieldSchema
      >,
    ),
    voided: z.boolean(),
    overwrittenFields: z.array(FieldKeySchema),
    workplaceMatch: listMatch(lists.workplaces),
    nameMatch: listMatch(lists.names),
  });
}
export const ExtractionResultSchema = extractionResultSchema();
export type ExtractionResult = Omit<
  z.infer<typeof ExtractionResultSchema>,
  'workplaceMatch' | 'nameMatch'
> & {
  workplaceMatch: string | null;
  nameMatch: string | null;
};

export const FLAG_CODES = [
  'PASS_DISAGREEMENT',
  'FIELD_UNREADABLE',
  'FIELD_EMPTY',
  'CORRECTION_MARKS',
  'VOIDED_TICKET',
  'TIME_INVALID',
  'TIME_MATH_MISMATCH',
  'HOURS_OUT_OF_RANGE',
  'DATE_IN_FUTURE',
  'DATE_TOO_OLD',
  'DATE_INVALID',
  'SCRIPT_UNEXPECTED',
  'MARKERS_NOT_FOUND',
  'IMAGE_BLURRY',
  'IMAGE_DARK',
  'WORKPLACE_SIMILAR',
  'WORKPLACE_NOT_ON_LIST',
  'MATCH_AMBIGUOUS',
  'POSSIBLE_DUPLICATE',
  'EXTRACTION_ERROR',
] as const;
export const FlagCodeSchema = z.enum(FLAG_CODES);
export type FlagCode = z.infer<typeof FlagCodeSchema>;

/** A reason a ticket needs a person. `detail` holds the values the message shows. */
export interface Flag {
  code: FlagCode;
  field?: FieldKey;
  detail?: Record<string, unknown>;
}

/** Raw field values as written on the ticket (or typed by a person), before parsing. */
export type RawTicketValues = Record<FieldKey, string | null>;

/** A ticket's checked values. Dates are ISO `YYYY-MM-DD`; times are integer minutes. */
export const TicketFieldsSchema = z.object({
  firstName: z.string().nullable(),
  workplace: z.string().nullable(),
  shiftDate: z.iso.date().nullable(),
  startMinutes: z.number().int().min(0).max(1439).nullable(),
  endMinutes: z.number().int().min(0).max(1439).nullable(),
  totalMinutes: z.number().int().min(0).nullable(),
});
export type TicketFields = z.infer<typeof TicketFieldsSchema>;
