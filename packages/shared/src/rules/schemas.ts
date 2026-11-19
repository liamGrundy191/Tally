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
 * What one extraction pass must return. Anything that does not validate is a failed attempt.
 * With a list of known workplaces, `workplaceMatch` must be one of its entries exactly (or null);
 * without one it must be null.
 */
export function extractionResultSchema(knownWorkplaces: readonly string[] = []) {
  const entries = [...new Set(knownWorkplaces)];
  return z.object({
    fields: z.object(
      Object.fromEntries(FIELD_KEYS.map((k) => [k, ExtractedFieldSchema])) as Record<
        FieldKey,
        typeof ExtractedFieldSchema
      >,
    ),
    voided: z.boolean(),
    overwrittenFields: z.array(FieldKeySchema),
    workplaceMatch:
      entries.length > 0 ? z.enum(entries as [string, ...string[]]).nullable() : z.null(),
  });
}
export const ExtractionResultSchema = extractionResultSchema();
export type ExtractionResult = Omit<z.infer<typeof ExtractionResultSchema>, 'workplaceMatch'> & {
  workplaceMatch: string | null;
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
  'WORKPLACE_AMBIGUOUS',
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
