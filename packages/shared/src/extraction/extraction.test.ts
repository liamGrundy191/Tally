import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { checkExtraction } from '../rules/ticket.ts';
import { TEMPLATE_V1 } from '../templates/v1.ts';
import {
  AnthropicExtractor,
  ExtractionError,
  type ExtractionInput,
  FakeExtractor,
  PROMPT_VERSION,
  validateAnswer,
  answerFormat,
  buildRequest,
  loadPrompt,
  withCache,
} from './index.ts';

const FIXTURES = new URL('../../../../fixtures/extractions/', import.meta.url);
const image = { data: Buffer.from('fake image bytes'), mediaType: 'image/jpeg' as const };
const input = (id: string, extra: Partial<ExtractionInput> = {}): ExtractionInput => ({
  id,
  image,
  ...extra,
});
const settings = { today: '2026-11-18', minShiftHours: 2, maxShiftHours: 16, maxDateAgeDays: 45 };

describe('FakeExtractor (reads prepared answers; tests never call the real API)', () => {
  const fake = new FakeExtractor(FIXTURES);

  it('returns the prepared answer for each pass', async () => {
    const a = await fake.extract(input('clean'), TEMPLATE_V1, 'A');
    const b = await fake.extract(input('clean'), TEMPLATE_V1, 'B');
    expect(a.result.fields.workplace.value).toBe('סופר פארם');
    expect(b.result.fields.workplace.value).toBe('סופר-פארם');
    expect(a.model).toBe('fake');
    expect(a.promptVersion).toBe(PROMPT_VERSION);
  });

  it('treats an answer in the wrong format as a failed attempt', async () => {
    await expect(fake.extract(input('broken'), TEMPLATE_V1, 'A')).rejects.toMatchObject({
      name: 'ExtractionError',
      reason: 'invalid_output',
    });
  });

  it('says clearly which prepared answer is missing', async () => {
    await expect(fake.extract(input('no-such-ticket'), TEMPLATE_V1, 'A')).rejects.toThrow(
      /no-such-ticket\.pass-a\.json/,
    );
  });
});

describe('prepared answers through the T0.3 checks', () => {
  const fake = new FakeExtractor(FIXTURES);
  const run = async (id: string) =>
    checkExtraction(
      (await fake.extract(input(id), TEMPLATE_V1, 'A')).result,
      (await fake.extract(input(id), TEMPLATE_V1, 'B')).result,
      settings,
    ).flags.map((f) => (f.field ? `${f.code}:${f.field}` : f.code));

  it('a clean ticket read the same way twice raises no flags', async () => {
    expect(await run('clean')).toEqual([]);
  });

  it('a disputed ticket is flagged for each problem', async () => {
    expect(await run('disputed')).toEqual([
      'FIELD_UNREADABLE:endTime',
      'PASS_DISAGREEMENT:totalWorked',
      'CORRECTION_MARKS:totalWorked',
      // Pass A's readings are kept for the reviewer; 22:00 → 06:00 is 8:00, not 08:30.
      'TIME_MATH_MISMATCH:totalWorked',
    ]);
  });

  it('a crossed-out ticket is flagged', async () => {
    expect(await run('voided')).toEqual(['VOIDED_TICKET']);
  });
});

describe('the two prompts', () => {
  it.each(['A', 'B', 'C'] as const)('pass %s tells the model the essentials', (pass) => {
    const prompt = loadPrompt(pass);
    expect(prompt).toContain('"legible": false'); // unreadable instead of guessing
    expect(prompt).toContain('`voided`'); // crossed-out tickets
    expect(prompt).toContain('`overwrittenFields`'); // overwritten characters
    expect(prompt).toMatch(/instruction/i); // handwriting is data, not instructions
    expect(prompt).toContain('דנה'); // the printed example is not a value
    expect(prompt).toContain('`suggestion`'); // best guess for unclear boxes, never the value
    expect(prompt).toContain('`workplaceMatch`'); // only an exact list entry, or null
    expect(prompt).toContain('`nameMatch`'); // the same for names
  });

  it('are worded differently, so the readings are independent', () => {
    expect(new Set([loadPrompt('A'), loadPrompt('B'), loadPrompt('C')]).size).toBe(3);
  });
});

describe('the request sent to the model', () => {
  it('pass A sends the field list, then the whole ticket', () => {
    const req = buildRequest(input('t1'), TEMPLATE_V1, 'A', 'claude-opus-5-5');
    expect(req.model).toBe('claude-opus-5-5');
    expect(req.system).toBe(loadPrompt('A'));
    const [first, second] = req.messages[0]!.content as Anthropic.ContentBlockParam[];
    expect(first).toMatchObject({ type: 'text' });
    const text = (first as Anthropic.TextBlockParam).text;
    for (const f of TEMPLATE_V1.fields) {
      expect(text).toContain(f.key);
      expect(text).toContain(f.labelHe);
    }
    expect(second).toMatchObject({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg' },
    });
    // Text after the image, as Anthropic advises (D65).
    expect((req.messages[0]!.content as Anthropic.ContentBlockParam[])[2]).toEqual({
      type: 'text',
      text: 'The ticket to read is the image above.',
    });
  });

  it('pass B with field crops sends the field list, the whole ticket, then one labelled image per field', () => {
    const crops = Object.fromEntries(TEMPLATE_V1.fields.map((f) => [f.key, image]));
    const req = buildRequest(input('t1', { crops }), TEMPLATE_V1, 'B', 'claude-opus-5-5');
    expect(req.system).toBe(loadPrompt('B'));
    const content = req.messages[0]!.content as Anthropic.ContentBlockParam[];
    expect(content.filter((b) => b.type === 'image')).toHaveLength(TEMPLATE_V1.fields.length + 1);
    expect((content[0] as Anthropic.TextBlockParam).text).toContain('Fields:');
    expect(content[1]).toMatchObject({ type: 'text', text: 'The whole ticket:' });
    expect(content[2]).toMatchObject({ type: 'image' }); // the whole ticket comes first
    TEMPLATE_V1.fields.forEach((f, i) => {
      expect(content[3 + i * 2]).toMatchObject({ type: 'text' });
      expect((content[3 + i * 2] as Anthropic.TextBlockParam).text).toContain(f.key);
      expect(content[4 + i * 2]).toMatchObject({ type: 'image' });
    });
    expect(content.at(-1)).toMatchObject({
      type: 'text',
      text: 'After the whole ticket, each image is one field cut out of it and enlarged.',
    });
  });

  describe('caching (D65): the same start for every ticket, the ticket after it', () => {
    const lists = { knownWorkplaces: ['Place A', 'מקום ב'], knownNames: ['Dana', 'יעל'] };
    const ticket = (id: string, seed: string) => {
      const img = { data: Buffer.from(seed), mediaType: 'image/jpeg' as const };
      const crops = Object.fromEntries(TEMPLATE_V1.fields.map((f) => [f.key, img]));
      return input(id, { image: img, crops, ...lists });
    };
    const first = (req: ReturnType<typeof buildRequest>) =>
      (req.messages[0]!.content as Anthropic.ContentBlockParam[])[0]!;

    for (const pass of ['A', 'B', 'C'] as const) {
      it(`pass ${pass}: two tickets share everything up to the cache mark, and no image is before it`, () => {
        const one = buildRequest(ticket('t1', 'one'), TEMPLATE_V1, pass, 'm', 'high', '1h');
        const two = buildRequest(ticket('t2', 'two'), TEMPLATE_V1, pass, 'm', 'high', '1h');
        expect(one.system).toBe(two.system);
        expect(first(one)).toEqual(first(two));
        expect(first(one)).toMatchObject({
          type: 'text',
          cache_control: { type: 'ephemeral', ttl: '1h' },
        });
        expect(JSON.stringify(one.output_config)).toBe(JSON.stringify(two.output_config));
        // The ticket's own images all come after the cached start.
        const rest = (one.messages[0]!.content as Anthropic.ContentBlockParam[]).slice(1);
        expect(rest.some((b) => b.type === 'image')).toBe(true);
        expect(rest.some((b) => 'cache_control' in b)).toBe(false);
      });
    }

    it('marks nothing unless asked, and the 5-minute cache has no ttl', () => {
      expect(first(buildRequest(ticket('t', 's'), TEMPLATE_V1, 'A', 'm'))).not.toHaveProperty(
        'cache_control',
      );
      expect(
        first(buildRequest(ticket('t', 's'), TEMPLATE_V1, 'A', 'm', 'high', '5m')),
      ).toMatchObject({ cache_control: { type: 'ephemeral' } });
      expect(
        first(buildRequest(ticket('t', 's'), TEMPLATE_V1, 'A', 'm', 'high', '5m')),
      ).not.toHaveProperty('cache_control.ttl');
    });

    it('withCache marks a request built without it, as if asked', () => {
      const plain = buildRequest(ticket('t', 's'), TEMPLATE_V1, 'B', 'm');
      expect(JSON.stringify(withCache(plain, '1h'))).toBe(
        JSON.stringify(buildRequest(ticket('t', 's'), TEMPLATE_V1, 'B', 'm', 'high', '1h')),
      );
      expect(first(plain)).not.toHaveProperty('cache_control'); // the original is unchanged
    });
  });

  it('pass B without crops sends the whole ticket', () => {
    const req = buildRequest(input('t1'), TEMPLATE_V1, 'B', 'claude-opus-5-5');
    const content = req.messages[0]!.content as Anthropic.ContentBlockParam[];
    expect(content.filter((b) => b.type === 'image')).toHaveLength(1);
  });

  it('pass C has its own wording and reads the whole ticket', () => {
    const crops = Object.fromEntries(TEMPLATE_V1.fields.map((f) => [f.key, image]));
    const req = buildRequest(input('t1', { crops }), TEMPLATE_V1, 'C', 'claude-opus-5-5');
    expect(req.system).toBe(loadPrompt('C'));
    const content = req.messages[0]!.content as Anthropic.ContentBlockParam[];
    expect(content.filter((b) => b.type === 'image')).toHaveLength(1);
  });

  it('pass A ignores crops and always sends the whole ticket', () => {
    const crops = { firstName: image };
    const req = buildRequest(input('t1', { crops }), TEMPLATE_V1, 'A', 'claude-opus-5-5');
    const content = req.messages[0]!.content as Anthropic.ContentBlockParam[];
    expect(content.filter((b) => b.type === 'image')).toHaveLength(1);
  });

  it('asks for high effort unless told otherwise', () => {
    expect(buildRequest(input('t1'), TEMPLATE_V1, 'A', 'm').output_config.effort).toBe('high');
    expect(buildRequest(input('t1'), TEMPLATE_V1, 'A', 'm', 'medium').output_config.effort).toBe(
      'medium',
    );
  });

  it('forces the answer format: every object closed and every property required', () => {
    const walk = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      const n = node as Record<string, unknown>;
      if (n.type === 'object') {
        expect(n.additionalProperties).toBe(false);
        expect(Object.keys(n.properties as object).sort()).toEqual(
          [...(n.required as string[])].sort(),
        );
      }
      Object.values(n).forEach(walk);
    };
    walk(answerFormat().schema);
  });
});

describe('the workplace list', () => {
  const list = ['משק ברזלי', 'הסנה הבוער'];
  const answer = (match: string | null) => ({
    fields: Object.fromEntries(
      TEMPLATE_V1.fields.map((f) => [f.key, { value: null, legible: false, suggestion: null }]),
    ),
    voided: false,
    overwrittenFields: [],
    workplaceMatch: match,
    nameMatch: null,
  });

  it('is sent with the request, one entry per line', () => {
    const req = buildRequest(input('t1', { knownWorkplaces: list }), TEMPLATE_V1, 'A', 'm');
    const text = (req.messages[0]!.content as Anthropic.ContentBlockParam[]).find(
      (b) => b.type === 'text',
    ) as Anthropic.TextBlockParam;
    expect(text.text).toContain(['- משק ברזלי', '- הסנה הבוער'].join(String.fromCharCode(10)));
  });

  it('limits the answer format to the list entries or null', () => {
    const schema = JSON.stringify(answerFormat({ workplaces: list }).schema);
    expect(schema).toContain('"enum":["משק ברזלי","הסנה הבוער"]');
  });

  it('accepts an exact list entry or null', () => {
    expect(validateAnswer(answer('משק ברזלי'), { workplaces: list }).workplaceMatch).toBe(
      'משק ברזלי',
    );
    expect(validateAnswer(answer(null), { workplaces: list }).workplaceMatch).toBeNull();
  });

  it('rejects a workplace match that is not on the list (a failed attempt)', () => {
    expect(() => validateAnswer(answer('משק ברזל'), { workplaces: list })).toThrow(ExtractionError);
  });

  it('names the broken part of an answer without repeating the lists', () => {
    expect(() => validateAnswer(answer('משק ברזל'), { workplaces: list })).toThrow(
      /^Answer does not match the format at: workplaceMatch$/,
    );
  });

  it('sends the names list too, and limits nameMatch to it', () => {
    const req = buildRequest(
      input('t1', { knownNames: ['זהריה', 'מוברטו'] }),
      TEMPLATE_V1,
      'A',
      'm',
    );
    const text = (req.messages[0]!.content as Anthropic.ContentBlockParam[]).find(
      (b) => b.type === 'text',
    ) as Anthropic.TextBlockParam;
    expect(text.text).toContain(['- זהריה', '- מוברטו'].join(String.fromCharCode(10)));
    expect(text.text).toContain('workplaceMatch must be null');
    const named = { ...answer(null), nameMatch: 'זהריה' };
    expect(validateAnswer(named, { names: ['זהריה'] }).nameMatch).toBe('זהריה');
    expect(() => validateAnswer(named, { workplaces: list })).toThrow(ExtractionError);
  });

  it('rejects any workplace match when no list was given', () => {
    expect(() => validateAnswer(answer('משק ברזלי'))).toThrow(ExtractionError);
  });
});

/** A stand-in for the Anthropic client that returns a canned response. */
function clientReturning(response: Partial<Anthropic.Message> & { parsed_output?: unknown }) {
  const calls: unknown[] = [];
  const client = {
    messages: {
      parse: async (params: unknown) => {
        calls.push(params);
        return {
          model: 'claude-opus-5-5',
          stop_reason: 'end_turn',
          usage: { input_tokens: 1800, output_tokens: 400 },
          ...response,
        };
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}

describe('AnthropicExtractor (with a stand-in client, no network)', () => {
  const good = {
    fields: Object.fromEntries(
      TEMPLATE_V1.fields.map((f) => [f.key, { value: null, legible: true, suggestion: null }]),
    ),
    voided: false,
    overwrittenFields: [],
    workplaceMatch: null,
    nameMatch: null,
  };

  it('returns the validated answer, the model that answered, and token usage', async () => {
    const { client, calls } = clientReturning({ parsed_output: good });
    const out = await new AnthropicExtractor({ model: 'claude-opus-5-5', client }).extract(
      input('t1'),
      TEMPLATE_V1,
      'A',
    );
    expect(out.result).toEqual(good);
    expect(out.model).toBe('claude-opus-5-5');
    expect(out.usage).toEqual({
      inputTokens: 1800,
      outputTokens: 400,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    // Immediate readings follow each other: the shared start is kept for 5 minutes (D65).
    const sent = calls[0] as { messages: { content: Anthropic.TextBlockParam[] }[] };
    expect(sent.messages[0]!.content[0]!.cache_control).toEqual({ type: 'ephemeral' });
    expect(calls[0]).toMatchObject({
      model: 'claude-opus-5-5',
      output_config: { effort: 'high', format: { type: 'json_schema' } },
    });
  });

  it('sends the chosen effort', async () => {
    const { client, calls } = clientReturning({ parsed_output: good });
    await new AnthropicExtractor({ model: 'm', client, effort: 'xhigh' }).extract(
      input('t1'),
      TEMPLATE_V1,
      'A',
    );
    expect(calls[0]).toMatchObject({ output_config: { effort: 'xhigh' } });
  });

  it.each([
    ['a refusal', { stop_reason: 'refusal' as const, parsed_output: null }, 'refusal'],
    ['a cut-off answer', { stop_reason: 'max_tokens' as const, parsed_output: null }, 'truncated'],
    ['an answer that does not parse', { parsed_output: null }, 'invalid_output'],
    ['an answer missing a field', { parsed_output: { voided: false } }, 'invalid_output'],
  ])('treats %s as a failed attempt', async (_case, response, reason) => {
    const { client } = clientReturning(response);
    await expect(
      new AnthropicExtractor({ model: 'm', client }).extract(input('t1'), TEMPLATE_V1, 'A'),
    ).rejects.toMatchObject({ name: 'ExtractionError', reason });
  });

  it('treats an error while parsing the answer as a failed attempt', async () => {
    const client = {
      messages: {
        parse: async () => {
          throw new SyntaxError('Unexpected token');
        },
      },
    } as unknown as Anthropic;
    await expect(
      new AnthropicExtractor({ model: 'm', client }).extract(input('t1'), TEMPLATE_V1, 'A'),
    ).rejects.toBeInstanceOf(ExtractionError);
  });
});
