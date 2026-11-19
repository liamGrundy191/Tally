// The swappable reading step (plan section 3): TicketExtractor.extract(image, template, pass).
import type Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { readFileSync } from 'node:fs';
import {
  type ExtractionResult,
  type FieldKey,
  type KnownLists,
  extractionResultSchema,
} from '../rules/schemas.ts';
import type { TemplateField, TicketTemplate } from '../templates/v1.ts';

/** Bump when a prompt file changes, and add a new prompts/vN folder; never edit an old version. */
export const PROMPT_VERSION = 'v3';

/** A and B are the two independent readings; C is the tie-break read for unclear fields (D27). */
export type ExtractionPass = 'A' | 'B' | 'C';

/** How long the model thinks before answering; more effort costs more output tokens. */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];
/** High read hard digits better than medium for about 10% more (D35). */
export const DEFAULT_EFFORT: Effort = 'high';

export interface TicketImage {
  data: Buffer;
  mediaType: 'image/jpeg' | 'image/png';
}

export interface ExtractionInput {
  /** Stable name for logs and fixtures, e.g. "scan-03.pdf#p12". */
  id: string;
  /** The whole (normalised) ticket. */
  image: TicketImage;
  /** One crop per field, when the corner markers were found. Only pass B uses them, beside the whole ticket. */
  crops?: Partial<Record<FieldKey, TicketImage>>;
  /** The agency's workplaces; the model may only name one of these as `workplaceMatch`. */
  knownWorkplaces?: readonly string[];
  /** Known first names (uploaded list plus clear names from the batch, D28), for `nameMatch`. */
  knownNames?: readonly string[];
}

export const listsOf = (input: ExtractionInput): KnownLists => ({
  workplaces: input.knownWorkplaces,
  names: input.knownNames,
});

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
  /** Tokens the failed attempt still cost (a cut-off answer is billed in full). */
  readonly usage?: ExtractionSuccess['usage'];

  constructor(reason: ExtractionFailure, message: string, usage?: ExtractionSuccess['usage']) {
    super(message);
    this.reason = reason;
    this.usage = usage;
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
export const answerFormat = (lists: KnownLists = {}) =>
  zodOutputFormat(extractionResultSchema(lists));

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
  effort: Effort = DEFAULT_EFFORT,
) {
  const list = (entries: readonly string[] = [], what: string, key: string) =>
    entries.length > 0
      ? [
          '',
          `Known ${what} (for ${key}, copy one exactly or use null):`,
          ...entries.map((e) => `- ${e}`),
        ]
      : ['', `No list of known ${what} is given: ${key} must be null.`];
  const fieldList = [
    `Ticket template ${template.version}. Fields:`,
    ...template.fields.map(describeField),
    ...list(input.knownWorkplaces, 'workplaces', 'workplaceMatch'),
    ...list(input.knownNames, 'first names', 'nameMatch'),
  ].join('\n');
  const useCrops =
    pass === 'B' && input.crops !== undefined && template.fields.every((f) => input.crops![f.key]);

  // Pass B gets the whole ticket for context, then each field zoomed in (D29).
  const content: Anthropic.ContentBlockParam[] = useCrops
    ? [
        { type: 'text', text: 'The whole ticket:' },
        imageBlock(input.image),
        ...template.fields.flatMap((f): Anthropic.ContentBlockParam[] => [
          { type: 'text', text: `Field ${f.key} ("${f.labelHe}" / "${f.labelEn}"):` },
          imageBlock(input.crops![f.key]!),
        ]),
        {
          type: 'text',
          text: `${fieldList}\n\nAfter the whole ticket, each image is one field cut out of it and enlarged.`,
        },
      ]
    : [imageBlock(input.image), { type: 'text', text: fieldList }];

  return {
    model,
    max_tokens: 16000,
    system: loadPrompt(pass),
    messages: [{ role: 'user' as const, content }],
    output_config: { effort, format: answerFormat(listsOf(input)) },
  };
}

/** Validates an answer against the schema; anything else is a failed attempt. */
export function validateAnswer(answer: unknown, lists: KnownLists = {}): ExtractionResult {
  const parsed = extractionResultSchema(lists).safeParse(answer);
  if (!parsed.success) {
    // Name the broken parts only: the full message repeats both lists, which can be long.
    const where = [...new Set(parsed.error.issues.map((i) => i.path.join('.') || '(root)'))];
    throw new ExtractionError(
      'invalid_output',
      `Answer does not match the format at: ${where.join(', ')}`,
    );
  }
  return parsed.data;
}
