// truth.csv: what is really written on each ticket, typed by a person, for grading (T0.6).
import {
  FIELD_KEYS,
  type FieldKey,
  type RawTicketValues,
  parseClock,
  parseDuration,
  parseTicketDate,
} from '@tally/shared';
import { readFileSync } from 'node:fs';
import { decodeUtf8, parseCsv, toCsv } from './csv.ts';

export const TRUTH_COLUMNS = ['file', 'page', ...FIELD_KEYS, 'voided'] as const;

export interface TruthRow {
  file: string;
  page: number;
  /** As written on the ticket; null for an empty box. */
  values: RawTicketValues;
  voided: boolean;
}

export const truthKey = (file: string, page: number) => `${file.toLowerCase()}#${page}`;

const YES = ['yes', 'y', 'true', '1', 'x', 'כן'];
const NO = ['', 'no', 'n', 'false', '0', 'לא'];

/** Excel saves a typed 08:30 as 08:30:00 once it decides the cell is a time. */
const dropSeconds = (s: string) => s.replace(/^(\d{1,2}:\d{2}):00$/, '$1');

/** Does a typed truth value parse? Unparseable ones are allowed (it may be what was written). */
function parses(field: FieldKey, raw: string): boolean {
  switch (field) {
    case 'date':
      return parseTicketDate(raw).ok;
    case 'startTime':
      return parseClock(raw) !== null;
    case 'endTime':
      return parseClock(raw, { allow24: true }) !== null;
    case 'totalWorked':
      return parseDuration(raw) !== null;
    default:
      return true;
  }
}

/**
 * Reads truth.csv. Problems that would make the grading wrong (missing columns, a bad page
 * number, a repeated ticket) are errors; values that do not parse are warnings, since a ticket
 * may really say "25:00".
 */
export function readTruth(path: string): {
  rows: TruthRow[];
  errors: string[];
  warnings: string[];
} {
  const rows = parseCsv(decodeUtf8(readFileSync(path), path));
  const errors: string[] = [];
  const warnings: string[] = [];
  const header = (rows[0] ?? []).map((h) => h.trim());
  const col = Object.fromEntries(TRUTH_COLUMNS.map((c) => [c, header.indexOf(c)])) as Record<
    (typeof TRUTH_COLUMNS)[number],
    number
  >;
  const missing = TRUTH_COLUMNS.filter((c) => col[c] < 0);
  if (missing.length > 0) {
    return { rows: [], errors: [`${path}: missing columns: ${missing.join(', ')}`], warnings };
  }

  const out: TruthRow[] = [];
  const seen = new Set<string>();
  for (const [i, cells] of rows.slice(1).entries()) {
    const line = i + 2;
    const get = (c: (typeof TRUTH_COLUMNS)[number]) => (cells[col[c]] ?? '').trim();
    const file = get('file');
    const page = Number(get('page'));
    if (file === '' || !Number.isInteger(page) || page < 1) {
      errors.push(`line ${line}: needs a file name and a page number (1, 2, 3 …)`);
      continue;
    }
    const key = truthKey(file, page);
    if (seen.has(key)) errors.push(`line ${line}: ${file} page ${page} appears twice`);
    seen.add(key);
    const voidedRaw = get('voided').toLowerCase();
    if (!YES.includes(voidedRaw) && !NO.includes(voidedRaw)) {
      errors.push(
        `line ${line}: voided must be yes or no (or empty for no), not "${get('voided')}"`,
      );
    }
    const values = {} as RawTicketValues;
    for (const field of FIELD_KEYS) {
      const raw =
        field === 'firstName' || field === 'workplace' ? get(field) : dropSeconds(get(field));
      values[field] = raw === '' ? null : raw;
      if (raw !== '' && !parses(field, raw)) {
        warnings.push(
          `line ${line}: ${field} "${raw}" is not a valid ${field === 'date' ? 'date' : 'time'} (fine if that is what was written)`,
        );
      }
    }
    out.push({ file, page, values, voided: YES.includes(voidedRaw) });
  }
  return { rows: out, errors, warnings };
}

/** An empty truth file with one row per ticket, ready to fill in. */
export function truthTemplate(tickets: readonly { file: string; page: number }[]): string {
  return toCsv([
    [...TRUTH_COLUMNS],
    ...tickets.map((t) => [t.file, t.page, ...FIELD_KEYS.map(() => ''), '']),
  ]);
}
