// Per-ticket checks (plan sections 4 and 4.1). Pure functions: values in, flags out.
import { daysBetween, parseTicketDate } from './date.ts';
import { nameProblem, normaliseName } from './names.ts';
import {
  type ExtractionResult,
  FIELD_KEYS,
  type FieldKey,
  type Flag,
  type RawTicketValues,
  type TicketFields,
} from './schemas.ts';
import { isBlank, stripInvisible } from './text.ts';
import { parseClock, parseDuration, shiftMinutes } from './time.ts';

export interface RuleSettings {
  /** Today in the agency's time zone, YYYY-MM-DD (see `todayIn`). */
  today: string;
  /** MIN_SHIFT_HOURS: a total below this many hours (including 0) is flagged. */
  minShiftHours: number;
  /** MAX_SHIFT_HOURS: a total above this many hours is flagged. */
  maxShiftHours: number;
  /** MAX_DATE_AGE_DAYS: a date more than this many days before today is flagged. */
  maxDateAgeDays: number;
}

export const DEFAULT_MIN_SHIFT_HOURS = 2;
export const DEFAULT_MAX_SHIFT_HOURS = 16;
export const DEFAULT_MAX_DATE_AGE_DAYS = 45;

const digitsOnly = (s: string) => s.replace(/\D/g, '');

/** A parsed value per field, or null when it does not parse. Used to compare the two passes. */
function meaning(field: FieldKey, raw: string): string | number | null {
  switch (field) {
    case 'firstName':
    case 'workplace':
      return normaliseName(raw);
    case 'date': {
      const d = parseTicketDate(raw);
      return d.ok ? d.date : null;
    }
    case 'startTime':
      return parseClock(raw);
    case 'endTime':
      return parseClock(raw, { allow24: true });
    case 'totalWorked':
      return parseDuration(raw);
  }
}

/** Do two readings of a field mean the same thing? "8:30" and "08:30" do. */
function sameReading(field: FieldKey, a: string, b: string): boolean {
  const x = meaning(field, a);
  const y = meaning(field, b);
  if (x !== null || y !== null) return x === y;
  // Neither parses (e.g. "25:70" twice): compare the digits, or the text if there are none.
  const key = (s: string) => digitsOnly(stripInvisible(s)) || stripInvisible(s).replace(/\s+/g, '');
  return key(a) === key(b);
}

/**
 * Step 6, first half: combine the two independent passes. Never picks a winner silently: any
 * difference, any unreadable field, crossing-out or overwriting becomes a flag.
 */
export function reconcilePasses(
  a: ExtractionResult,
  b: ExtractionResult,
): { values: RawTicketValues; flags: Flag[] } {
  const flags: Flag[] = [];
  const values = {} as RawTicketValues;

  for (const field of FIELD_KEYS) {
    const fa = a.fields[field];
    const fb = b.fields[field];
    // A value from a pass that said "not legible" is a guess and is never used.
    const va = fa.legible ? fa.value : null;
    const vb = fb.legible ? fb.value : null;

    if (!fa.legible || !fb.legible) {
      flags.push({ code: 'FIELD_UNREADABLE', field, detail: { passA: va, passB: vb } });
      values[field] = isBlank(va) ? (isBlank(vb) ? null : vb) : va;
      continue;
    }
    if (isBlank(va) && isBlank(vb)) {
      values[field] = null; // both see an empty box; checkTicketValues raises FIELD_EMPTY
      continue;
    }
    if (isBlank(va) || isBlank(vb) || !sameReading(field, va!, vb!)) {
      flags.push({ code: 'PASS_DISAGREEMENT', field, detail: { passA: va, passB: vb } });
      values[field] = isBlank(va) ? vb : va;
      continue;
    }
    values[field] = va;
  }

  if (a.voided || b.voided) flags.push({ code: 'VOIDED_TICKET' });
  const overwritten = new Set([...a.overwrittenFields, ...b.overwrittenFields]);
  for (const field of FIELD_KEYS) {
    if (overwritten.has(field)) flags.push({ code: 'CORRECTION_MARKS', field });
  }
  return { values, flags };
}

/**
 * The rule checks on a ticket's values. Runs after extraction and again whenever a person saves
 * a ticket. A rule that needs a value that is missing or invalid is skipped; the missing or
 * invalid value is flagged instead.
 */
export function checkTicketValues(
  raw: RawTicketValues,
  settings: RuleSettings,
): { fields: TicketFields; flags: Flag[] } {
  const flags: Flag[] = [];
  const clean = (v: string | null) => (isBlank(v) ? null : stripInvisible(v!).trim());
  const v = Object.fromEntries(FIELD_KEYS.map((k) => [k, clean(raw[k])])) as RawTicketValues;
  // A name or workplace with no letters or digits (just "-" or ".") counts as empty.
  for (const k of ['firstName', 'workplace'] as const) {
    if (v[k] !== null && normaliseName(v[k]) === '') v[k] = null;
  }

  for (const field of FIELD_KEYS) {
    if (v[field] === null) flags.push({ code: 'FIELD_EMPTY', field });
  }

  if (v.firstName !== null) {
    const problem = nameProblem(v.firstName);
    if (problem) {
      flags.push({
        code: 'SCRIPT_UNEXPECTED',
        field: 'firstName',
        detail: { value: v.firstName, problem },
      });
    }
  }

  let shiftDate: string | null = null;
  if (v.date !== null) {
    const d = parseTicketDate(v.date);
    if (!d.ok) {
      flags.push({
        code: 'DATE_INVALID',
        field: 'date',
        detail: { value: v.date, reason: d.reason },
      });
    } else {
      shiftDate = d.date;
      const age = daysBetween(d.date, settings.today);
      if (age < 0) {
        flags.push({ code: 'DATE_IN_FUTURE', field: 'date', detail: { date: d.date } });
      } else if (age > settings.maxDateAgeDays) {
        flags.push({
          code: 'DATE_TOO_OLD',
          field: 'date',
          detail: { date: d.date, days: age, maxDays: settings.maxDateAgeDays },
        });
      }
    }
  }

  const parseTime = (field: FieldKey, parse: (s: string) => number | null) => {
    const value = v[field];
    if (value === null) return null;
    const minutes = parse(value);
    if (minutes === null) flags.push({ code: 'TIME_INVALID', field, detail: { value } });
    return minutes;
  };
  const start = parseTime('startTime', (s) => parseClock(s));
  const end = parseTime('endTime', (s) => parseClock(s, { allow24: true }));
  const total = parseTime('totalWorked', parseDuration);

  const computed = start !== null && end !== null ? shiftMinutes(start, end) : null;
  if (computed !== null && total !== null && computed !== total) {
    flags.push({ code: 'TIME_MATH_MISMATCH', field: 'totalWorked', detail: { computed, total } });
  }

  const worked = total ?? computed;
  // Very short totals are more often a misreading (0:30 for 08:30) than a real shift.
  if (
    worked !== null &&
    (worked < settings.minShiftHours * 60 || worked > settings.maxShiftHours * 60)
  ) {
    flags.push({
      code: 'HOURS_OUT_OF_RANGE',
      field: total !== null ? 'totalWorked' : undefined,
      detail: {
        minutes: worked,
        minHours: settings.minShiftHours,
        maxHours: settings.maxShiftHours,
      },
    });
  }

  return {
    fields: {
      firstName: v.firstName,
      workplace: v.workplace,
      shiftDate,
      startMinutes: start,
      endMinutes: end,
      totalMinutes: total,
    },
    flags,
  };
}

/**
 * Step 6 for a scanned ticket: reconcile both passes, then run the rule checks. A field already
 * flagged as unreadable or disputed is not flagged again as empty.
 */
export function checkExtraction(a: ExtractionResult, b: ExtractionResult, settings: RuleSettings) {
  const reconciled = reconcilePasses(a, b);
  const checked = checkTicketValues(reconciled.values, settings);
  const disputed = new Set(
    reconciled.flags
      .filter((f) => f.code === 'FIELD_UNREADABLE' || f.code === 'PASS_DISAGREEMENT')
      .map((f) => f.field),
  );
  const flags = [
    ...reconciled.flags,
    ...checked.flags.filter((f) => !(f.code === 'FIELD_EMPTY' && disputed.has(f.field))),
  ];
  return { values: reconciled.values, fields: checked.fields, flags };
}
