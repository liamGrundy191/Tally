import { describe, expect, it } from 'vitest';
import {
  type ExtractionResult,
  ExtractionResultSchema,
  type FlagCode,
  type RawTicketValues,
} from './schemas.ts';
import {
  batchNameCandidates,
  checkExtraction,
  checkTicketValues,
  reconcilePasses,
  type RuleSettings,
  trustedName,
  unclearFields,
  withRetriedName,
} from './ticket.ts';

const settings: RuleSettings = {
  today: '2026-11-18',
  minShiftHours: 2,
  maxShiftHours: 16,
  maxDateAgeDays: 45,
};

const goodValues: RawTicketValues = {
  firstName: 'דוד',
  workplace: 'סופר פארם',
  date: '10/11/26',
  startTime: '08:00',
  endTime: '16:30',
  totalWorked: '08:30',
};

/** One extraction pass that read every field cleanly, with optional changes. */
function pass(
  values: Partial<RawTicketValues> = {},
  extra: {
    unreadable?: (keyof RawTicketValues)[];
    voided?: boolean;
    overwritten?: (keyof RawTicketValues)[];
    suggestions?: Partial<RawTicketValues>;
    workplaceMatch?: string | null;
    nameMatch?: string | null;
  } = {},
): ExtractionResult {
  const all = { ...goodValues, ...values };
  return {
    fields: Object.fromEntries(
      Object.entries(all).map(([k, v]) => {
        const key = k as keyof RawTicketValues;
        const legible = !extra.unreadable?.includes(key);
        return [
          k,
          { value: v, legible, suggestion: legible ? null : (extra.suggestions?.[key] ?? null) },
        ];
      }),
    ) as ExtractionResult['fields'],
    voided: extra.voided ?? false,
    overwrittenFields: extra.overwritten ?? [],
    workplaceMatch: extra.workplaceMatch ?? null,
    nameMatch: extra.nameMatch ?? null,
  };
}

const codes = (flags: { code: FlagCode; field?: string }[]) =>
  flags.map((f) => (f.field ? `${f.code}:${f.field}` : f.code));
const check = (values: Partial<RawTicketValues>) =>
  codes(checkTicketValues({ ...goodValues, ...values }, settings).flags);

describe('a clean ticket', () => {
  it('raises no flags when both passes agree and every rule passes', () => {
    const result = checkExtraction(pass(), pass(), settings);
    expect(result.flags).toEqual([]);
    expect(result.fields).toEqual({
      firstName: 'דוד',
      workplace: 'סופר פארם',
      shiftDate: '2026-11-10',
      startMinutes: 480,
      endMinutes: 990,
      totalMinutes: 510,
    });
  });
});

describe('extraction result schema', () => {
  it('accepts a valid result', () => {
    expect(ExtractionResultSchema.safeParse(pass()).success).toBe(true);
  });

  it('accepts null for a field the extractor could not read', () => {
    const r = pass({}, { unreadable: ['endTime'] });
    r.fields.endTime.value = null;
    expect(ExtractionResultSchema.safeParse(r).success).toBe(true);
  });

  it('rejects a result with a field missing (counts as a failed attempt)', () => {
    const r = pass() as unknown as { fields: Record<string, unknown> };
    delete r.fields.workplace;
    expect(ExtractionResultSchema.safeParse(r).success).toBe(false);
  });

  it('rejects a number where text is expected', () => {
    const r = pass() as unknown as { fields: { totalWorked: { value: unknown } } };
    r.fields.totalWorked.value = 8.5;
    expect(ExtractionResultSchema.safeParse(r).success).toBe(false);
  });

  it('rejects an overwritten field that does not exist on the ticket', () => {
    const r = { ...pass(), overwrittenFields: ['lastName'] };
    expect(ExtractionResultSchema.safeParse(r).success).toBe(false);
  });

  it('rejects a result without the voided answer', () => {
    const r: Partial<ExtractionResult> = pass();
    delete r.voided;
    expect(ExtractionResultSchema.safeParse(r).success).toBe(false);
  });
});

describe('PASS_DISAGREEMENT: the two readings differ', () => {
  it('flags different times (08:30 / 06:30) and keeps both readings for the reviewer', () => {
    const r = reconcilePasses(pass({ totalWorked: '08:30' }), pass({ totalWorked: '06:30' }));
    expect(r.flags).toEqual([
      {
        code: 'PASS_DISAGREEMENT',
        field: 'totalWorked',
        detail: { passA: '08:30', passB: '06:30' },
      },
    ]);
  });

  it('flags different names (דוד / דויד)', () => {
    expect(codes(reconcilePasses(pass(), pass({ firstName: 'דויד' })).flags)).toEqual([
      'PASS_DISAGREEMENT:firstName',
    ]);
  });

  it('flags different dates', () => {
    expect(codes(reconcilePasses(pass(), pass({ date: '16/11/26' })).flags)).toEqual([
      'PASS_DISAGREEMENT:date',
    ]);
  });

  it('flags when one pass sees an empty box and the other a value', () => {
    const r = reconcilePasses(pass({ workplace: null }), pass());
    expect(codes(r.flags)).toEqual(['PASS_DISAGREEMENT:workplace']);
    expect(r.values.workplace).toBe('סופר פארם');
  });

  it('flags when one reading is a real time and the other is not', () => {
    expect(codes(reconcilePasses(pass(), pass({ startTime: '08:00:00' })).flags)).toEqual([
      'PASS_DISAGREEMENT:startTime',
    ]);
  });

  it('does not flag readings that mean the same: 8:30 / 08:30', () => {
    expect(
      reconcilePasses(pass({ startTime: '8:30' }), pass({ startTime: '08:30' })).flags,
    ).toEqual([]);
  });

  it('does not flag readings that mean the same: 10/11/26 / 10.11.26', () => {
    expect(reconcilePasses(pass(), pass({ date: '10.11.26' })).flags).toEqual([]);
  });

  it('does not flag readings that mean the same: סופר-פארם / סופר פארם', () => {
    expect(reconcilePasses(pass({ workplace: 'סופר-פארם' }), pass()).flags).toEqual([]);
  });

  it('does not flag 24:00 / 00:00 as an end time (both midnight)', () => {
    expect(reconcilePasses(pass({ endTime: '24:00' }), pass({ endTime: '00:00' })).flags).toEqual(
      [],
    );
  });

  it('treats two different unreadable texts as a disagreement ("eight" / "nine")', () => {
    expect(
      codes(reconcilePasses(pass({ startTime: 'eight' }), pass({ startTime: 'nine' })).flags),
    ).toEqual(['PASS_DISAGREEMENT:startTime']);
  });
});

describe('FIELD_UNREADABLE: either pass could not read a field', () => {
  it('flags a field that one pass marked not legible', () => {
    expect(codes(reconcilePasses(pass({}, { unreadable: ['endTime'] }), pass()).flags)).toEqual([
      'FIELD_UNREADABLE:endTime',
    ]);
  });

  it('never uses a value from a pass that said it could not read the field', () => {
    const r = reconcilePasses(
      pass({ endTime: '16:30' }, { unreadable: ['endTime'] }),
      pass({ endTime: '18:30' }, { unreadable: ['endTime'] }),
    );
    expect(r.values.endTime).toBeNull();
  });

  it('keeps the readable pass value to help the reviewer, still flagged', () => {
    const r = reconcilePasses(pass({ endTime: '99:99' }, { unreadable: ['endTime'] }), pass());
    expect(r.values.endTime).toBe('16:30');
    expect(codes(r.flags)).toEqual(['FIELD_UNREADABLE:endTime']);
  });

  it('does not also flag the field as empty', () => {
    const r = checkExtraction(
      pass({ endTime: null }, { unreadable: ['endTime'] }),
      pass({ endTime: null }, { unreadable: ['endTime'] }),
      settings,
    );
    expect(codes(r.flags)).toEqual(['FIELD_UNREADABLE:endTime']);
  });
});

describe('FIELD_EMPTY: a box left blank on the paper', () => {
  it('flags a field both passes saw as empty', () => {
    const r = checkExtraction(pass({ workplace: null }), pass({ workplace: '  ' }), settings);
    expect(codes(r.flags)).toEqual(['FIELD_EMPTY:workplace']);
  });

  it('flags every empty field when a person saves', () => {
    expect(check({ firstName: '', totalWorked: null })).toEqual([
      'FIELD_EMPTY:firstName',
      'FIELD_EMPTY:totalWorked',
    ]);
  });

  it('treats a name or workplace of only punctuation ("-", ".") as empty', () => {
    expect(check({ firstName: '-', workplace: ' . ' })).toEqual([
      'FIELD_EMPTY:firstName',
      'FIELD_EMPTY:workplace',
    ]);
  });

  it('treats a date or time of only a dash or a dot as empty, not as an invalid value', () => {
    expect(check({ date: '-', startTime: '.', endTime: ' - ', totalWorked: '--:--' })).toEqual([
      'FIELD_EMPTY:date',
      'FIELD_EMPTY:startTime',
      'FIELD_EMPTY:endTime',
      'FIELD_EMPTY:totalWorked',
    ]);
  });

  it('ignores invisible characters copying can add: soft hyphen, Arabic letter mark', () => {
    expect(check({ firstName: 'Dana\u00ad' })).toEqual([]);
    expect(check({ firstName: 'דנה\u061c' })).toEqual([]);
  });

  it('refuses to check with a malformed "today", which would skip the date checks', () => {
    expect(() => checkTicketValues(goodValues, { ...settings, today: '21/11/2026' })).toThrow(
      /YYYY-MM-DD/,
    );
  });

  it('does not work out a missing total from start and end (no guessing)', () => {
    const r = checkTicketValues({ ...goodValues, totalWorked: null }, settings);
    expect(r.fields.totalMinutes).toBeNull();
    expect(codes(r.flags)).toEqual(['FIELD_EMPTY:totalWorked']);
  });
});

describe('CORRECTION_MARKS: overwritten characters', () => {
  it('flags each overwritten field reported by either pass', () => {
    const r = reconcilePasses(
      pass({}, { overwritten: ['totalWorked'] }),
      pass({}, { overwritten: ['date', 'totalWorked'] }),
    );
    expect(codes(r.flags)).toEqual(['CORRECTION_MARKS:date', 'CORRECTION_MARKS:totalWorked']);
  });
});

describe('VOIDED_TICKET: the ticket is crossed out', () => {
  it('flags when either pass reports it crossed out', () => {
    expect(codes(reconcilePasses(pass(), pass({}, { voided: true })).flags)).toEqual([
      'VOIDED_TICKET',
    ]);
  });
});

describe('TIME_INVALID: a time that cannot exist', () => {
  it.each([
    ['startTime', '25:00'],
    ['startTime', '24:00'],
    ['endTime', '23:60'],
    ['totalWorked', '8.5'],
    ['totalWorked', '8'],
  ] as const)('flags %s %j', (field, value) => {
    expect(check({ [field]: value })).toContain(`TIME_INVALID:${field}`);
  });

  it('skips the arithmetic check when a time is invalid (no misleading second flag)', () => {
    expect(check({ startTime: '25:00' })).toEqual(['TIME_INVALID:startTime']);
  });
});

describe('TIME_MATH_MISMATCH: end − start ≠ total (midnight allowed)', () => {
  it('flags 08:00 → 15:30 with total 08:30 (math gives 7:30)', () => {
    const r = checkTicketValues({ ...goodValues, endTime: '15:30' }, settings);
    expect(r.flags).toEqual([
      { code: 'TIME_MATH_MISMATCH', field: 'totalWorked', detail: { computed: 450, total: 510 } },
    ]);
  });

  it('accepts a midnight shift 22:00 → 06:00 with total 08:00', () => {
    expect(check({ startTime: '22:00', endTime: '06:00', totalWorked: '08:00' })).toEqual([]);
  });

  it('accepts a shift ending at 24:00: 16:00 → 24:00 with total 08:00', () => {
    expect(check({ startTime: '16:00', endTime: '24:00', totalWorked: '08:00' })).toEqual([]);
  });

  it('flags a total written in decimal hours as minutes (8.5 hours written 08:50)', () => {
    expect(check({ totalWorked: '08:50' })).toEqual(['TIME_MATH_MISMATCH:totalWorked']);
  });

  it('flags a 12-hour clock end time (08:00 → 04:30 meaning 16:30, total 08:30)', () => {
    expect(check({ endTime: '04:30' })).toEqual(['TIME_MATH_MISMATCH:totalWorked']);
  });

  it('flags a daylight-saving night where the leader wrote the real hours (22:00 → 06:00, total 07:00)', () => {
    expect(check({ startTime: '22:00', endTime: '06:00', totalWorked: '07:00' })).toEqual([
      'TIME_MATH_MISMATCH:totalWorked',
    ]);
  });

  it('flags a total that counts an overnight shift wrongly (22:00 → 06:00, total 16:00)', () => {
    expect(check({ startTime: '22:00', endTime: '06:00', totalWorked: '16:00' })).toEqual([
      'TIME_MATH_MISMATCH:totalWorked',
    ]);
  });
});

describe('HOURS_OUT_OF_RANGE: total is under MIN_SHIFT_HOURS (2) or above MAX_SHIFT_HOURS (16)', () => {
  it('flags a total of 1:59 (too short; more often a misreading than a real shift)', () => {
    expect(check({ startTime: '08:00', endTime: '09:59', totalWorked: '01:59' })).toEqual([
      'HOURS_OUT_OF_RANGE:totalWorked',
    ]);
  });

  it('flags 0:30, which may be a misread 08:30', () => {
    expect(check({ startTime: '08:00', endTime: '08:30', totalWorked: '00:30' })).toEqual([
      'HOURS_OUT_OF_RANGE:totalWorked',
    ]);
  });

  it('accepts exactly 2:00', () => {
    expect(check({ startTime: '08:00', endTime: '10:00', totalWorked: '02:00' })).toEqual([]);
  });

  it('flags a total of 0:00', () => {
    expect(check({ startTime: '08:00', endTime: '08:00', totalWorked: '00:00' })).toEqual([
      'HOURS_OUT_OF_RANGE:totalWorked',
    ]);
  });

  it('flags a total of 19:00', () => {
    expect(check({ startTime: '06:00', endTime: '01:00', totalWorked: '19:00' })).toEqual([
      'HOURS_OUT_OF_RANGE:totalWorked',
    ]);
  });

  it('accepts exactly 16:00', () => {
    expect(check({ startTime: '06:00', endTime: '22:00', totalWorked: '16:00' })).toEqual([]);
  });

  it('flags 16:01', () => {
    expect(check({ startTime: '06:00', endTime: '22:01', totalWorked: '16:01' })).toEqual([
      'HOURS_OUT_OF_RANGE:totalWorked',
    ]);
  });

  it('uses start and end when the total is missing', () => {
    expect(check({ startTime: '06:00', endTime: '01:00', totalWorked: null })).toEqual([
      'FIELD_EMPTY:totalWorked',
      'HOURS_OUT_OF_RANGE',
    ]);
  });

  it('follows the MAX_SHIFT_HOURS setting', () => {
    const r = checkTicketValues(goodValues, { ...settings, maxShiftHours: 8 });
    expect(codes(r.flags)).toEqual(['HOURS_OUT_OF_RANGE:totalWorked']);
  });
});

describe('DATE_IN_FUTURE: the date is after today', () => {
  it('flags tomorrow', () => {
    expect(check({ date: '19/11/26' })).toEqual(['DATE_IN_FUTURE:date']);
  });

  it('accepts today', () => {
    expect(check({ date: '18/11/26' })).toEqual([]);
  });

  it('flags a mistyped year in the future (18/11/62)', () => {
    expect(check({ date: '18/11/62' })).toEqual(['DATE_IN_FUTURE:date']);
  });
});

describe('DATE_TOO_OLD: more than MAX_DATE_AGE_DAYS before today', () => {
  it('accepts exactly 45 days ago', () => {
    expect(check({ date: '04/10/26' })).toEqual([]);
  });

  it('flags 46 days ago', () => {
    expect(check({ date: '03/10/26' })).toEqual(['DATE_TOO_OLD:date']);
  });

  it('flags last year written by mistake (18/11/25)', () => {
    expect(check({ date: '18/11/25' })).toEqual(['DATE_TOO_OLD:date']);
  });
});

describe('DATE_INVALID: not a real calendar date', () => {
  it('flags 31/02', () => {
    const r = checkTicketValues({ ...goodValues, date: '31/02/26' }, settings);
    expect(r.flags).toEqual([
      { code: 'DATE_INVALID', field: 'date', detail: { value: '31/02/26', reason: 'not_a_date' } },
    ]);
    expect(r.fields.shiftDate).toBeNull();
  });

  it('flags a date in the wrong order (11/18/26, month first)', () => {
    expect(check({ date: '11/18/26' })).toEqual(['DATE_INVALID:date']);
  });

  it('flags something that is not a date at all', () => {
    expect(check({ date: '1811' })).toEqual(['DATE_INVALID:date']);
  });
});

describe('SCRIPT_UNEXPECTED: a name that is not plain Hebrew or English', () => {
  it('accepts a Hebrew name', () => {
    expect(check({ firstName: 'דוד' })).toEqual([]);
  });

  it('accepts an English name (Liam: English is fine)', () => {
    expect(check({ firstName: 'David' })).toEqual([]);
  });

  it('flags a digit in a name', () => {
    expect(check({ firstName: 'ד4וד' })).toEqual(['SCRIPT_UNEXPECTED:firstName']);
  });

  it('flags Hebrew and English mixed in one name', () => {
    expect(check({ firstName: 'Davidכהן' })).toEqual(['SCRIPT_UNEXPECTED:firstName']);
  });

  it('does not check the workplace (brand names may be anything)', () => {
    expect(check({ workplace: 'H&M 3' })).toEqual([]);
  });
});

describe('suggestions: best guesses for unclear boxes, never used as values', () => {
  it('passes on a suggestion both readings agree on', () => {
    const r = checkExtraction(
      pass({ firstName: null }, { unreadable: ['firstName'], suggestions: { firstName: 'זהריה' } }),
      pass({ firstName: null }, { unreadable: ['firstName'], suggestions: { firstName: 'זהריה' } }),
      settings,
    );
    expect(r.suggestions).toEqual({ firstName: 'זהריה' });
    expect(r.fields.firstName).toBeNull(); // still empty until a person confirms
    expect(codes(r.flags)).toEqual(['FIELD_UNREADABLE:firstName']);
  });

  it('passes on the only suggestion when one reading has none', () => {
    const r = reconcilePasses(
      pass({ firstName: null }, { unreadable: ['firstName'], suggestions: { firstName: 'זהריה' } }),
      pass({ firstName: null }, { unreadable: ['firstName'] }),
    );
    expect(r.suggestions).toEqual({ firstName: 'זהריה' });
  });

  it('offers no suggestion when the two guesses differ, but keeps both for the reviewer', () => {
    const r = reconcilePasses(
      pass({ firstName: null }, { unreadable: ['firstName'], suggestions: { firstName: 'זהריה' } }),
      pass({ firstName: null }, { unreadable: ['firstName'], suggestions: { firstName: 'להריה' } }),
    );
    expect(r.suggestions).toEqual({});
    expect(r.flags[0]!.detail).toMatchObject({ suggestionA: 'זהריה', suggestionB: 'להריה' });
  });

  it('uses the clear reading of one pass as the suggestion when the other could not read it', () => {
    const r = reconcilePasses(pass(), pass({ endTime: null }, { unreadable: ['endTime'] }));
    expect(r.suggestions).toEqual({ endTime: '16:30' });
  });
});

describe('workplace list (D25)', () => {
  const list = {
    knownWorkplaces: [
      'משק ברזלי',
      'הסנה הבוער',
      'סופר פארם',
      'שופרסל דיל',
      'שופרסל אקספרס',
      'רמי לוי',
    ],
  };
  const unreadableWorkplace = (suggestion: string | null, match: string | null) =>
    pass(
      { workplace: null },
      { unreadable: ['workplace'], suggestions: { workplace: suggestion }, workplaceMatch: match },
    );

  it('accepts the workplace when both readings pick the same entry and the writing resembles it', () => {
    const r = checkExtraction(
      unreadableWorkplace('משק בר?לי', 'משק ברזלי'),
      unreadableWorkplace('משק ברזלי', 'משק ברזלי'),
      settings,
      list,
    );
    expect(r.flags).toEqual([]);
    expect(r.fields.workplace).toBe('משק ברזלי');
    expect(r.workplaceFromList).toBe(true);
  });

  it('accepts a clearly read workplace that matches an entry', () => {
    const r = checkExtraction(
      pass({}, { workplaceMatch: 'סופר פארם' }),
      pass({ workplace: 'סופר-פארם' }, { workplaceMatch: 'סופר פארם' }),
      settings,
      list,
    );
    expect(r.flags).toEqual([]);
    expect(r.fields.workplace).toBe('סופר פארם');
  });

  it('accepts a workplace with a number read in the other word order', () => {
    const r = checkExtraction(
      unreadableWorkplace('שושנים 12', '12 שושנים'),
      unreadableWorkplace('12 שושנים', '12 שושנים'),
      settings,
      { knownWorkplaces: ['12 שושנים', 'כרמלית'] },
    );
    expect(r.flags).toEqual([]);
    expect(r.fields.workplace).toBe('12 שושנים');
  });

  it('flags when the readings pick different entries', () => {
    const r = checkExtraction(
      unreadableWorkplace('שופרסל', 'שופרסל דיל'),
      unreadableWorkplace('שופרסל', 'שופרסל אקספרס'),
      settings,
      list,
    );
    expect(codes(r.flags)).toEqual(['FIELD_UNREADABLE:workplace']);
    expect(r.suggestions.workplace).toBeUndefined();
  });

  it('flags when only one reading picks an entry, and suggests it', () => {
    const r = checkExtraction(
      unreadableWorkplace('רמי לוי', 'רמי לוי'),
      unreadableWorkplace(null, null),
      settings,
      list,
    );
    expect(codes(r.flags)).toEqual(['FIELD_UNREADABLE:workplace']);
    expect(r.suggestions.workplace).toBe('רמי לוי');
  });

  it('flags when both pick an entry the handwriting does not resemble (no forced matches)', () => {
    const r = checkExtraction(
      unreadableWorkplace('הסנה הבוער', 'משק ברזלי'),
      unreadableWorkplace('הסנה הבוער', 'משק ברזלי'),
      settings,
      list,
    );
    expect(codes(r.flags)).toEqual(['FIELD_UNREADABLE:workplace']);
    expect(r.fields.workplace).toBeNull();
  });

  it('flags when both pick an entry but neither offers any reading of the handwriting', () => {
    const r = checkExtraction(
      unreadableWorkplace(null, 'משק ברזלי'),
      unreadableWorkplace(null, 'משק ברזלי'),
      settings,
      list,
    );
    expect(codes(r.flags)).toEqual(['FIELD_UNREADABLE:workplace']);
    expect(r.suggestions.workplace).toBe('משק ברזלי');
  });

  it('flags a workplace that is not on the list as possibly new', () => {
    const r = checkExtraction(pass(), pass(), settings, list);
    expect(codes(r.flags)).toEqual(['WORKPLACE_NOT_ON_LIST:workplace']);
  });

  it('keeps an overwritten workplace flagged even when it matches', () => {
    const r = checkExtraction(
      pass({}, { workplaceMatch: 'סופר פארם', overwritten: ['workplace'] }),
      pass({}, { workplaceMatch: 'סופר פארם' }),
      settings,
      list,
    );
    expect(codes(r.flags)).toEqual(['CORRECTION_MARKS:workplace']);
  });

  it('keeps the stricter look-alike test for workplaces: two letters apart still counts', () => {
    const r = checkExtraction(
      pass({ workplace: 'בית נוי' }, { workplaceMatch: 'בית נוי' }),
      pass({ workplace: 'בית נוי' }, { workplaceMatch: 'בית נוי' }),
      settings,
      { knownWorkplaces: ['בית נוי', 'בית נוף', 'בית מוף'] },
    );
    expect(r.flags[0]!.detail).toEqual({ match: 'בית נוי', alsoFits: ['בית נוף', 'בית מוף'] });
  });

  it('flags when the handwriting also fits a second, similar entry on the list', () => {
    const twins = { knownWorkplaces: ['בית נוי', 'בית נוף'] };
    const r = checkExtraction(
      pass({ workplace: 'בית נוי' }, { workplaceMatch: 'בית נוי' }),
      pass({ workplace: 'בית נוי' }, { workplaceMatch: 'בית נוי' }),
      settings,
      twins,
    );
    expect(codes(r.flags)).toEqual(['MATCH_AMBIGUOUS:workplace']);
    expect(r.flags[0]!.detail).toEqual({ match: 'בית נוי', alsoFits: ['בית נוף'] });
    expect(r.suggestions.workplace).toBe('בית נוי');
    expect(r.workplaceFromList).toBe(false);
  });

  it('does nothing extra when no list was used', () => {
    expect(checkExtraction(pass(), pass(), settings).flags).toEqual([]);
  });
});

describe('known names list (D28)', () => {
  const names = { knownNames: ['זהריה', 'מוברטו', 'אוסף', 'דנה', 'דינה'] };
  const unreadableName = (suggestion: string | null, match: string | null) =>
    pass(
      { firstName: null },
      { unreadable: ['firstName'], suggestions: { firstName: suggestion }, nameMatch: match },
    );

  it('accepts the name when both readings pick the same entry and the writing resembles it', () => {
    const r = checkExtraction(
      unreadableName('זהריה', 'זהריה'),
      unreadableName('להריה', 'זהריה'),
      settings,
      names,
    );
    expect(r.flags).toEqual([]);
    expect(r.fields.firstName).toBe('זהריה');
    expect(r.nameFromList).toBe(true);
  });

  it('sends a name with a look-alike on the list to a person, even when both readings agree', () => {
    const r = checkExtraction(
      pass({ firstName: 'דנה' }, { nameMatch: 'דנה' }),
      pass({ firstName: 'דנה' }, { nameMatch: 'דנה' }),
      settings,
      names,
    );
    expect(codes(r.flags)).toEqual(['MATCH_AMBIGUOUS:firstName']);
    expect(r.suggestions.firstName).toBe('דנה');
  });

  it('does not count short names two letters apart as look-alikes', () => {
    // Liam's tickets: הלן was blocked by הדס, and זהריה by זהאי.
    for (const [name, other] of [
      ['הלן', 'הדס'],
      ['זהריה', 'זהאי'],
    ]) {
      const r = checkExtraction(
        pass({ firstName: name }, { nameMatch: name }),
        pass({ firstName: name }, { nameMatch: name }),
        settings,
        { knownNames: [name!, other!] },
      );
      expect(r.flags).toEqual([]);
      expect(r.nameFromList).toBe(true);
    }
  });

  it('never replaces a name both readings read clearly with another list entry', () => {
    // "Dina" may be a new worker, not "Dana": a person decides, with the entry suggested.
    const r = checkExtraction(
      pass({ firstName: 'Dina' }, { nameMatch: 'Dana' }),
      pass({ firstName: 'Dina' }, { nameMatch: 'Dana' }),
      settings,
      { knownNames: ['Dana'] },
    );
    expect(r.fields.firstName).toBe('Dina');
    expect(codes(r.flags)).toEqual(['MATCH_AMBIGUOUS:firstName']);
    expect(r.suggestions.firstName).toBe('Dana');
    expect(r.nameFromList).toBe(false);
  });

  it('keeps a disagreement between two clear readings, even when both pick one entry', () => {
    const r = checkExtraction(
      pass({ firstName: 'Dana' }, { nameMatch: 'Dana' }),
      pass({ firstName: 'Dina' }, { nameMatch: 'Dana' }),
      settings,
      { knownNames: ['Dana'] },
    );
    expect(codes(r.flags)).toEqual(['PASS_DISAGREEMENT:firstName']);
    expect(r.nameFromList).toBe(false);
  });

  it('does not flag a clearly read name that is not on the list: new workers are normal', () => {
    const r = checkExtraction(pass(), pass(), settings, names);
    expect(r.flags).toEqual([]);
    expect(r.fields.firstName).toBe('דוד');
  });

  it('never forces an entry the handwriting does not resemble', () => {
    const r = checkExtraction(
      unreadableName('אברהם', 'אוסף'),
      unreadableName('אברהם', 'אוסף'),
      settings,
      names,
    );
    expect(codes(r.flags)).toEqual(['FIELD_UNREADABLE:firstName']);
    expect(r.nameFromList).toBe(false);
  });

  it('flags when the readings pick different names', () => {
    const r = checkExtraction(
      unreadableName('דנה', 'דנה'),
      unreadableName('דינה', 'דינה'),
      settings,
      names,
    );
    expect(codes(r.flags)).toEqual(['FIELD_UNREADABLE:firstName']);
    expect(r.suggestions.firstName).toBeUndefined();
  });
});

describe('a total confirmed by the times (D30, risky)', () => {
  const unsureTotal = (guess: string | null) =>
    pass(
      { totalWorked: null },
      { unreadable: ['totalWorked'], suggestions: { totalWorked: guess } },
    );

  it('accepts an unclear total when both passes offer what end minus start gives', () => {
    const r = checkExtraction(pass(), unsureTotal('8:30'), settings);
    expect(r.flags).toEqual([]);
    expect(r.fields.totalMinutes).toBe(510);
    expect(r.totalFromMath).toBe(true);
  });

  it('works across midnight', () => {
    const night = { startTime: '22:00', endTime: '06:00', totalWorked: null };
    const r = checkExtraction(
      pass(night, { unreadable: ['totalWorked'], suggestions: { totalWorked: '08:00' } }),
      pass(night, { unreadable: ['totalWorked'], suggestions: { totalWorked: '8:00' } }),
      settings,
    );
    expect(r.totalFromMath).toBe(true);
  });

  it('does not when only one pass offers a total', () => {
    const r = checkExtraction(unsureTotal('08:30'), unsureTotal(null), settings);
    expect(codes(r.flags)).toEqual(['FIELD_UNREADABLE:totalWorked']);
    expect(r.totalFromMath).toBe(false);
  });

  it('does not when the guess does not match the times', () => {
    const r = checkExtraction(unsureTotal('08:00'), unsureTotal('08:00'), settings);
    expect(codes(r.flags)).toContain('FIELD_UNREADABLE:totalWorked');
    expect(r.totalFromMath).toBe(false);
  });

  it('does not when a time is unclear, or the total looks corrected', () => {
    const unsureEnd = pass(
      { totalWorked: null },
      { unreadable: ['totalWorked', 'endTime'], suggestions: { totalWorked: '08:30' } },
    );
    expect(checkExtraction(unsureEnd, unsureTotal('08:30'), settings).totalFromMath).toBe(false);
    const corrected = pass(
      { totalWorked: null },
      {
        unreadable: ['totalWorked'],
        suggestions: { totalWorked: '08:30' },
        overwritten: ['totalWorked'],
      },
    );
    expect(checkExtraction(corrected, unsureTotal('08:30'), settings).totalFromMath).toBe(false);
  });
});

describe('third read (pass C, D27)', () => {
  it('can raise a doubt the first two missed: crossed out, or overwritten', () => {
    const r = checkExtraction(pass(), pass(), settings, {
      thirdRead: pass({}, { voided: true, overwritten: ['endTime'] }),
    });
    expect(codes(r.flags)).toEqual(['VOIDED_TICKET', 'CORRECTION_MARKS:endTime']);
  });

  it('stops a total being confirmed by the times when it reads another total (D30)', () => {
    const unsureTotal = pass(
      { totalWorked: null },
      { unreadable: ['totalWorked'], suggestions: { totalWorked: '08:30' } },
    );
    const r = checkExtraction(unsureTotal, unsureTotal, settings, {
      thirdRead: pass({ totalWorked: '06:30' }),
    });
    expect(r.totalFromMath).toBe(false);
    expect(codes(r.flags)).toContain('FIELD_UNREADABLE:totalWorked');
  });

  const unreadable = (suggestion: string | null) =>
    pass(
      { firstName: null },
      { unreadable: ['firstName'], suggestions: { firstName: suggestion } },
    );

  it('breaks a tie between two guesses, but the field stays flagged', () => {
    const r = checkExtraction(unreadable('זהריה'), unreadable('להריה'), settings, {
      thirdRead: unreadable('זהריה'),
    });
    expect(codes(r.flags)).toEqual(['FIELD_UNREADABLE:firstName']);
    expect(r.suggestions.firstName).toBe('זהריה');
    expect(r.fields.firstName).toBeNull();
  });

  it('a clear third reading never settles a disagreement', () => {
    const r = checkExtraction(pass({ endTime: '16:30' }), pass({ endTime: '18:30' }), settings, {
      thirdRead: pass({ endTime: '16:30' }),
    });
    expect(codes(r.flags)).toContain('PASS_DISAGREEMENT:endTime');
    expect(r.suggestions.endTime).toBe('16:30');
  });

  it('offers no suggestion when all three readings differ', () => {
    const r = checkExtraction(unreadable('זהריה'), unreadable('להריה'), settings, {
      thirdRead: unreadable('זבריה'),
    });
    expect(r.suggestions.firstName).toBeUndefined();
  });

  it('is asked only about the fields the two passes could not settle', () => {
    const r = checkExtraction(unreadable('זהריה'), pass({ firstName: null }), settings);
    expect(unclearFields(r)).toEqual(['firstName']);
    expect(unclearFields(checkExtraction(pass(), pass(), settings))).toEqual([]);
  });
});

describe('names from the same batch (D28)', () => {
  const unreadableName = (suggestion: string | null, match: string | null = null) =>
    pass(
      { firstName: null },
      { unreadable: ['firstName'], suggestions: { firstName: suggestion }, nameMatch: match },
    );

  it('trusts only names no rule doubted', () => {
    expect(trustedName(checkExtraction(pass(), pass(), settings))).toBe('דוד');
    const unclear = checkExtraction(unreadableName('דוד'), unreadableName('דוד'), settings);
    expect(trustedName(unclear)).toBeNull();
    const voided = checkExtraction(pass({}, { voided: true }), pass(), settings);
    expect(trustedName(voided)).toBeNull();
  });

  it('gives an unclear name a second look only with batch names that resemble it', () => {
    const a = unreadableName('מוברטו');
    const b = unreadableName('מוכרטו');
    const t = checkExtraction(a, b, settings);
    expect(batchNameCandidates(a, b, t, ['מוברטו', 'דוד'])).toEqual(['מוברטו']);
    expect(batchNameCandidates(a, b, t, ['מוברטו'], ['מוברטו'])).toEqual([]); // already listed
    const clear = checkExtraction(pass(), pass(), settings);
    expect(batchNameCandidates(pass(), pass(), clear, ['דוד'])).toEqual([]);
  });

  it('gives a corrected name no second look', () => {
    const a = pass(
      { firstName: null },
      {
        unreadable: ['firstName'],
        suggestions: { firstName: 'מוברטו' },
        overwritten: ['firstName'],
      },
    );
    const t = checkExtraction(a, a, settings);
    expect(batchNameCandidates(a, a, t, ['מוברטו'])).toEqual([]);
  });

  it('takes the name from the second look only when its passes settled it from the list', () => {
    const first = checkExtraction(
      pass(
        { firstName: null, endTime: '18:30' },
        { unreadable: ['firstName'], suggestions: { firstName: 'מוברטו' } },
      ),
      pass({ firstName: null }, { unreadable: ['firstName'] }),
      settings,
    );
    const lists = { knownNames: ['מוברטו'] };
    const settled = checkExtraction(
      unreadableName('מוברטו', 'מוברטו'),
      unreadableName('מוברטו', 'מוברטו'),
      settings,
      lists,
    );
    const merged = withRetriedName(first, settled);
    expect(merged.fields.firstName).toBe('מוברטו');
    expect(merged.suggestions.firstName).toBeUndefined();
    // The first reading's other problems stay.
    const others = codes(first.flags).filter((c) => !c.endsWith(':firstName'));
    expect(others.length).toBeGreaterThan(0);
    expect(codes(merged.flags)).toEqual(others);

    const unsettled = checkExtraction(
      unreadableName('מוברטו', 'מוברטו'),
      unreadableName(null),
      settings,
      lists,
    );
    expect(withRetriedName(first, unsettled)).toBe(first);
  });
});

describe('several problems on one ticket', () => {
  it('reports each one', () => {
    expect(check({ firstName: 'ד4וד', date: '31/02/26', endTime: '15:30' })).toEqual([
      'SCRIPT_UNEXPECTED:firstName',
      'DATE_INVALID:date',
      'TIME_MATH_MISMATCH:totalWorked',
    ]);
  });
});
