import Anthropic from '@anthropic-ai/sdk';
import type { TicketTemplate } from '../templates/v1.ts';
import {
  type ExtractionInput,
  DEFAULT_EFFORT,
  type Effort,
  type ExtractionPass,
  type ExtractionSuccess,
  ExtractionError,
  PROMPT_VERSION,
  type TicketExtractor,
  buildRequest,
  listsOf,
  validateAnswer,
} from './extractor.ts';

/** Reads tickets with Claude. The model comes from EXTRACTOR_MODEL. */
export class AnthropicExtractor implements TicketExtractor {
  private readonly model: string;
  private readonly client: Anthropic;
  private readonly effort: Effort;

  /** `client` is only passed by tests; normally the key comes from ANTHROPIC_API_KEY. */
  constructor(opts: { model: string; client?: Anthropic; effort?: Effort }) {
    this.model = opts.model;
    this.client = opts.client ?? new Anthropic();
    this.effort = opts.effort ?? DEFAULT_EFFORT;
  }

  async extract(
    input: ExtractionInput,
    template: TicketTemplate,
    pass: ExtractionPass,
  ): Promise<ExtractionSuccess> {
    let response;
    try {
      response = await this.client.messages.parse(
        buildRequest(input, template, pass, this.model, this.effort),
      );
    } catch (error) {
      if (error instanceof Anthropic.APIError) throw error; // rate limits, outages: caller retries
      throw new ExtractionError('invalid_output', `Could not read the answer: ${String(error)}`);
    }
    return toSuccess(response, response.parsed_output, input);
  }
}

/**
 * Turns a finished model answer into a result: a refusal, a cut-off answer or an answer that does
 * not fit the format is a failed attempt. Shared by the immediate and the batch readers.
 */
export function toSuccess(
  response: Pick<Anthropic.Message, 'stop_reason' | 'model' | 'usage'>,
  answer: unknown,
  input: ExtractionInput,
): ExtractionSuccess {
  // Every failure below was still billed, so it carries the usage for cost tracking.
  const usage = {
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
  if (response.stop_reason === 'refusal') {
    throw new ExtractionError('refusal', 'The model declined to read this ticket.', usage);
  }
  if (response.stop_reason === 'max_tokens') {
    throw new ExtractionError('truncated', 'The answer was cut off.', usage);
  }
  if (answer === null || answer === undefined) {
    throw new ExtractionError(
      'invalid_output',
      'The answer was not in the required format.',
      usage,
    );
  }
  let result;
  try {
    result = validateAnswer(answer, listsOf(input));
  } catch (error) {
    if (error instanceof ExtractionError)
      throw new ExtractionError(error.reason, error.message, usage);
    throw error;
  }
  return { result, model: response.model, promptVersion: PROMPT_VERSION, usage };
}
