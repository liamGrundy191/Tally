import {
  type ExtractionResult,
  type FieldKey,
  type Flag,
  type RawTicketValues,
  checkExtraction,
} from '@tally/shared';
import type { ReadTicket } from '@tally/shared/extraction';
import { describe, expect, it } from 'vitest';
import { grade } from './grade.ts';
import type { TruthRow } from './truth.ts';

const settings = { today: '2026-11-18', minShiftHours: 2, maxShiftHours: 16, maxDateAgeDays: 45 };
const written: RawTicketValues = {
  firstName: 'דנה',
  workplace: 'סופר פארם',
  date: '10/11/26',
  startTime: '08:00',
  endTime: '16:30',
  totalWorked: '08:30',
};

function answer(
  values: Partial<RawTicketValues> = {},
  extra: { unsure?: Partial<Record<FieldKey, string | null>>; voided?: boolean } = {},
): ExtractionResult {
  const all = { ...written, ...values };
  return {
    fields: Object.fromEntries(
      Object.entries(all).map(([k, v]) =>
        k in (extra.unsure ?? {})
          ? [k, { value: null, legible: false, suggestion: extra.unsure![k as FieldKey] ?? null }]
          : [k, { value: v, legible: true, suggestion: null }],
      ),
    ) as ExtractionResult['fields'],
    voided: extra.voided ?? false,
    overwrittenFields: [],
    workplaceMatch: null,
    nameMatch: null,
  };
}

/** A ticket the system read with passes a and b, plus extra flags (e.g. from the image). */
const readAs = (a: ExtractionResult, b = a, extraFlags: Flag[] = []): ReadTicket => {
  const checked = checkExtraction(a, b, settings);
  return {
    id: 'x',
    checked: { ...checked, flags: [...extraFlags, ...checked.flags] },
    error: null,
    reads: { A: a, B: b },
    secondLook: null,
  };
};
const truth = (values: Partial<RawTicketValues> = {}, voided = false, page = 1): TruthRow => ({
  file: 'scan.pdf',
  page,
  values: { ...written, ...values },
  voided,
});
const one = (read: ReadTicket, t: TruthRow = truth()) =>
  grade([{ file: 'scan.pdf', page: 1, read }], [t]);

describe('grading one ticket', () => {
  it('a clean, correct ticket: every box correct, nothing for a person, gate passes', () => {
    const r = one(readAs(answer()));
    for (const k of Object.keys(written) as FieldKey[]) expect(r.fields[k].correct).toBe(1);
    expect(r.needPerson).toBe(0);
    expect(r.mistakes).toEqual([]);
    expect(r.gate.pass).toBe(true);
  });

  it('compares by meaning: 8:00 is 08:00, 10/11/2026 is 10/11/26, a hyphen is a space', () => {
    const r = one(
      readAs(answer({ startTime: '8:00', workplace: 'סופר-פארם' })),
      truth({ date: '10/11/2026' }),
    );
    expect(r.mistakes).toEqual([]);
  });

  it('a wrong value with no flag is the dangerous case, and fails the gate', () => {
    const r = one(readAs(answer({ startTime: '09:00', endTime: '17:30' })));
    expect(r.fields.startTime.wrong_not_flagged).toBe(1);
    expect(r.gate).toMatchObject({ pass: false, datesTimesWrongNotFlagged: 2 });
    expect(r.mistakes[0]).toMatchObject({
      field: 'startTime',
      what: 'WRONG AND NOT FLAGGED',
      truth: '08:00',
      system: '09:00',
    });
  });

  it('a wrong name with no flag is reported, but is not part of the dates-and-times gate', () => {
    const r = one(readAs(answer({ firstName: 'דינה' })));
    expect(r.fields.firstName.wrong_not_flagged).toBe(1);
    expect(r.gate.pass).toBe(true);
    expect(r.mistakes).toHaveLength(1);
  });

  it('a ticket-wide flag (blurry scan) does not excuse a wrong value in a box', () => {
    const r = one(
      readAs(answer({ startTime: '09:00', endTime: '17:30' }), undefined, [
        { code: 'IMAGE_BLURRY' },
      ]),
    );
    expect(r.fields.startTime.wrong_not_flagged).toBe(1);
    expect(r.gate.pass).toBe(false);
    expect(r.needPerson).toBe(1);
  });

  it('"the times do not add up" covers start, end and total', () => {
    const r = one(readAs(answer({ startTime: '09:00' })));
    expect(r.fields.startTime.wrong_not_flagged).toBe(0);
    expect(r.fields.startTime.flagged_wrong_guess).toBe(1);
    expect(r.fields.totalWorked.flagged_right_guess).toBe(1);
    expect(r.gate.pass).toBe(true);
  });

  it('an unclear box with the right guess is not a mistake; with a wrong or no guess it is listed', () => {
    const right = one(readAs(answer({}, { unsure: { endTime: '16:30' } }), answer()));
    expect(right.fields.endTime.flagged_right_guess).toBe(1);
    expect(right.mistakes).toEqual([]);
    expect(right.boxesToCheck).toBe(1);

    const wrong = one(
      readAs(
        answer({}, { unsure: { endTime: '18:30' } }),
        answer({}, { unsure: { endTime: '18:30' } }),
      ),
    );
    expect(wrong.fields.endTime.flagged_wrong_guess).toBe(1);

    const none = one(readAs(answer({ firstName: 'דנה' }), answer({ firstName: 'רנה' })));
    expect(none.fields.firstName.flagged_no_guess).toBe(1);
    expect(none.mistakes[0]!.what).toMatch(/no guess/);
  });

  it('an empty box read as empty is correct', () => {
    const r = one(
      readAs(answer({ totalWorked: null, endTime: null })),
      truth({ totalWorked: null, endTime: null }),
    );
    expect(r.fields.totalWorked.correct + r.fields.totalWorked.flagged_right_guess).toBe(1);
    expect(r.fields.totalWorked.wrong_not_flagged).toBe(0);
  });
});

describe('workplaces from the list', () => {
  const list = ['בית הורדים', 'דולב', 'דולפ'];
  const accepted = (entry: string) =>
    readAs(answer({ workplace: entry }), answer({ workplace: entry }));
  it('a misspelt workplace given its proper list name is right', () => {
    const r = grade(
      [{ file: 'scan.pdf', page: 1, read: accepted('בית הורדים') }],
      [truth({ workplace: 'בית הורדם' })],
      list,
    );
    expect(r.fields.workplace.correct).toBe(1);
    expect(r.mistakes).toEqual([]);
  });

  it('is wrong when the writing is, or also resembles, another entry', () => {
    const other = grade(
      [{ file: 'scan.pdf', page: 1, read: accepted('דולב') }],
      [truth({ workplace: 'דולפ' })],
      list,
    );
    expect(other.fields.workplace.wrong_not_flagged).toBe(1);
    const both = grade(
      [{ file: 'scan.pdf', page: 1, read: accepted('דולב') }],
      [truth({ workplace: 'דולק' })], // one letter from each
      list,
    );
    expect(both.fields.workplace.wrong_not_flagged).toBe(1);
  });

  it('an English spelling is the same place as its Hebrew name (D36)', () => {
    const spelt = ['Dolev', 'דולב', 'דולפ'];
    const placeOf = new Map([
      ['Dolev', 'דולב'],
      ['דולב', 'דולב'],
      ['דולפ', 'דולפ'],
    ]);
    const r = grade(
      [
        { file: 'scan.pdf', page: 1, read: accepted('Dolev') },
        { file: 'scan.pdf', page: 2, read: accepted('Dolev') },
        { file: 'scan.pdf', page: 3, read: accepted('Dolev') },
      ],
      [
        truth({ workplace: 'Dolev' }),
        truth({ workplace: 'Dolv' }, false, 2), // misspelt English
        truth({ workplace: 'דולפ' }, false, 3), // another place
      ],
      spelt,
      placeOf,
    );
    expect(r.fields.workplace.correct).toBe(2);
    expect(r.fields.workplace.wrong_not_flagged).toBe(1);
  });

  it('without a list, only an exact reading is right', () => {
    const r = one(readAs(answer({ workplace: 'בית הורדים' })), truth({ workplace: 'בית הורדם' }));
    expect(r.fields.workplace.wrong_not_flagged).toBe(1);
  });
});

describe('crossed-out tickets and failures', () => {
  it('a crossed-out ticket caught is not graded box by box', () => {
    const r = one(readAs(answer({}, { voided: true })), truth({ startTime: '23:00' }, true));
    expect(r.voided.caught).toBe(1);
    expect(r.mistakes).toEqual([]);
    expect(r.gate.pass).toBe(true);
  });

  it('a crossed-out ticket missed fails the gate', () => {
    const r = one(readAs(answer()), truth({}, true));
    expect(r.voided.missed).toBe(1);
    expect(r.gate).toMatchObject({ pass: false, missedVoided: 1 });
    expect(r.mistakes[0]!.what).toBe('CROSSED-OUT TICKET NOT CAUGHT');
  });

  it('a ticket wrongly marked crossed out is listed as extra work', () => {
    const r = one(readAs(answer({}, { voided: true })));
    expect(r.voided.wronglyMarked).toBe(1);
    expect(r.gate.pass).toBe(true);
  });

  it('a failed reading means a person types all six boxes', () => {
    const failed: ReadTicket = {
      id: 'x',
      checked: null,
      error: 'Connection error',
      reads: {},
      secondLook: null,
    };
    const r = one(failed);
    expect(r).toMatchObject({ failed: 1, needPerson: 1, boxesToCheck: 6 });
    expect(r.fields.startTime.flagged_no_guess).toBe(1); // counted in the per-box table too
    expect(r.mistakes[0]!.what).toMatch(/reading failed.*Connection error/);
  });

  it('lists tickets without a truth row and truth rows without a ticket, and grades neither', () => {
    const r = grade([{ file: 'scan.pdf', page: 1, read: readAs(answer()) }], [truth({}, false, 2)]);
    expect(r.graded).toBe(0);
    expect(r.noTruth).toEqual(['scan.pdf page 1']);
    expect(r.truthWithoutTicket).toEqual(['scan.pdf page 2']);
    expect(r.gate.pass).toBe(false); // nothing graded is never a pass
  });

  it('counts the risky total rule (D30), and when it was wrong', () => {
    const read = readAs(answer(), answer({}, { unsure: { totalWorked: '08:30' } }));
    expect(read.checked!.totalFromMath).toBe(true);
    const ok = one(read);
    expect(ok.totalFromMath).toEqual({ used: 1, wrong: 0 });
    // The writer really wrote 09:30; both reads "saw" the total the times give.
    const bad = one(read, truth({ totalWorked: '09:30' }));
    expect(bad.totalFromMath).toEqual({ used: 1, wrong: 1 });
    expect(bad.gate.pass).toBe(false);
  });
});
