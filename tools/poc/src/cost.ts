// shortcut: prices hard-coded for estimates only; update from anthropic.com/pricing.
export const PRICE_PER_MILLION: Record<string, [input: number, output: number]> = {
  'claude-opus-5-5': [4, 20],
  'claude-sonnet-5-5': [2, 10],
  'claude-haiku-5-5': [0.1, 0.5],
};

/** Measured on Liam's test tickets with all three reads (PROGRESSION section 10). */
export const MEASURED_USD_PER_TICKET: Record<string, number> = { 'claude-opus-5-5': 0.15 };

export const costUsd = (model: string, inputTokens: number, outputTokens: number) => {
  const p = PRICE_PER_MILLION[model];
  return p ? (inputTokens * p[0] + outputTokens * p[1]) / 1e6 : null;
};
