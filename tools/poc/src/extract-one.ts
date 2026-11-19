// `pnpm extract <scan>`: reads every ticket in one scan (PDF, JPEG or PNG) with the real model,
// using the same process as `pnpm poc` (readBatch), and prints what each read saw, the result and
// the flags. Saves the straightened tickets, the field crops and the readings to
// scan-output/<scan name>/. Needs ANTHROPIC_API_KEY in .env. Costs about 15 cents per ticket.
import {
  AGENCY_TIME_ZONE,
  DEFAULT_MAX_DATE_AGE_DAYS,
  DEFAULT_MAX_SHIFT_HOURS,
  DEFAULT_MIN_SHIFT_HOURS,
  type ExtractionResult,
  FIELD_KEYS,
  TEMPLATE_V1,
  todayIn,
} from '@tally/shared';
import {
  AnthropicExtractor,
  type BatchItem,
  type ExtractionPass,
  readBatch,
} from '@tally/shared/extraction';
import { prepareTicket } from '@tally/shared/imaging';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { costUsd } from './cost.ts';
import { loadList } from './lists.ts';
import { scanPages } from './pages.ts';

const path = process.argv[2];
if (!path) {
  console.error('Usage: pnpm extract <scan: .pdf, .jpg or .png>');
  process.exit(1);
}
const model = process.env.EXTRACTOR_MODEL || 'claude-opus-5-5';
const outRoot = join('scan-output', basename(path, extname(path)));
const knownWorkplaces = loadList('workplaces.txt');
const knownNames = loadList('names.txt');
const report: string[] = [
  `Model: ${model}`,
  `Lists: ${knownWorkplaces.length} workplaces (workplaces.txt), ${knownNames.length} names (names.txt).`,
];
for (const line of report) console.log(line);

const items: BatchItem[] = [];
const markers: boolean[] = [];
for (const [i, page] of (await scanPages(path)).entries()) {
  const prepared = await prepareTicket(page, TEMPLATE_V1);
  const dir = join(outRoot, `page-${i + 1}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'ticket.jpg'), prepared.ticket.data);
  for (const [field, crop] of Object.entries(prepared.crops ?? {}))
    writeFileSync(join(dir, `${field}.jpg`), crop.data);
  items.push({
    input: { id: `page-${i + 1}`, image: prepared.ticket, crops: prepared.crops },
    imageFlags: prepared.flags,
  });
  markers.push(prepared.markersFound);
}

const usage = {
  input: 0,
  output: 0,
  calls: { A: 0, B: 0, C: 0 } as Record<ExtractionPass, number>,
};
let tickets;
try {
  tickets = await readBatch(items, {
    extractor: new AnthropicExtractor({ model }),
    template: TEMPLATE_V1,
    settings: {
      today: todayIn(AGENCY_TIME_ZONE),
      minShiftHours: DEFAULT_MIN_SHIFT_HOURS,
      maxShiftHours: DEFAULT_MAX_SHIFT_HOURS,
      maxDateAgeDays: DEFAULT_MAX_DATE_AGE_DAYS,
    },
    knownWorkplaces,
    knownNames,
    onRead: (pass, u) => {
      usage.input += u.inputTokens;
      usage.output += u.outputTokens;
      usage.calls[pass]++;
    },
  });
} catch (error) {
  const status = (error as { status?: number }).status;
  console.error(
    status === 401 ? 'The API key was refused. Check ANTHROPIC_API_KEY in .env.' : error,
  );
  process.exit(1);
}

const show = (r: ExtractionResult | undefined, k: (typeof FIELD_KEYS)[number]) => {
  if (!r) return '-';
  const f = r.fields[k];
  return f.legible ? (f.value ?? '(empty)') : f.suggestion ? `? (guess ${f.suggestion})` : '?';
};
for (const [i, t] of tickets.entries()) {
  const head = `\n=== Ticket ${i + 1} (markers ${markers[i] ? 'found' : 'NOT found'})`;
  if (!t.checked) {
    const lines = [head, `reading failed, a person types this ticket: ${t.error}`];
    console.log(lines.join('\n'));
    report.push(...lines);
    continue;
  }
  const { A: a, B: b, C: c } = t.reads;
  const { flags, suggestions, fields, workplaceFromList, nameFromList, totalFromMath } = t.checked;
  const lines = [
    head,
    ...FIELD_KEYS.map(
      (k) =>
        `${k.padEnd(12)} read 1: ${show(a, k).padEnd(22)} read 2: ${show(b, k).padEnd(22)} read 3: ${show(c, k)}`,
    ),
    `name match   read 1: ${(a?.nameMatch ?? 'none').padEnd(22)} read 2: ${b?.nameMatch ?? 'none'}${nameFromList ? '  → accepted' : ''}`,
    `place match  read 1: ${(a?.workplaceMatch ?? 'none').padEnd(22)} read 2: ${b?.workplaceMatch ?? 'none'}${workplaceFromList ? '  → accepted' : ''}`,
    ...(t.secondLook
      ? [
          `second look at name (batch names): ${t.secondLook.candidates.join(', ')} → ${t.secondLook.settled ? 'settled' : 'not settled'}`,
        ]
      : []),
    ...(totalFromMath ? ['total: confirmed by the times (D30, risky rule)'] : []),
    `result: ${(['firstName', 'workplace'] as const)
      .map((k) => {
        if (!flags.some((f) => f.field === k)) return `${k}=${fields[k] ?? '(empty)'} (accepted)`;
        const guess = fields[k] ?? suggestions[k];
        return `${k}=${guess ? `person confirms "${guess}"` : 'person types it'}`;
      })
      .join(', ')}`,
    `flags: ${flags.map((f) => `${f.code}${f.field ? ` (${f.field})` : ''}`).join(', ') || 'none'}`,
  ];
  console.log(lines.join('\n'));
  report.push(...lines, `full answers: ${JSON.stringify(t.reads)}`);
}

const cost = costUsd(model, usage.input, usage.output);
const total = `\nCalls: ${usage.calls.A} A, ${usage.calls.B} B, ${usage.calls.C} C. Tokens: ${usage.input} in, ${usage.output} out${cost === null ? '' : ` ≈ $${cost.toFixed(4)}`} for ${items.length} ticket(s).`;
console.log(total);
writeFileSync(join(outRoot, 'readings.txt'), [...report, total].join('\n') + '\n');
console.log(`Saved to ${outRoot}/ (readings.txt, ticket and field images).`);
