// What the reading pipeline needs from outside: the reader for a speed, and the rule settings.
// Tests replace it with a fake reader and a fixed "today".
import Anthropic from '@anthropic-ai/sdk';
import {
  AGENCY_TIME_ZONE,
  DEFAULT_MAX_DATE_AGE_DAYS,
  DEFAULT_MAX_SHIFT_HOURS,
  DEFAULT_MIN_SHIFT_HOURS,
  type ReadSpeed,
  type RuleSettings,
  todayIn,
} from '@tally/shared';
import {
  AnthropicBatchExtractor,
  AnthropicExtractor,
  type Effort,
  FakeExtractor,
  type TicketExtractor,
} from '@tally/shared/extraction';

export class ReadingConfig {
  constructor(
    readonly extractor: (speed: ReadSpeed) => TicketExtractor,
    readonly settings: () => RuleSettings,
    /** REVIEW_EVERYTHING (ships true): a ticket with no flags still waits for one click (step 7). */
    readonly reviewEverything: boolean,
    /** The wait before the first retry of a failed reading; it doubles each time (section 10). */
    readonly firstRetryWaitMs = 2_000,
  ) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env) {
    const num = (key: string, fallback: number) => (env[key] ? Number(env[key]) : fallback);
    const settings = (): RuleSettings => ({
      today: todayIn(AGENCY_TIME_ZONE),
      minShiftHours: num('MIN_SHIFT_HOURS', DEFAULT_MIN_SHIFT_HOURS),
      maxShiftHours: num('MAX_SHIFT_HOURS', DEFAULT_MAX_SHIFT_HOURS),
      maxDateAgeDays: num('MAX_DATE_AGE_DAYS', DEFAULT_MAX_DATE_AGE_DAYS),
    });
    const extractor = (speed: ReadSpeed): TicketExtractor => {
      if (env.EXTRACTOR === 'anthropic') {
        const model = env.EXTRACTOR_MODEL || 'claude-opus-5-5';
        const effort = (env.EXTRACTOR_EFFORT || undefined) as Effort | undefined;
        // Retries are ours (withRetries), so the SDK's own are turned off.
        const client = new Anthropic({ maxRetries: 0 });
        return speed === 'batch'
          ? new AnthropicBatchExtractor({ model, client, effort })
          : new AnthropicExtractor({ model, client, effort });
      }
      if (env.EXTRACTOR === 'fake') {
        // Local runs without an API key: every ticket gets the same prepared clean answer.
        const fake = new FakeExtractor(
          new URL('../../../../fixtures/extractions/', import.meta.url),
        );
        return { extract: (input, t, pass) => fake.extract({ ...input, id: 'clean' }, t, pass) };
      }
      // Never fall back to the fake reader by accident: it would "read" real tickets.
      throw new Error('EXTRACTOR must be "anthropic" or "fake" (see .env.example).');
    };
    return new ReadingConfig(extractor, settings, env.REVIEW_EVERYTHING !== 'false');
  }
}
