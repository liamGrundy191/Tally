// Section 10: an extractor error or rate limit is retried with growing waits, at most 5 attempts in
// all. An unusable answer counts as a failed attempt too.
import type { TicketExtractor } from './extractor.ts';

/** A refused key (401) or a malformed request (400) fails the same way every time. */
const PERMANENT = new Set([400, 401, 403, 404]);

export function withRetries(
  extractor: TicketExtractor,
  opts: { attempts?: number; firstWaitMs?: number } = {},
): TicketExtractor {
  const attempts = opts.attempts ?? 5;
  const firstWaitMs = opts.firstWaitMs ?? 2_000;
  return {
    async extract(input, template, pass) {
      for (let attempt = 1; ; attempt++) {
        try {
          return await extractor.extract(input, template, pass);
        } catch (e) {
          const status = (e as { status?: number } | null)?.status;
          if (attempt >= attempts || (status !== undefined && PERMANENT.has(status))) throw e;
          await new Promise((r) => setTimeout(r, firstWaitMs * 2 ** (attempt - 1)));
        }
      }
    },
  };
}
