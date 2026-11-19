// `pnpm extract <scan>`: reads every ticket in a scan (PDF, JPEG or PNG) with the real model and
// prints what each pass read, the flags, and the cost. Per ticket: passes A and B; pass C for
// fields they could not settle (D27); then a second look at unclear names using the clear names
// from the same scan (D28). Saves the straightened tickets, the field crops and the readings to
// scan-output/<scan name>/. Needs ANTHROPIC_API_KEY in .env. Costs a few cents per ticket.
import {
  AGENCY_TIME_ZONE,
  type CheckedTicket,
  DEFAULT_MAX_DATE_AGE_DAYS,
  DEFAULT_MAX_SHIFT_HOURS,
  DEFAULT_MIN_SHIFT_HOURS,
  type ExtractionResult,
  FIELD_KEYS,
  TEMPLATE_V1,
  batchNameCandidates,
  checkExtraction,
  todayIn,
  trustedName,
  unclearFields,
  withRetriedName,
} from '@tally/shared';
import {
  AnthropicExtractor,
  type ExtractionInput,
  type ExtractionPass,
} from '@tally/shared/extraction';
import { prepareTicket } from '@tally/shared/imaging';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { loadList } from './lists.ts';
import { scanPages } from './pages.ts';

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

const knownWorkplaces = loadList('workplaces.txt');
const knownNames = loadList('names.txt');
const report: string[] = [
  `Model: ${model}`,
  `Lists: ${knownWorkplaces.length} workplaces (workplaces.txt), ${knownNames.length} names (names.txt).`,
];
for (const line of report) console.log(line);
const usage = {
  input: 0,
  output: 0,
  calls: { A: 0, B: 0, C: 0 } as Record<ExtractionPass, number>,
};

async function read(input: ExtractionInput, pass: ExtractionPass): Promise<ExtractionResult> {
  const r = await extractor.extract(input, TEMPLATE_V1, pass);
  usage.input += r.usage.inputTokens;
  usage.output += r.usage.outputTokens;
  usage.calls[pass]++;
  return r.result;
}

interface Ticket {
  page: number;
  input: ExtractionInput;
  markersFound: boolean;
  imageFlags: string[];
  a: ExtractionResult;
  b: ExtractionResult;
  c?: ExtractionResult;
  checked: CheckedTicket;
  secondLook?: string;
}

// Round 1: passes A and B on every ticket, and pass C where they could not settle a field.
const tickets: Ticket[] = [];
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
    knownNames,
  };
  const lists = { knownWorkplaces, knownNames };
  try {
    const a = await read(input, 'A');
    const b = await read(input, 'B');
    let checked = checkExtraction(a, b, settings, lists);
    let c: ExtractionResult | undefined;
    if (unclearFields(checked).length > 0) {
      c = await read(input, 'C');
      checked = checkExtraction(a, b, settings, { ...lists, thirdRead: c });
    }
    const imageFlags = prepared.flags.map((f) => f.code);
    tickets.push({
      page: i + 1,
      input,
      markersFound: prepared.markersFound,
      imageFlags,
      a,
      b,
      c,
      checked,
    });
  } catch (error) {
    const status = (error as { status?: number }).status;
    console.error(
      status === 401
        ? 'The API key was refused. Check ANTHROPIC_API_KEY in .env.'
        : `Page ${i + 1}: reading failed: ${String(error)}`,
    );
    if (status === 401) process.exit(1);
  }
}

// Round 2: unclear names get a second look, with the scan's clear names added to the list.
const batchNames = [
  ...new Set(tickets.map((t) => trustedName(t.checked)).filter((n) => n !== null)),
];
for (const t of tickets) {
  const candidates = batchNameCandidates(t.a, t.b, t.checked, batchNames, knownNames);
  if (candidates.length === 0) continue;
  const input = { ...t.input, knownNames: [...knownNames, ...candidates] };
  try {
    const retry = checkExtraction(await read(input, 'A'), await read(input, 'B'), settings, {
      knownWorkplaces,
      knownNames: input.knownNames,
    });
    t.checked = withRetriedName(t.checked, retry);
    t.secondLook = `${candidates.join(', ')} → ${retry.nameFromList ? `settled: ${retry.fields.firstName}` : 'not settled'}`;
  } catch (error) {
    console.error(`Page ${t.page}: second look failed: ${String(error)}`);
  }
}

for (const t of tickets) {
  const { flags, suggestions, fields, workplaceFromList, nameFromList } = t.checked;
  const show = (r: ExtractionResult | undefined, k: (typeof FIELD_KEYS)[number]) => {
    if (!r) return '-';
    const f = r.fields[k];
    return f.legible ? (f.value ?? '(empty)') : f.suggestion ? `? (guess ${f.suggestion})` : '?';
  };
  const lines = [
    `\n=== Ticket ${t.page} (markers ${t.markersFound ? 'found' : 'NOT found'})`,
    ...FIELD_KEYS.map(
      (k) =>
        `${k.padEnd(12)} read 1: ${show(t.a, k).padEnd(22)} read 2: ${show(t.b, k).padEnd(22)} read 3: ${show(t.c, k)}`,
    ),
    `name match   read 1: ${(t.a.nameMatch ?? 'none').padEnd(22)} read 2: ${t.b.nameMatch ?? 'none'}${nameFromList ? '  → accepted' : ''}`,
    `place match  read 1: ${(t.a.workplaceMatch ?? 'none').padEnd(22)} read 2: ${t.b.workplaceMatch ?? 'none'}${workplaceFromList ? '  → accepted' : ''}`,
    ...(t.secondLook ? [`second look at name (batch names): ${t.secondLook}`] : []),
    `result: ${(['firstName', 'workplace'] as const)
      .map((k) => {
        if (!flags.some((f) => f.field === k)) return `${k}=${fields[k] ?? '(empty)'} (accepted)`;
        const guess = suggestions[k];
        return `${k}=${guess ? `person confirms "${guess}"` : 'person types it'}`;
      })
      .join(', ')}`,
    `flags: ${[...t.imageFlags, ...flags.map((f) => `${f.code}${f.field ? ` (${f.field})` : ''}`)].join(', ') || 'none'}`,
  ];
  console.log(lines.join('\n'));
  report.push(...lines, `full answers: ${JSON.stringify({ readA: t.a, readB: t.b, readC: t.c })}`);
}

const price = PRICE_PER_MILLION[model];
const cost = price
  ? ` ≈ $${((usage.input * price[0] + usage.output * price[1]) / 1e6).toFixed(4)}`
  : '';
const total = `\nCalls: ${usage.calls.A} A, ${usage.calls.B} B, ${usage.calls.C} C. Tokens: ${usage.input} in, ${usage.output} out${cost} for ${pages.length} ticket(s).`;
console.log(total);
writeFileSync(join(outRoot, 'readings.txt'), [...report, total].join('\n') + '\n');
console.log(`Saved to ${outRoot}/ (readings.txt, ticket and field images).`);
