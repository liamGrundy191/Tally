// Compares what the system did with what is really written (truth.csv). The key number is a
// wrong value that reached the result without a flag on its own box: the G0 gate needs zero of
// those in the date and the times, and zero missed crossed-out tickets (D31).
import { FIELD_KEYS, type FieldKey, type Flag, resemblesEntry, sameReading } from '@tally/shared';
import type { ReadTicket } from '@tally/shared/extraction';
import { type TruthRow, truthKey } from './truth.ts';

export type Outcome =
  | 'correct'
  | 'wrong_not_flagged'
  | 'flagged_right_guess'
  | 'flagged_wrong_guess'
  | 'flagged_no_guess';

export interface Mistake {
  file: string;
  page: number;
  field: FieldKey | 'ticket';
  what: string;
  truth: string | null;
  system: string | null;
  flags: string;
}

export interface GradedTicket {
  file: string;
  page: number;
  read: ReadTicket;
}

const TIME_FIELDS: readonly FieldKey[] = ['startTime', 'endTime', 'totalWorked'];
/** Flags about how the times relate: the reviewer then checks start, end and total together. */
const TIME_RELATION = ['TIME_MATH_MISMATCH', 'HOURS_OUT_OF_RANGE'];
const READING = ['FIELD_UNREADABLE', 'PASS_DISAGREEMENT', 'MATCH_AMBIGUOUS'];

const flagsOn = (flags: Flag[], field: FieldKey) =>
  flags.filter(
    (f) => f.field === field || (TIME_FIELDS.includes(field) && TIME_RELATION.includes(f.code)),
  );
const same = (field: FieldKey, a: string | null, b: string | null) =>
  a === null || b === null ? a === b : sameReading(field, a, b);

const WORDS: Record<Exclude<Outcome, 'correct' | 'flagged_right_guess'>, string> = {
  wrong_not_flagged: 'WRONG AND NOT FLAGGED',
  flagged_wrong_guess: 'flagged; the guess filled in is wrong',
  flagged_no_guess: 'flagged; no guess filled in',
};

/**
 * The list exists to turn a misspelt workplace into its proper name, so a list entry is right when
 * the writing resembles that entry and no other place (D31). Two spellings of one place (Dolev and
 * דולב) are the same place (D36).
 */
const rightListEntry = (
  shown: string | null,
  written: string | null,
  list: readonly string[],
  place: (s: string) => string,
) =>
  shown !== null &&
  written !== null &&
  list.includes(shown) &&
  resemblesEntry(written, shown) &&
  !list.some((e) => place(e) !== place(shown) && resemblesEntry(written, e));

export function grade(
  tickets: readonly GradedTicket[],
  truthRows: readonly TruthRow[],
  knownWorkplaces: readonly string[] = [],
  placeOf: ReadonlyMap<string, string> = new Map(),
) {
  const place = (s: string) => placeOf.get(s) ?? s;
  const rightPlace = (shown: string | null, written: string | null) =>
    (shown !== null && written !== null && same('workplace', place(shown), place(written))) ||
    rightListEntry(shown, written, knownWorkplaces, place);
  const truth = new Map(truthRows.map((r) => [truthKey(r.file, r.page), r]));
  const tally = Object.fromEntries(
    FIELD_KEYS.map((k) => [
      k,
      {
        correct: 0,
        wrong_not_flagged: 0,
        flagged_right_guess: 0,
        flagged_wrong_guess: 0,
        flagged_no_guess: 0,
      } as Record<Outcome, number>,
    ]),
  ) as Record<FieldKey, Record<Outcome, number>>;
  const mistakes: Mistake[] = [];
  const noTruth: string[] = [];
  let graded = 0;
  let failed = 0;
  let needPerson = 0;
  let boxesToCheck = 0;
  const voided = { caught: 0, missed: 0, wronglyMarked: 0 };
  const totalFromMath = { used: 0, wrong: 0 };

  for (const { file, page, read } of tickets) {
    const t = truth.get(truthKey(file, page));
    if (!t) {
      noTruth.push(`${file} page ${page}`);
      continue;
    }
    graded++;
    const note = (
      field: Mistake['field'],
      what: string,
      tr: string | null,
      sys: string | null,
      flags = '',
    ) => mistakes.push({ file, page, field, what, truth: tr, system: sys, flags });

    const c = read.checked;
    if (!c) {
      failed++;
      needPerson++;
      boxesToCheck += FIELD_KEYS.length;
      for (const k of FIELD_KEYS) tally[k].flagged_no_guess++; // all six are typed by a person
      note('ticket', `reading failed, a person types the whole ticket (${read.error})`, null, null);
      continue;
    }
    if (c.flags.length > 0) needPerson++;
    const systemVoided = c.flags.some((f) => f.code === 'VOIDED_TICKET');
    if (t.voided && systemVoided) {
      voided.caught++;
      boxesToCheck++;
      continue; // a crossed-out ticket is excluded as a whole; its boxes do not matter
    }
    if (t.voided) {
      voided.missed++;
      note('ticket', 'CROSSED-OUT TICKET NOT CAUGHT', 'crossed out', 'not crossed out');
    }
    if (systemVoided && !t.voided) {
      voided.wronglyMarked++;
      note('ticket', 'marked crossed out, but it is not', 'not crossed out', 'crossed out');
    }
    let fieldsChecked = 0;
    for (const k of FIELD_KEYS) {
      const own = flagsOn(c.flags, k);
      const truthValue = t.values[k];
      let outcome: Outcome;
      let shown: string | null;
      if (own.length === 0) {
        shown = c.values[k];
        const right =
          same(k, shown, truthValue) || (k === 'workplace' && rightPlace(shown, truthValue));
        outcome = right ? 'correct' : 'wrong_not_flagged';
      } else {
        fieldsChecked++;
        // What the reviewer finds filled in: the guess, or the value when no reading was in doubt.
        const doubted = own.some((f) => READING.includes(f.code));
        shown = c.suggestions[k] ?? (doubted ? null : c.values[k]);
        const right =
          same(k, shown, truthValue) || (k === 'workplace' && rightPlace(shown, truthValue));
        outcome = right
          ? 'flagged_right_guess'
          : shown === null
            ? 'flagged_no_guess'
            : 'flagged_wrong_guess';
      }
      tally[k][outcome]++;
      if (k === 'totalWorked' && c.totalFromMath) {
        totalFromMath.used++;
        if (outcome !== 'correct') totalFromMath.wrong++;
      }
      if (outcome !== 'correct' && outcome !== 'flagged_right_guess') {
        note(k, WORDS[outcome], truthValue, shown, own.map((f) => f.code).join(' '));
      }
    }
    const ticketWide = c.flags.some((f) => f.field === undefined && f.code !== 'VOIDED_TICKET');
    boxesToCheck += fieldsChecked + (systemVoided || (fieldsChecked === 0 && ticketWide) ? 1 : 0);
  }

  const read = new Set(tickets.map((t) => truthKey(t.file, t.page)));
  const truthWithoutTicket = truthRows
    .filter((r) => !read.has(truthKey(r.file, r.page)))
    .map((r) => `${r.file} page ${r.page}`);
  const datesTimesWrong = (['date', ...TIME_FIELDS] as FieldKey[]).reduce(
    (n, k) => n + tally[k].wrong_not_flagged,
    0,
  );
  // Dangerous mistakes first, then missing guesses, then wrong guesses.
  const rank = (m: Mistake) => (/^[A-Z]/.test(m.what) ? 0 : m.what.includes('failed') ? 1 : 2);
  mistakes.sort((a, b) => rank(a) - rank(b));

  return {
    tickets: tickets.length,
    graded,
    noTruth,
    truthWithoutTicket,
    failed,
    needPerson,
    boxesToCheck,
    voided,
    fields: tally,
    totalFromMath,
    gate: {
      datesTimesWrongNotFlagged: datesTimesWrong,
      missedVoided: voided.missed,
      pass: graded > 0 && datesTimesWrong === 0 && voided.missed === 0,
    },
    mistakes,
  };
}

export type Report = ReturnType<typeof grade>;
