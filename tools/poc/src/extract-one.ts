// `pnpm extract <image>`: reads one ticket photo or scan with the real model (both passes) and
// prints what each pass read, the flags the rules raise, and the cost. Needs ANTHROPIC_API_KEY
// in .env. Costs a few cents per run.
import {
  AGENCY_TIME_ZONE,
  DEFAULT_MAX_DATE_AGE_DAYS,
  DEFAULT_MAX_SHIFT_HOURS,
  DEFAULT_MIN_SHIFT_HOURS,
  TEMPLATE_V1,
  checkExtraction,
  todayIn,
} from '@tally/shared';
import { AnthropicExtractor, type ExtractionSuccess } from '@tally/shared/extraction';
import { readFileSync } from 'node:fs';
import sharp from 'sharp';

const DEFAULT_MODEL = 'claude-opus-5-5';
// shortcut: prices hard-coded for the cost estimate only; update from anthropic.com/pricing.
const PRICE_PER_MILLION: Record<string, [input: number, output: number]> = {
  'claude-opus-5-5': [4, 20],
  'claude-sonnet-5-5': [2, 10],
  'claude-haiku-5-5': [0.1, 0.5],
};

const path = process.argv[2];
if (!path) {
  console.error('Usage: pnpm extract <ticket image: .jpg or .png>');
  process.exit(1);
}
const model = process.env.EXTRACTOR_MODEL || DEFAULT_MODEL;

// shortcut: whole image only, no straightening or field crops; T0.5 adds those.
const data = await sharp(readFileSync(path))
  .rotate() // apply the phone's rotation
  .greyscale()
  .resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true })
  .jpeg({ quality: 90 })
  .toBuffer();

const extractor = new AnthropicExtractor({ model });
const input = { id: path, image: { data, mediaType: 'image/jpeg' as const } };

let a: ExtractionSuccess;
let b: ExtractionSuccess;
try {
  a = await extractor.extract(input, TEMPLATE_V1, 'A');
  b = await extractor.extract(input, TEMPLATE_V1, 'B');
} catch (error) {
  const status = (error as { status?: number }).status;
  if (status === 401) console.error('The API key was refused. Check ANTHROPIC_API_KEY in .env.');
  else console.error(`Reading failed: ${String(error)}`);
  process.exit(1);
}

const { flags } = checkExtraction(a.result, b.result, {
  today: todayIn(AGENCY_TIME_ZONE),
  minShiftHours: DEFAULT_MIN_SHIFT_HOURS,
  maxShiftHours: DEFAULT_MAX_SHIFT_HOURS,
  maxDateAgeDays: DEFAULT_MAX_DATE_AGE_DAYS,
});

console.log(`Model: ${a.model} (pass A), ${b.model} (pass B). Prompts ${a.promptVersion}.`);
console.log('\nPass A read:', JSON.stringify(a.result, null, 2));
console.log('\nPass B read:', JSON.stringify(b.result, null, 2));
console.log(
  '\nFlags:',
  flags.length ? flags.map((f) => `${f.code}${f.field ? ` (${f.field})` : ''}`).join(', ') : 'none',
);

const inputTokens = a.usage.inputTokens + b.usage.inputTokens;
const outputTokens = a.usage.outputTokens + b.usage.outputTokens;
const price = PRICE_PER_MILLION[model];
const cost = price
  ? ` ≈ $${((inputTokens * price[0] + outputTokens * price[1]) / 1e6).toFixed(4)}`
  : '';
console.log(`Tokens: ${inputTokens} in, ${outputTokens} out${cost} for this ticket.`);
