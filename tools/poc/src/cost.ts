// shortcut: prices hard-coded for estimates only; update from anthropic.com/pricing.
export const PRICE_PER_MILLION: Record<string, [input: number, output: number]> = {
  'claude-opus-5-5': [4, 20],
  'claude-sonnet-5-5': [2, 10],
  'claude-haiku-5-5': [0.1, 0.5],
};

/** Measured on Liam's test tickets with all three reads (PROGRESSION section 10). */
const MEASURED = { model: 'claude-opus-5-5', usdPerTicket: 0.15 } as const;

/** A cache read's share of the input price (D65): 5% on Opus and Sonnet 5.5, 10% on others. */
const CACHE_READ: Record<string, number> = { 'claude-opus-5-5': 0.05, 'claude-sonnet-5-5': 0.05 };
// shortcut: every cache write is priced as the 1-hour one (2x) that batches use; the 5-minute
// write of immediate mode is 1.25x, so immediate runs are over-estimated a little.
const CACHE_WRITE = 2;

export const costUsd = (
  model: string,
  inputTokens: number,
  outputTokens: number,
  cache: { read: number; write: number } = { read: 0, write: 0 },
) => {
  const p = PRICE_PER_MILLION[model];
  if (!p) return null;
  const input = inputTokens + cache.read * (CACHE_READ[model] ?? 0.1) + cache.write * CACHE_WRITE;
  return (input * p[0] + outputTokens * p[1]) / 1e6;
};

/**
 * Estimated cost per ticket in immediate mode: the measured Opus cost, scaled by the model's price.
 * null for a model with no known price; the runner then refuses to spend, since it could not stop
 * itself in time.
 */
export function estimateUsdPerTicket(model: string): number | null {
  const p = PRICE_PER_MILLION[model];
  const base = PRICE_PER_MILLION[MEASURED.model]!;
  return p ? MEASURED.usdPerTicket * (p[0] / base[0]) : null;
}

/**
 * Cost factors for effort, relative to the measured medium. High was measured at about 1.1 on two
 * hard tickets (D35); the others are guesses. Max ran out of answer space on hard tickets and is
 * far more expensive; it stays a guess until anyone needs it.
 */
export const EFFORT_COST_GUESS: Record<string, number> = {
  low: 0.85,
  medium: 1,
  high: 1.15,
  xhigh: 2,
  max: 4,
};
