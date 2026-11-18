// The swappable reading step (plan section 3): TicketExtractor.extract(image, template, pass).
import type Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { readFileSync } from 'node:fs';
import { type ExtractionResult, ExtractionResultSchema, type FieldKey } from '../rules/schemas.ts';
import type { TemplateField, TicketTemplate } from '../templates/v1.ts';

/** Bump when a prompt file changes, and add a new prompts/vN folder; never edit an old version. */
export const PROMPT_VERSION = 'v1';

export type ExtractionPass = 'A' | 'B';

export interface TicketImage {
  data: Buffer;
  mediaType: 'image/jpeg' | 'image/png';
}

export interface ExtractionInput {
  /** Stable name for logs and fixtures, e.g. "scan-03.pdf#p12". */
  id: string;
  /** The whole (normalised) ticket. */
  image: TicketImage;
  /** One crop per field, when the corner markers were found. Only pass B uses them. */
  crops?: Partial<Record<FieldKey, TicketImage>>;
}

export interface ExtractionSuccess {
  result: ExtractionResult;
  /** The model that actually answered, for the FieldExtraction record. */
  model: string;
  promptVersion: string;
  usage: { inputTokens: number; outputTokens: number };
}

export interface TicketExtractor {
  /**
   * Reads one ticket. Throws ExtractionError when the answer is unusable (counts as a failed
   * attempt); API errors such as rate limits are thrown as the SDK's own errors. Retrying is the
   * caller's job.
   */
  extract(
    input: ExtractionInput,
    template: TicketTemplate,
    pass: ExtractionPass,
  ): Promise<ExtractionSuccess>;
}

export type ExtractionFailure = 'invalid_output' | 'refusal' | 'truncated';

export class ExtractionError extends Error {
  override name = 'ExtractionError';
  readonly reason: ExtractionFailure;

  constructor(reason: ExtractionFailure, message: string) {
    super(message);
    this.reason = reason;
  }
}

export function loadPrompt(pass: ExtractionPass): string {
  const file = new URL(
    `../../prompts/${PROMPT_VERSION}/pass-${pass.toLowerCase()}.md`,
    import.meta.url,
  );
  return readFileSync(file, 'utf8');
}

/** The answer format the model is held to, generated from the same schema the rules use. */
export const answerFormat = () => zodOutputFormat(ExtractionResultSchema);

function describeField(f: TemplateField): string {
  const boxes = [...f.pattern].filter((c) => c !== '/' && c !== ':').length;
  const format = /^_+$/.test(f.pattern) ? `handwritten text, up to ${boxes} boxes` : f.pattern;
  return `- ${f.key}: "${f.labelHe}" / "${f.labelEn}" (${format})`;
}

const imageBlock = (img: TicketImage): Anthropic.ImageBlockParam => ({
  type: 'image',
  source: { type: 'base64', media_type: img.mediaType, data: img.data.toString('base64') },
});

/** The request for one pass. Pure, so tests can check exactly what would be sent. */
export function buildRequest(
  input: ExtractionInput,
  template: TicketTemplate,
  pass: ExtractionPass,
  model: string,
) {
  const fieldList = `Ticket template ${template.version}. Fields:\n${template.fields.map(describeField).join('\n')}`;
  const useCrops =
    pass === 'B' && input.crops !== undefined && template.fields.every((f) => input.crops![f.key]);

  const content: Anthropic.ContentBlockParam[] = useCrops
    ? [
        ...template.fields.flatMap((f): Anthropic.ContentBlockParam[] => [
          { type: 'text', text: `Field ${f.key} ("${f.labelHe}" / "${f.labelEn}"):` },
          imageBlock(input.crops![f.key]!),
        ]),
        {
          type: 'text',
          text: `${fieldList}\n\nEach image above is one field cut out of the ticket.`,
        },
      ]
    : [imageBlock(input.image), { type: 'text', text: fieldList }];

  return {
    model,
    max_tokens: 16000,
    system: loadPrompt(pass),
    messages: [{ role: 'user' as const, content }],
    output_config: { effort: 'medium' as const, format: answerFormat() },
  };
}

/** Validates an answer against the schema; anything else is a failed attempt. */
export function validateAnswer(answer: unknown): ExtractionResult {
  const parsed = ExtractionResultSchema.safeParse(answer);
  if (!parsed.success) {
    throw new ExtractionError(
      'invalid_output',
      `Answer does not match the format: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}
