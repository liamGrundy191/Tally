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
import { levenshtein } from './workplaces.ts';

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
export function sameReading(field: FieldKey, a: string, b: string): boolean {
  const x = meaning(field, a);
  const y = meaning(field, b);
  if (x !== null || y !== null) return x === y;
  // Neither parses (e.g. "25:70" twice): compare the digits, or the text if there are none.
  const key = (s: string) => digitsOnly(stripInvisible(s)) || stripInvisible(s).replace(/\s+/g, '');
  return key(a) === key(b);
}

export interface ReconcileOptions {
  /** The agency's list of workplaces, when the passes were given it. */
  knownWorkplaces?: readonly string[];
  /** The known first names, when the passes were given them (D28). */
  knownNames?: readonly string[];
  /** The tie-break read (pass C, D27). It only improves suggestions; it never settles a field. */
  thirdRead?: ExtractionResult;
}

/** Best guesses for flagged fields, for the reviewer to confirm. Never used as values. */
export type Suggestions = Partial<Record<FieldKey, string>>;

/** What a pass offers for a field: its reading if legible, otherwise its suggestion. */
const offered = (f: { value: string | null; legible: boolean; suggestion: string | null }) =>
  f.legible ? f.value : f.suggestion;

/**
 * Does the handwriting plausibly spell this list entry? A few letters may differ, and the words
 * may come in another order: a number inside Hebrew text ("12 שושנים") is often read the other
 * way round ("שושנים 12").
 */
export function resemblesEntry(written: string, entry: string): boolean {
  const w = normaliseName(written);
  const e = normaliseName(entry);
  if (w === '' || e === '') return false;
  const limit = Math.max(2, Math.round(0.3 * [...e].length));
  const words = (s: string) => s.split(' ').sort().join(' ');
  return levenshtein(w, e) <= limit || levenshtein(words(w), words(e)) <= limit;
}

/**
 * Could the handwriting be this other entry instead? Stricter than `resemblesEntry`: one letter
 * different for entries up to 7 letters, two for longer ones. With two letters allowed, short
 * names that are clearly different (הבן and הדס) counted as look-alikes. Workplaces keep the
 * looser `resemblesEntry` as their look-alike test (Liam: the list is short, and pairs two letters apart exist on it).
 */
export function looksAlike(written: string, entry: string): boolean {
  const w = normaliseName(written);
  const e = normaliseName(entry);
  if (w === '' || e === '') return false;
  return levenshtein(w, e) <= Math.max(1, Math.floor([...e].length / 4));
}

const isReadingFlag = (field: FieldKey) => (f: Flag) =>
  f.field === field && (f.code === 'FIELD_UNREADABLE' || f.code === 'PASS_DISAGREEMENT');

/**
 * Step 6, first half: combine the two independent passes. Never picks a winner silently: any
 * difference, any unreadable field, crossing-out or overwriting becomes a flag. With a list,
 * both passes naming the same entry, with handwriting that resembles it and no other entry,
 * settles the workplace (D25) or the name (D28); otherwise the field is flagged.
 */
export function reconcilePasses(
  a: ExtractionResult,
  b: ExtractionResult,
  opts: ReconcileOptions = {},
): {
  values: RawTicketValues;
  suggestions: Suggestions;
  flags: Flag[];
  workplaceFromList: boolean;
  nameFromList: boolean;
} {
  let flags: Flag[] = [];
  const values = {} as RawTicketValues;
  const suggestions: Suggestions = {};
  const c = opts.thirdRead;

  for (const field of FIELD_KEYS) {
    const fa = a.fields[field];
    const fb = b.fields[field];
    // A value from a pass that said "not legible" is a guess and is never used as a value.
    const va = fa.legible ? fa.value : null;
    const vb = fb.legible ? fb.value : null;
    // Suggest a reading two reads agree on; with a single reading, that one; otherwise none.
    const disputed = () => {
      const offers = [fa, fb, ...(c ? [c.fields[field]] : [])]
        .map(offered)
        .filter((o): o is string => !isBlank(o));
      const agreed = offers.find((x, i) =>
        offers.some((y, j) => j > i && sameReading(field, x, y)),
      );
      if (agreed !== undefined) suggestions[field] = agreed;
      else if (offers.length === 1) suggestions[field] = offers[0]!;
    };

    if (!fa.legible || !fb.legible) {
      flags.push({
        code: 'FIELD_UNREADABLE',
        field,
        detail: {
          passA: va,
          passB: vb,
          suggestionA: fa.suggestion,
          suggestionB: fb.suggestion,
          ...(c ? { passC: offered(c.fields[field]) } : {}),
        },
      });
      values[field] = isBlank(va) ? (isBlank(vb) ? null : vb) : va;
      disputed();
      continue;
    }
    if (isBlank(va) && isBlank(vb)) {
      values[field] = null; // both see an empty box; checkTicketValues raises FIELD_EMPTY
      continue;
    }
    if (isBlank(va) || isBlank(vb) || !sameReading(field, va!, vb!)) {
      flags.push({
        code: 'PASS_DISAGREEMENT',
        field,
        detail: { passA: va, passB: vb, ...(c ? { passC: offered(c.fields[field]) } : {}) },
      });
      values[field] = isBlank(va) ? vb : va;
      if (c) disputed();
      continue;
    }
    values[field] = va;
  }

  /** Settles a field from a list when both passes name the same fitting entry. */
  const settleFromList = (
    field: 'workplace' | 'firstName',
    ma: string | null,
    mb: string | null,
    list: readonly string[],
  ): boolean => {
    if (list.length === 0) return false;
    const written = [offered(a.fields[field]), offered(b.fields[field])].filter(
      (t): t is string => !isBlank(t),
    );
    const agreed =
      ma !== null && ma === mb && written.length > 0 && written.every((t) => resemblesEntry(t, ma));
    // Handwriting that also fits another entry (בית נוי / בית נוף) could be either: a person decides.
    const alsoFits = agreed
      ? list.filter(
          (e) =>
            e !== ma &&
            written.some((t) => (field === 'workplace' ? resemblesEntry : looksAlike)(t, e)),
        )
      : [];
    if (agreed && alsoFits.length > 0) {
      flags.push({ code: 'MATCH_AMBIGUOUS', field, detail: { match: ma, alsoFits } });
      suggestions[field] = ma!;
      return false;
    }
    if (agreed) {
      flags = flags.filter((f) => !isReadingFlag(field)(f));
      values[field] = ma;
      delete suggestions[field];
      return true;
    }
    if (ma === null && mb === null) {
      // A new name is normal (workers change); a new workplace is worth asking about.
      if (field === 'workplace') {
        flags.push({ code: 'WORKPLACE_NOT_ON_LIST', field, detail: { written } });
      }
      return false;
    }
    if (!flags.some(isReadingFlag(field))) {
      flags.push({ code: 'PASS_DISAGREEMENT', field, detail: { matchA: ma, matchB: mb } });
    }
    if (ma === mb || ma === null || mb === null) suggestions[field] = (ma ?? mb)!;
    else delete suggestions[field];
    return false;
  };
  const workplaceFromList = settleFromList(
    'workplace',
    a.workplaceMatch,
    b.workplaceMatch,
    opts.knownWorkplaces ?? [],
  );
  const nameFromList = settleFromList('firstName', a.nameMatch, b.nameMatch, opts.knownNames ?? []);

  if (a.voided || b.voided) flags.push({ code: 'VOIDED_TICKET' });
  const overwritten = new Set([...a.overwrittenFields, ...b.overwrittenFields]);
  for (const field of FIELD_KEYS) {
    if (overwritten.has(field)) flags.push({ code: 'CORRECTION_MARKS', field });
  }
  return { values, suggestions, flags, workplaceFromList, nameFromList };
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
/**
 * RISKY DECISION (D30): the one place a guess can become a value. An unclear total is accepted
 * when start and end were both read with certainty, nothing else is wrong with the total, and
 * both passes offer the same total that end minus start gives. Returns that total, or null.
 */
function totalConfirmedByMath(
  a: ExtractionResult,
  b: ExtractionResult,
  r: ReturnType<typeof reconcilePasses>,
): string | null {
  const on = (field: FieldKey) => r.flags.filter((f) => f.field === field);
  const total = on('totalWorked');
  if (total.length !== 1 || total[0]!.code !== 'FIELD_UNREADABLE') return null;
  if (on('startTime').length > 0 || on('endTime').length > 0) return null;
  if (r.flags.some((f) => f.code === 'VOIDED_TICKET')) return null;
  const start = parseClock(r.values.startTime ?? '');
  const end = parseClock(r.values.endTime ?? '', { allow24: true });
  if (start === null || end === null) return null;
  const offers = [offered(a.fields.totalWorked), offered(b.fields.totalWorked)];
  const expected = shiftMinutes(start, end);
  return offers.every((o) => !isBlank(o) && parseDuration(o!) === expected) ? offers[0]! : null;
}

export function checkExtraction(
  a: ExtractionResult,
  b: ExtractionResult,
  settings: RuleSettings,
  opts: ReconcileOptions = {},
) {
  const reconciled = reconcilePasses(a, b, opts);
  const byMath = totalConfirmedByMath(a, b, reconciled);
  if (byMath !== null) {
    reconciled.values.totalWorked = byMath;
    reconciled.flags = reconciled.flags.filter((f) => f.field !== 'totalWorked');
    delete reconciled.suggestions.totalWorked;
  }
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
  return {
    values: reconciled.values,
    fields: checked.fields,
    suggestions: reconciled.suggestions,
    workplaceFromList: reconciled.workplaceFromList,
    nameFromList: reconciled.nameFromList,
    /** The total was a guess accepted because the times confirm it (D30); shown to reviewers. */
    totalFromMath: byMath !== null,
    flags,
  };
}

/** A ticket after `checkExtraction`. */
export type CheckedTicket = ReturnType<typeof checkExtraction>;

/** Fields the two passes could not settle; these get the tie-break read (pass C, D27). */
export const unclearFields = (t: CheckedTicket): FieldKey[] => [
  ...new Set(
    t.flags
      .filter((f) => f.code === 'FIELD_UNREADABLE' || f.code === 'PASS_DISAGREEMENT')
      .map((f) => f.field!),
  ),
];

/**
 * A name another ticket in the same batch can be matched against (D28): no rule raised any
 * doubt about it, so both passes agreed on it or a list settled it.
 */
export function trustedName(t: CheckedTicket): string | null {
  if (t.flags.some((f) => f.field === 'firstName' || f.code === 'VOIDED_TICKET')) return null;
  return isBlank(t.fields.firstName) ? null : t.fields.firstName;
}

/**
 * Clear names from the batch that this ticket's unclear name might be, and that were not on the
 * list it was read with. When there are any, the ticket is read again with them on the list.
 * A name with correction marks stays with a person, so it gets no second look.
 */
export function batchNameCandidates(
  a: ExtractionResult,
  b: ExtractionResult,
  t: CheckedTicket,
  batchNames: readonly string[],
  knownNames: readonly string[] = [],
): string[] {
  if (!t.flags.some(isReadingFlag('firstName'))) return [];
  if (t.flags.some((f) => f.field === 'firstName' && f.code === 'CORRECTION_MARKS')) return [];
  const written = [offered(a.fields.firstName), offered(b.fields.firstName)].filter(
    (n): n is string => !isBlank(n),
  );
  return [...new Set(batchNames)].filter(
    (n) => !knownNames.includes(n) && written.some((w) => resemblesEntry(w, n)),
  );
}

/**
 * Takes the name from the second look only when both of its passes settled it from the list;
 * every other field and flag stays as the first reading found it.
 */
export function withRetriedName(first: CheckedTicket, retry: CheckedTicket): CheckedTicket {
  if (!retry.nameFromList) return first;
  const suggestions = { ...first.suggestions };
  delete suggestions.firstName;
  return {
    ...first,
    values: { ...first.values, firstName: retry.values.firstName },
    fields: { ...first.fields, firstName: retry.fields.firstName },
    suggestions,
    nameFromList: true,
    flags: [
      ...first.flags.filter((f) => f.field !== 'firstName'),
      ...retry.flags.filter((f) => f.field === 'firstName'),
    ],
  };
}
