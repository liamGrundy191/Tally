// `pnpm extract <scan>`: reads every ticket in a scan (PDF, JPEG or PNG) with the real model,
// both passes, and prints what each pass read, the flags, and the cost. Also saves the
// straightened tickets, the field crops and the readings to scan-output/<scan name>/.
// Needs ANTHROPIC_API_KEY in .env. Costs a few cents per ticket.
import {
  AGENCY_TIME_ZONE,
  DEFAULT_MAX_DATE_AGE_DAYS,
  DEFAULT_MAX_SHIFT_HOURS,
  DEFAULT_MIN_SHIFT_HOURS,
  FIELD_KEYS,
  TEMPLATE_V1,
  checkExtraction,
  todayIn,
} from '@tally/shared';
import { AnthropicExtractor, type ExtractionSuccess } from '@tally/shared/extraction';
import { prepareTicket } from '@tally/shared/imaging';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { scanPages } from './pages.ts';
import { loadWorkplaces } from './workplaces.ts';

const DEFAULT_MODEL = 'claude-opus-5-5';
// shortcut: prices hard-coded for the cost estimate only; update from anthropic.com/pricing.
const PRICE_PER_MILLION: Record<string, [input: number, output: number]> = {
  'claude-opus-5-5': [4, 20],
  'claude-sonnet-5-5': [2, 10],
  'claude-haiku-5-5': [0.1, 0.5],
};

const path = process.argv[2];
if (!path) {
  console.error('Usage: pnpm extract <scan: .pdf, .jpg or .png>');
  process.exit(1);
}
const model = process.env.EXTRACTOR_MODEL || DEFAULT_MODEL;
const extractor = new AnthropicExtractor({ model });
const outRoot = join('scan-output', basename(path, extname(path)));
const settings = {
  today: todayIn(AGENCY_TIME_ZONE),
  minShiftHours: DEFAULT_MIN_SHIFT_HOURS,
  maxShiftHours: DEFAULT_MAX_SHIFT_HOURS,
  maxDateAgeDays: DEFAULT_MAX_DATE_AGE_DAYS,
};

const knownWorkplaces = loadWorkplaces();
const report: string[] = [
  `Model: ${model}`,
  knownWorkplaces.length > 0
    ? `Using ${knownWorkplaces.length} known workplaces from workplaces.txt.`
    : 'No workplaces.txt: reading workplaces without a list.',
];
for (const line of report) console.log(line);
let inputTokens = 0;
let outputTokens = 0;
const pages = await scanPages(path);

for (const [i, page] of pages.entries()) {
  const prepared = await prepareTicket(page, TEMPLATE_V1);
  const dir = join(outRoot, `page-${i + 1}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'ticket.jpg'), prepared.ticket.data);
  for (const [field, crop] of Object.entries(prepared.crops ?? {}))
    writeFileSync(join(dir, `${field}.jpg`), crop.data);

  const input = {
    id: `${path}#${i + 1}`,
    image: prepared.ticket,
    crops: prepared.crops,
    knownWorkplaces,
  };
  let a: ExtractionSuccess;
  let b: ExtractionSuccess;
  try {
    a = await extractor.extract(input, TEMPLATE_V1, 'A');
    b = await extractor.extract(input, TEMPLATE_V1, 'B');
  } catch (error) {
    const status = (error as { status?: number }).status;
    console.error(
      status === 401
        ? 'The API key was refused. Check ANTHROPIC_API_KEY in .env.'
        : `Page ${i + 1}: reading failed: ${String(error)}`,
    );
    if (status === 401) process.exit(1);
    continue;
  }
  inputTokens += a.usage.inputTokens + b.usage.inputTokens;
  outputTokens += a.usage.outputTokens + b.usage.outputTokens;

  const { flags, suggestions, fields, workplaceFromList } = checkExtraction(
    a.result,
    b.result,
    settings,
    {
      usedWorkplaceList: knownWorkplaces.length > 0,
    },
  );
  const show = (r: ExtractionSuccess, k: (typeof FIELD_KEYS)[number]) => {
    const f = r.result.fields[k];
    return f.legible ? (f.value ?? '(empty)') : f.suggestion ? `? (guess ${f.suggestion})` : '?';
  };
  const lines = [
    `\n=== Ticket ${i + 1} (markers ${prepared.markersFound ? 'found' : 'NOT found'})`,
    ...FIELD_KEYS.map(
      (k) => `${k.padEnd(12)} read 1: ${show(a, k).padEnd(24)} read 2: ${show(b, k)}`,
    ),
    ...(knownWorkplaces.length > 0
      ? [
          `list match   read 1: ${(a.result.workplaceMatch ?? 'none').padEnd(24)} read 2: ${b.result.workplaceMatch ?? 'none'}${workplaceFromList ? '  → accepted' : ''}`,
        ]
      : []),
    `result: ${(['firstName', 'workplace'] as const)
      .map((k) => {
        const value = fields[k];
        const guess = value ?? suggestions[k];
        if (!flags.some((f) => f.field === k)) return `${k}=${value ?? '(empty)'} (accepted)`;
        return `${k}=${guess ? `person confirms "${guess}"` : 'person types it'}`;
      })
      .join(', ')}`,
    `crossed out: ${a.result.voided || b.result.voided ? 'yes' : 'no'}; overwritten: ${[...new Set([...a.result.overwrittenFields, ...b.result.overwrittenFields])].join(', ') || 'none'}`,
    `flags: ${[...prepared.flags, ...flags].map((f) => `${f.code}${f.field ? ` (${f.field})` : ''}`).join(', ') || 'none'}`,
  ];
  console.log(lines.join('\n'));
  report.push(...lines, `full answers: ${JSON.stringify({ readA: a.result, readB: b.result })}`);
}

const price = PRICE_PER_MILLION[model];
const cost = price
  ? ` ≈ $${((inputTokens * price[0] + outputTokens * price[1]) / 1e6).toFixed(4)}`
  : '';
const total = `\nTokens: ${inputTokens} in, ${outputTokens} out${cost} for ${pages.length} ticket(s).`;
console.log(total);
writeFileSync(join(outRoot, 'readings.txt'), [...report, total].join('\n') + '\n');
console.log(`Saved to ${outRoot}/ (readings.txt, ticket and field images).`);
