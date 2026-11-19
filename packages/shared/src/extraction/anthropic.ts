import Anthropic from '@anthropic-ai/sdk';
import type { TicketTemplate } from '../templates/v1.ts';
import {
  type ExtractionInput,
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

  /** `client` is only passed by tests; normally the key comes from ANTHROPIC_API_KEY. */
  constructor(opts: { model: string; client?: Anthropic }) {
    this.model = opts.model;
    this.client = opts.client ?? new Anthropic();
  }

  async extract(
    input: ExtractionInput,
    template: TicketTemplate,
    pass: ExtractionPass,
  ): Promise<ExtractionSuccess> {
    let response;
    try {
      response = await this.client.messages.parse(buildRequest(input, template, pass, this.model));
    } catch (error) {
      if (error instanceof Anthropic.APIError) throw error; // rate limits, outages: caller retries
      throw new ExtractionError('invalid_output', `Could not read the answer: ${String(error)}`);
    }
    if (response.stop_reason === 'refusal') {
      throw new ExtractionError('refusal', 'The model declined to read this ticket.');
    }
    if (response.stop_reason === 'max_tokens') {
      throw new ExtractionError('truncated', 'The answer was cut off.');
    }
    if (!response.parsed_output) {
      throw new ExtractionError('invalid_output', 'The answer was not in the required format.');
    }
    return {
      result: validateAnswer(response.parsed_output, listsOf(input)),
      model: response.model,
      promptVersion: PROMPT_VERSION,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  }
}
