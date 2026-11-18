import { existsSync, readFileSync } from 'node:fs';
import type { TicketTemplate } from '../templates/v1.ts';
import {
  type ExtractionInput,
  type ExtractionPass,
  type ExtractionSuccess,
  ExtractionError,
  PROMPT_VERSION,
  type TicketExtractor,
  validateAnswer,
} from './extractor.ts';

/**
 * Returns prepared answers instead of calling the model, so tests are free and repeatable.
 * The answer for ticket `id` and pass A is the file `<id>.pass-a.json` in `dir`.
 */
export class FakeExtractor implements TicketExtractor {
  private readonly dir: URL;

  constructor(dir: URL) {
    this.dir = dir;
  }

  async extract(
    input: ExtractionInput,
    _template: TicketTemplate,
    pass: ExtractionPass,
  ): Promise<ExtractionSuccess> {
    const file = new URL(`${input.id}.pass-${pass.toLowerCase()}.json`, this.dir);
    if (!existsSync(file)) throw new Error(`FakeExtractor: no prepared answer ${file.pathname}`);
    let answer: unknown;
    try {
      answer = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      throw new ExtractionError('invalid_output', `Prepared answer is not JSON: ${file.pathname}`);
    }
    return {
      result: validateAnswer(answer),
      model: 'fake',
      promptVersion: PROMPT_VERSION,
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }
}
