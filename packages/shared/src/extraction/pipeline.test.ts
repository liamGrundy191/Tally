import { describe, expect, it } from 'vitest';
import type { ExtractionResult, FieldKey, Flag, RawTicketValues } from '../rules/schemas.ts';
import { TEMPLATE_V1 } from '../templates/v1.ts';
import type { ExtractionInput, ExtractionPass, TicketExtractor } from './extractor.ts';
import { type BatchItem, readBatch } from './pipeline.ts';

const settings = { today: '2026-11-18', minShiftHours: 2, maxShiftHours: 16, maxDateAgeDays: 45 };
const good: RawTicketValues = {
  firstName: 'דוד',
  workplace: 'סופר פארם',
  date: '10/11/26',
  startTime: '08:00',
  endTime: '16:30',
  totalWorked: '08:30',
};

/** One pass's answer: every field clear, with optional unclear fields and list matches. */
function answer(
  values: Partial<RawTicketValues> = {},
  extra: {
    unsure?: Partial<Record<FieldKey, string | null>>;
    nameMatch?: string | null;
    voided?: boolean;
  } = {},
): ExtractionResult {
  const all = { ...good, ...values };
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
    nameMatch: extra.nameMatch ?? null,
  };
}

/** Answers from a script keyed "<ticket>:<pass>"; repeated calls take the next answer. */
class ScriptedExtractor implements TicketExtractor {
  readonly calls: string[] = [];
  readonly inputs: ExtractionInput[] = [];
  private readonly script: Record<string, (ExtractionResult | Error)[]>;
  constructor(script: Record<string, (ExtractionResult | Error)[]>) {
    this.script = script;
  }
  async extract(input: ExtractionInput, _t: unknown, pass: ExtractionPass) {
    const key = `${input.id}:${pass}`;
    this.calls.push(key);
    this.inputs.push(input);
    const queue = this.script[key] ?? [];
    const next = queue.length > 1 ? queue.shift()! : queue[0];
    if (next === undefined) throw new Error(`no scripted answer for ${key}`);
    if (next instanceof Error) throw next;
    return {
      result: next,
      model: 'scripted',
      promptVersion: 'test',
      usage: { inputTokens: 10, outputTokens: 1 },
    };
  }
}

const item = (id: string, imageFlags: Flag[] = []): BatchItem => ({
  input: { id, image: { data: Buffer.from(id), mediaType: 'image/jpeg' } },
  imageFlags,
});
const run = (x: ScriptedExtractor, items: BatchItem[], extra = {}) =>
  readBatch(items, { extractor: x, template: TEMPLATE_V1, settings, ...extra });

describe('reading a batch', () => {
  it('reads a clear ticket with two passes only', async () => {
    const x = new ScriptedExtractor({ 't1:A': [answer()], 't1:B': [answer()] });
    const [t] = await run(x, [item('t1')]);
    expect(x.calls).toEqual(['t1:A', 't1:B']);
    expect(t!.checked!.flags).toEqual([]);
    expect(t!.error).toBeNull();
  });

  it('asks pass C only when a field is unclear, and uses it for the suggestion', async () => {
    const x = new ScriptedExtractor({
      't1:A': [answer({}, { unsure: { endTime: '16:30' } })],
      't1:B': [answer({}, { unsure: { endTime: '18:30' } })],
      't1:C': [answer({ endTime: '16:30' })],
    });
    const [t] = await run(x, [item('t1')]);
    expect(x.calls).toEqual(['t1:A', 't1:B', 't1:C']);
    expect(t!.checked!.suggestions.endTime).toBe('16:30');
    expect(t!.checked!.flags.map((f) => f.code)).toContain('FIELD_UNREADABLE');
  });

  it('asks pass C about a total accepted from the times, and flags it if C reads another (D30)', async () => {
    const unsureTotal = answer({}, { unsure: { totalWorked: '08:30' } });
    const x = new ScriptedExtractor({
      't1:A': [unsureTotal],
      't1:B': [unsureTotal],
      't1:C': [answer({ totalWorked: '06:30' })],
    });
    const [t] = await run(x, [item('t1')]);
    expect(x.calls).toEqual(['t1:A', 't1:B', 't1:C']);
    expect(t!.checked!.totalFromMath).toBe(false);
    expect(t!.checked!.flags.map((f) => f.code)).toContain('FIELD_UNREADABLE');
  });

  it('keeps the two-pass result when pass C fails', async () => {
    const x = new ScriptedExtractor({
      't1:A': [answer({}, { unsure: { endTime: '16:30' } })],
      't1:B': [answer()],
      't1:C': [new Error('network')],
    });
    const [t] = await run(x, [item('t1')]);
    expect(t!.error).toBeNull();
    expect(t!.checked!.flags.map((f) => `${f.code}:${f.field}`)).toEqual([
      'FIELD_UNREADABLE:endTime',
    ]);
  });

  it('counts the cost of a failed answer (a cut-off answer is still billed)', async () => {
    const cutOff = Object.assign(new Error('The answer was cut off.'), {
      usage: { inputTokens: 5000, outputTokens: 16000 },
    });
    const x = new ScriptedExtractor({ 't1:A': [cutOff], 't1:B': [answer()] });
    const seen: number[] = [];
    const [t] = await run(x, [item('t1')], {
      onRead: (_p: string, u: { outputTokens: number }) => seen.push(u.outputTokens),
    });
    expect(t!.checked).toBeNull();
    expect(seen.sort()).toEqual([1, 16000]);
  });

  it('records a failed reading without stopping the other tickets', async () => {
    const x = new ScriptedExtractor({
      't1:A': [new Error('Connection error')],
      't2:A': [answer()],
      't2:B': [answer()],
    });
    const [t1, t2] = await run(x, [item('t1'), item('t2')]);
    expect(t1!.checked).toBeNull();
    expect(t1!.error).toMatch(/Connection error/);
    expect(t2!.checked!.flags).toEqual([]);
  });

  it('stops the whole batch when the API key is refused', async () => {
    const refused = Object.assign(new Error('401'), { status: 401 });
    const x = new ScriptedExtractor({ 't1:A': [refused] });
    await expect(run(x, [item('t1')])).rejects.toThrow('401');
  });

  it('adds the image flags to the ticket', async () => {
    const x = new ScriptedExtractor({ 't1:A': [answer()], 't1:B': [answer()] });
    const [t] = await run(x, [item('t1', [{ code: 'IMAGE_BLURRY' }])]);
    expect(t!.checked!.flags).toEqual([{ code: 'IMAGE_BLURRY' }]);
  });

  it('stops spending when told to, and marks the tickets it did not read', async () => {
    const x = new ScriptedExtractor({ 't1:A': [answer()], 't1:B': [answer()] });
    let budget = 1;
    const [t1, t2] = await run(x, [item('t1'), item('t2')], {
      concurrency: 1,
      canSpend: () => budget-- > 0,
    });
    expect(t1!.checked).not.toBeNull();
    expect(t2!.error).toMatch(/spending cap/);
    expect(x.calls).toEqual(['t1:A', 't1:B']);
  });

  it('passes the lists to every read', async () => {
    const x = new ScriptedExtractor({ 't1:A': [answer()], 't1:B': [answer()] });
    await run(x, [item('t1')], { knownWorkplaces: ['סופר פארם'], knownNames: ['דוד'] });
    for (const input of x.inputs) {
      expect(input.knownWorkplaces).toEqual(['סופר פארם']);
      expect(input.knownNames).toEqual(['דוד']);
    }
  });
});

describe('names from the same batch (D28)', () => {
  const unclearName = (guess: string, match: string | null = null) =>
    answer({}, { unsure: { firstName: guess }, nameMatch: match });

  it('reads an unclear name again with a clear name from another ticket, and takes only the name', async () => {
    // The first reading is also unsure of the end time; the second look reads it clearly, but
    // only its name may be used, so the end time must stay flagged.
    const first = (guess: string) => answer({}, { unsure: { firstName: guess, endTime: '16:30' } });
    const x = new ScriptedExtractor({
      'clear:A': [answer({ firstName: 'מוברטו' })],
      'clear:B': [answer({ firstName: 'מוברטו' })],
      'unclear:A': [first('מוברטו'), unclearName('מוברטו', 'מוברטו')],
      'unclear:B': [first('מוכרטו'), unclearName('מוברטו', 'מוברטו')],
      'unclear:C': [first('מוברטו')],
    });
    const [, t] = await run(x, [item('clear'), item('unclear')], { concurrency: 1 });
    expect(t!.secondLook).toEqual({ candidates: ['מוברטו'], settled: true });
    expect(t!.checked!.fields.firstName).toBe('מוברטו');
    expect(t!.checked!.flags.map((f) => `${f.code}:${f.field}`)).toEqual([
      'FIELD_UNREADABLE:endTime',
    ]);
    const secondLook = x.inputs.filter((i) => i.id === 'unclear').at(-1)!;
    expect(secondLook.knownNames).toEqual(['מוברטו']);
  });

  it('keeps the first reading when the second look does not settle the name', async () => {
    const x = new ScriptedExtractor({
      'clear:A': [answer({ firstName: 'מוברטו' })],
      'clear:B': [answer({ firstName: 'מוברטו' })],
      'unclear:A': [unclearName('מוברטו'), unclearName('מוברטו', 'מוברטו')],
      'unclear:B': [unclearName('מוכרטו'), unclearName('מוכרטו', null)],
      'unclear:C': [unclearName('מוברטו')],
    });
    const [, t] = await run(x, [item('clear'), item('unclear')], { concurrency: 1 });
    expect(t!.secondLook).toEqual({ candidates: ['מוברטו'], settled: false });
    expect(t!.checked!.fields.firstName).toBeNull();
    expect(t!.checked!.suggestions.firstName).toBe('מוברטו');
  });

  it('never uses a name from a crossed-out ticket', async () => {
    const x = new ScriptedExtractor({
      'void:A': [answer({ firstName: 'מוברטו' }, { voided: true })],
      'void:B': [answer({ firstName: 'מוברטו' }, { voided: true })],
      'unclear:A': [unclearName('מוברטו')],
      'unclear:B': [unclearName('מוכרטו')],
      'unclear:C': [unclearName('מוברטו')],
    });
    const [, t] = await run(x, [item('void'), item('unclear')], { concurrency: 1 });
    expect(t!.secondLook).toBeNull();
    expect(x.calls.filter((c) => c === 'unclear:A')).toHaveLength(1);
  });
});
