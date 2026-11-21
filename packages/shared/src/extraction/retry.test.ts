import { describe, expect, it } from 'vitest';
import type { ExtractionInput, ExtractionSuccess, TicketExtractor } from './extractor.ts';
import { withRetries } from './retry.ts';
import { TEMPLATE_V1 } from '../templates/v1.ts';

const input: ExtractionInput = {
  id: 't1',
  image: { data: Buffer.from(''), mediaType: 'image/jpeg' },
};
const ok = { model: 'm' } as ExtractionSuccess;

/** Fails with the given errors in turn, then succeeds. */
function failing(errors: unknown[]): TicketExtractor & { calls: number } {
  const x = {
    calls: 0,
    async extract() {
      const e = errors[x.calls++];
      if (e) throw e;
      return ok;
    },
  };
  return x;
}
const read = (x: TicketExtractor) => x.extract(input, TEMPLATE_V1, 'A');

describe('withRetries (section 10)', () => {
  it('tries again after a failure, and gives the answer', async () => {
    const x = failing([new Error('overloaded'), Object.assign(new Error('rate'), { status: 429 })]);
    expect(await read(withRetries(x, { firstWaitMs: 1 }))).toBe(ok);
    expect(x.calls).toBe(3);
  });

  it('stops after 5 attempts in all', async () => {
    const x = failing(Array.from({ length: 9 }, () => new Error('down')));
    await expect(read(withRetries(x, { firstWaitMs: 1 }))).rejects.toThrow('down');
    expect(x.calls).toBe(5);
  });

  it('does not retry a refused key, which fails the same way every time', async () => {
    const x = failing([Object.assign(new Error('bad key'), { status: 401 })]);
    await expect(read(withRetries(x, { firstWaitMs: 1 }))).rejects.toThrow('bad key');
    expect(x.calls).toBe(1);
  });
});
