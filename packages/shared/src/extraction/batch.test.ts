// Batch mode with a stand-in client: no network, no cost.
import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import type { ExtractionResult, FieldKey, RawTicketValues } from '../rules/schemas.ts';
import { TEMPLATE_V1 } from '../templates/v1.ts';
import { AnthropicBatchExtractor } from './batch.ts';
import { type ExtractionInput, type ExtractionPass, loadPrompt } from './extractor.ts';
import { readBatch } from './pipeline.ts';

const settings = { today: '2026-11-18', minShiftHours: 2, maxShiftHours: 16, maxDateAgeDays: 45 };
const good: RawTicketValues = {
  firstName: 'דוד',
  workplace: 'סופר פארם',
  date: '10/11/26',
  startTime: '08:00',
  endTime: '16:30',
  totalWorked: '08:30',
};
const answer = (unsure: FieldKey[] = [], nameMatch: string | null = null): ExtractionResult => ({
  fields: Object.fromEntries(
    Object.entries(good).map(([k, v]) =>
      unsure.includes(k as FieldKey)
        ? [k, { value: null, legible: false, suggestion: v }]
        : [k, { value: v, legible: true, suggestion: null }],
    ),
  ) as ExtractionResult['fields'],
  voided: false,
  overwrittenFields: [],
  workplaceMatch: null,
  nameMatch,
});
const input = (id: string, extra: Partial<ExtractionInput> = {}): ExtractionInput => ({
  id,
  image: { data: Buffer.from(id), mediaType: 'image/jpeg' },
  ...extra,
});

type Params = ReturnType<typeof import('./extractor.ts').buildRequest>;
/** Which ticket and pass a request is for, read back from what would be sent. */
function whoIs(params: Params): { ticket: string; pass: ExtractionPass } {
  const content = params.messages[0]!.content as Anthropic.ContentBlockParam[];
  const image = content.find((b) => b.type === 'image') as Anthropic.ImageBlockParam;
  const ticket = Buffer.from((image.source as { data: string }).data, 'base64').toString();
  const pass = (['A', 'B', 'C'] as const).find((p) => loadPrompt(p) === params.system)!;
  return { ticket, pass };
}

type Reply =
  | { type: 'answer'; json: unknown; stop?: Anthropic.Message['stop_reason'] }
  | { type: 'text'; text: string }
  | { type: 'errored' }
  | { type: 'expired' };

/** A stand-in batches API: answers each request with `reply`, results in reverse order. */
function stubClient(reply: (who: { ticket: string; pass: ExtractionPass }) => Reply) {
  const created: { custom_id: string; params: Params }[][] = [];
  const cancelled: string[] = [];
  let polls = 0;
  const client = {
    messages: {
      batches: {
        create: async ({ requests }: { requests: { custom_id: string; params: Params }[] }) => {
          created.push(requests);
          return { id: `batch${created.length}`, processing_status: 'in_progress' };
        },
        retrieve: async (id: string) => {
          polls++;
          const n = created[Number(id.slice(5)) - 1]!.length;
          return {
            id,
            processing_status: polls % 2 === 0 ? 'ended' : 'in_progress',
            request_counts: { succeeded: n, errored: 0, canceled: 0, expired: 0, processing: 0 },
          };
        },
        results: async (id: string) => {
          const requests = created[Number(id.slice(5)) - 1]!;
          return (async function* () {
            for (const r of [...requests].reverse()) {
              const rep = reply(whoIs(r.params));
              if (rep.type === 'errored' || rep.type === 'expired') {
                yield { custom_id: r.custom_id, result: { type: rep.type } };
                continue;
              }
              const text = rep.type === 'answer' ? JSON.stringify(rep.json) : rep.text;
              yield {
                custom_id: r.custom_id,
                result: {
                  type: 'succeeded',
                  message: {
                    model: 'claude-opus-5-5',
                    stop_reason: rep.type === 'answer' ? (rep.stop ?? 'end_turn') : 'end_turn',
                    usage: { input_tokens: 1000, output_tokens: 100 },
                    content: [{ type: 'text', text }],
                  },
                },
              };
            }
          })();
        },
        cancel: async (id: string) => {
          cancelled.push(id);
          return { id, processing_status: 'canceling' };
        },
      },
    },
  } as unknown as Anthropic;
  return { client, created, cancelled };
}
const fast = { model: 'claude-opus-5-5', pollMs: 0, gatherMs: 5 };

describe('batch mode', () => {
  it('sends requests made together as one batch and matches each result to its request', async () => {
    const stub = stubClient(({ ticket }) => ({
      type: 'answer',
      json: {
        ...answer(),
        nameMatch: null,
        fields: {
          ...answer().fields,
          firstName: { value: ticket, legible: true, suggestion: null },
        },
      },
    }));
    const x = new AnthropicBatchExtractor({ ...fast, client: stub.client });
    const [a, b] = await Promise.all([
      x.extract(input('t1'), TEMPLATE_V1, 'A'),
      x.extract(input('t2'), TEMPLATE_V1, 'B'),
    ]);
    expect(stub.created).toHaveLength(1);
    expect(stub.created[0]!.map((r) => r.custom_id)).toEqual(['r1', 'r2']);
    // Results came back in reverse order, but each reaches the ticket that asked.
    expect(a.result.fields.firstName.value).toBe('t1');
    expect(b.result.fields.firstName.value).toBe('t2');
    expect(a.usage).toEqual({ inputTokens: 1000, outputTokens: 100 });
  });

  it('sends the same request as immediate mode, with the answer format but no code', async () => {
    const stub = stubClient(() => ({ type: 'answer', json: answer() }));
    const x = new AnthropicBatchExtractor({ ...fast, client: stub.client });
    await x.extract(input('t1', { knownNames: ['דוד'] }), TEMPLATE_V1, 'A');
    const sent = JSON.parse(JSON.stringify(stub.created[0]![0]!.params));
    expect(sent).toMatchObject({
      model: 'claude-opus-5-5',
      system: loadPrompt('A'),
      output_config: { format: { type: 'json_schema' } },
    });
    expect(JSON.stringify(sent)).toContain('- דוד');
  });

  it('sends the chosen effort', async () => {
    const stub = stubClient(() => ({ type: 'answer', json: answer() }));
    const x = new AnthropicBatchExtractor({ ...fast, client: stub.client, effort: 'high' });
    await x.extract(input('t1'), TEMPLATE_V1, 'A');
    expect(stub.created[0]![0]!.params.output_config.effort).toBe('high');
  });

  it('treats an errored, expired, refused, cut-off or malformed answer as a failed attempt', async () => {
    const cases: Record<string, Reply> = {
      e: { type: 'errored' },
      x: { type: 'expired' },
      r: { type: 'answer', json: answer(), stop: 'refusal' },
      c: { type: 'answer', json: answer(), stop: 'max_tokens' },
      t: { type: 'text', text: 'not json' },
      n: { type: 'answer', json: { ...answer(), nameMatch: 'נועה' } }, // not on the list
    };
    const stub = stubClient(({ ticket }) => cases[ticket]!);
    const x = new AnthropicBatchExtractor({ ...fast, client: stub.client });
    const results = await Promise.allSettled(
      Object.keys(cases).map((id) =>
        x.extract(input(id, { knownNames: ['דוד'] }), TEMPLATE_V1, 'A'),
      ),
    );
    expect(stub.created).toHaveLength(1);
    const reasons = results.map((r) =>
      r.status === 'rejected' ? (r.reason as { name: string; reason: string }) : null,
    );
    expect(reasons.map((r) => r?.name)).toEqual(Array(6).fill('ExtractionError'));
    // Every answer that came back was billed, so even the failures report their tokens.
    const billed = results.map((r) =>
      r.status === 'rejected' ? (r.reason as { usage?: unknown }).usage : null,
    );
    expect(billed).toEqual([
      undefined,
      undefined,
      ...Array(4).fill({ inputTokens: 1000, outputTokens: 100 }),
    ]);
    expect(reasons.map((r) => r?.reason)).toEqual([
      'invalid_output',
      'invalid_output',
      'refusal',
      'truncated',
      'invalid_output',
      'invalid_output',
    ]);
  });

  it('fails a request whose result never came back, instead of waiting forever', async () => {
    const stub = stubClient(() => ({ type: 'answer', json: answer() }));
    const results = stub.client.messages.batches.results.bind(stub.client.messages.batches);
    stub.client.messages.batches.results = (async (id: string) => {
      const all = await results(id);
      return (async function* () {
        for await (const r of all) if (r.custom_id !== 'r1') yield r; // r1 goes missing
      })();
    }) as never;
    const x = new AnthropicBatchExtractor({ ...fast, client: stub.client });
    const [lost, ok] = await Promise.allSettled([
      x.extract(input('t1'), TEMPLATE_V1, 'A'),
      x.extract(input('t2'), TEMPLATE_V1, 'A'),
    ]);
    expect(lost).toMatchObject({ status: 'rejected', reason: { name: 'ExtractionError' } });
    expect(ok.status).toBe('fulfilled');
  });

  it('passes a refused API key on to every waiting request', async () => {
    const stub = stubClient(() => ({ type: 'answer', json: answer() }));
    stub.client.messages.batches.create = (async () => {
      throw Object.assign(new Error('invalid x-api-key'), { status: 401 });
    }) as never;
    const x = new AnthropicBatchExtractor({ ...fast, client: stub.client });
    await expect(x.extract(input('t1'), TEMPLATE_V1, 'A')).rejects.toMatchObject({ status: 401 });
  });

  it('can cancel a batch that is still running', async () => {
    const stub = stubClient(() => ({ type: 'answer', json: answer() }));
    const x = new AnthropicBatchExtractor({
      model: 'm',
      client: stub.client,
      pollMs: 60_000,
      gatherMs: 0,
    });
    void x.extract(input('t1'), TEMPLATE_V1, 'A').catch(() => {});
    await new Promise((r) => setTimeout(r, 20));
    await x.cancelAll();
    expect(stub.cancelled).toEqual(['batch1']);
  });
});

describe('the reading process in batch mode', () => {
  it('reads a whole round as one batch: passes A and B, then pass C for unclear tickets', async () => {
    const stub = stubClient(({ ticket, pass }) => ({
      type: 'answer',
      json: ticket === 'unclear' && pass !== 'C' ? answer(['endTime']) : answer(),
    }));
    const x = new AnthropicBatchExtractor({ ...fast, client: stub.client });
    const items = ['clear', 'unclear', 'clear2'].map((id) => ({
      input: input(id),
      imageFlags: [],
    }));
    const reads = await readBatch(items, {
      extractor: x,
      template: TEMPLATE_V1,
      settings,
      concurrency: items.length,
    });
    expect(stub.created.map((b) => b.length)).toEqual([6, 1]);
    expect(stub.created[1]!.map((r) => whoIs(r.params))).toEqual([
      { ticket: 'unclear', pass: 'C' },
    ]);
    expect(reads.map((t) => t.checked!.flags.map((f) => `${f.code}:${f.field}`))).toEqual([
      [],
      ['FIELD_UNREADABLE:endTime'],
      [],
    ]);
    expect(reads[1]!.checked!.suggestions.endTime).toBe('16:30');
  });
});
