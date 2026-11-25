import { describe, expect, it } from 'vitest';
import { costUsd } from './cost.ts';

describe('the cost of a reading (D65)', () => {
  it('prices cache reads at 5% and cache writes at twice the input price on Opus 5.5', () => {
    // A million each: $4 input, $0.20 read from the cache, $8 written to it, $20 output.
    expect(costUsd('claude-opus-5-5', 1e6, 1e6, { read: 1e6, write: 1e6 })).toBeCloseTo(32.2);
    expect(costUsd('claude-opus-5-5', 1e6, 0)).toBe(4);
  });

  it('knows no price for an unknown model', () => {
    expect(costUsd('another-model', 1, 1)).toBeNull();
  });
});
