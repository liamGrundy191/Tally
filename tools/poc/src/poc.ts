// `pnpm poc --input <folder> --truth <truth.csv>` (T0.6): reads every ticket in a folder of scans
// with the full process, grades it against truth.csv, and writes a report and a mistakes file.
// Without --yes it only checks the files and shows the estimated cost: it spends nothing.
// --batch reads through Anthropic's batch service at half the price, but slower (D34).
// `--template` writes an empty truth.csv for the folder instead. EXTRACTOR=fake uses fixtures.
import {
  AGENCY_TIME_ZONE,
  DEFAULT_MAX_DATE_AGE_DAYS,
  DEFAULT_MAX_SHIFT_HOURS,
  DEFAULT_MIN_SHIFT_HOURS,
  FIELD_KEYS,
  type FieldKey,
  type RuleSettings,
  TEMPLATE_V1,
  todayIn,
} from '@tally/shared';
import {
  AnthropicBatchExtractor,
  AnthropicExtractor,
  DEFAULT_EFFORT,
  EFFORTS,
  type Effort,
  type BatchItem,
  FakeExtractor,
  type TicketExtractor,
  readBatch,
} from '@tally/shared/extraction';
import { prepareTicket } from '@tally/shared/imaging';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { EFFORT_COST_GUESS, costUsd, estimateUsdPerTicket } from './cost.ts';
import { toCsv } from './csv.ts';
import { type GradedTicket, type Report, grade } from './grade.ts';
import { loadList } from './lists.ts';
import { scanPages } from './pages.ts';
import { type TruthRow, readTruth, truthTemplate } from './truth.ts';

const SCAN = /\.(pdf|jpe?g|png)$/i;

export interface ScannedTicket {
  file: string;
  page: number;
  item: BatchItem;
}

/** Every page of every scan in the folder, in file-name order, straightened and cut into boxes. */
export async function scanFolder(dir: string): Promise<ScannedTicket[]> {
  const files = readdirSync(dir)
    .filter((f) => SCAN.test(f))
    .sort((a, b) => a.localeCompare(b));
  const out: ScannedTicket[] = [];
  const ids = new Set<string>();
  for (const file of files) {
    const pages = await scanPages(join(dir, file));
    for (const [i, page] of pages.entries()) {
      const base = basename(file, extname(file));
      const id = pages.length === 1 && !/\.pdf$/i.test(file) ? base : `${base}.p${i + 1}`;
      if (ids.has(id)) throw new Error(`Two scans give the ticket name "${id}"; rename one file.`);
      ids.add(id);
      const prepared = await prepareTicket(page, TEMPLATE_V1);
      out.push({
        file,
        page: i + 1,
        item: {
          input: { id, image: prepared.ticket, crops: prepared.crops },
          imageFlags: prepared.flags,
        },
      });
    }
  }
  return out;
}

export interface RunOptions {
  extractor: TicketExtractor;
  settings: RuleSettings;
  knownWorkplaces?: readonly string[];
  knownNames?: readonly string[];
  onRead?: Parameters<typeof readBatch>[1]['onRead'];
  canSpend?: () => boolean;
  onTicketDone?: (done: number, total: number) => void;
  /** Tickets read at once; batch mode reads them all together. */
  concurrency?: number;
}

/** Reads the whole folder as one batch, then grades it. */
export async function runPoc(
  tickets: readonly ScannedTicket[],
  truth: TruthRow[],
  opts: RunOptions,
) {
  const reads = await readBatch(
    tickets.map((t) => t.item),
    { template: TEMPLATE_V1, ...opts },
  );
  const graded: GradedTicket[] = tickets.map((t, i) => ({
    file: t.file,
    page: t.page,
    read: reads[i]!,
  }));
  return { report: grade(graded, truth, opts.knownWorkplaces), graded };
}

const LABEL: Record<FieldKey, string> = {
  firstName: 'name',
  workplace: 'workplace',
  date: 'date',
  startTime: 'start',
  endTime: 'end',
  totalWorked: 'total',
};

export function formatReport(r: Report, costLine: string): string {
  const pct = (n: number, d: number) => (d === 0 ? '-' : `${Math.round((100 * n) / d)}%`);
  const head = [
    'box',
    'read right',
    'accepted ok',
    'ACCEPTED WRONG',
    'person: right guess',
    'person: wrong guess',
    'person: no guess',
  ];
  const table = [
    head,
    ...FIELD_KEYS.map((k) => {
      const f = r.fields[k];
      const total = Object.values(f).reduce((a, b) => a + b, 0);
      return [
        LABEL[k],
        pct(f.correct + f.flagged_right_guess, total),
        f.correct,
        f.wrong_not_flagged,
        f.flagged_right_guess,
        f.flagged_wrong_guess,
        f.flagged_no_guess,
      ].map(String);
    }),
  ];
  const widths = head.map((_, i) => Math.max(...table.map((row) => row[i]!.length)));
  const gate = r.gate.pass
    ? 'PASS: no wrong date or time got through without a flag, and no crossed-out ticket was missed.'
    : r.graded === 0
      ? 'NOT RUN: no ticket had a truth row.'
      : `FAIL: ${r.gate.datesTimesWrongNotFlagged} wrong date/time value(s) got through without a flag, ${r.gate.missedVoided} crossed-out ticket(s) missed. See mistakes.csv.`;
  return [
    `Tickets: ${r.tickets} read, ${r.graded} graded against the truth file.`,
    ...(r.noTruth.length ? [`  No truth row (not graded): ${r.noTruth.join('; ')}`] : []),
    ...(r.truthWithoutTicket.length
      ? [`  Truth rows with no scan: ${r.truthWithoutTicket.join('; ')}`]
      : []),
    `Reading failed: ${r.failed} ticket(s) (a person types these).`,
    '',
    `Gate G0: ${gate}`,
    '',
    ...table.map((row) => row.map((c, i) => c.padEnd(widths[i]!)).join('  ')),
    '(A ticket whose reading failed counts as "no guess" in every box. Crossed-out tickets that were caught are not counted per box.)',
    '',
    `Workload: ${r.needPerson} of ${r.graded} tickets need a person; ${r.boxesToCheck} boxes to check in total.`,
    `Crossed-out tickets: ${r.voided.caught} caught, ${r.voided.missed} missed, ${r.voided.wronglyMarked} wrongly marked as crossed out.`,
    `Total confirmed by the times (D30, risky): used ${r.totalFromMath.used} time(s), wrong ${r.totalFromMath.wrong} time(s).`,
    costLine,
  ].join('\n');
}

export function mistakesCsv(r: Report): string {
  return toCsv([
    ['file', 'page', 'box', 'what happened', 'really written', 'system shows', 'flags on the box'],
    ...r.mistakes.map((m) => [
      m.file,
      m.page,
      m.field === 'ticket' ? 'ticket' : LABEL[m.field],
      m.what,
      m.truth,
      m.system,
      m.flags,
    ]),
  ]);
}

async function main() {
  const { values: args } = parseArgs({
    options: {
      input: { type: 'string' },
      truth: { type: 'string' },
      template: { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
      batch: { type: 'boolean', default: false },
    },
  });
  if (!args.input) {
    console.error(
      'Usage: pnpm poc --input <folder> --truth <truth.csv> [--yes]   or   pnpm poc --input <folder> --template',
    );
    process.exit(1);
  }
  console.log(`Preparing the scans in ${args.input} …`);
  const tickets = await scanFolder(args.input);
  console.log(
    `${tickets.length} ticket(s) in ${new Set(tickets.map((t) => t.file)).size} file(s).`,
  );

  if (args.template) {
    const path = join(args.input, 'truth.csv');
    if (existsSync(path)) {
      console.error(`${path} already exists; not overwriting it.`);
      process.exit(1);
    }
    writeFileSync(path, truthTemplate(tickets));
    console.log(
      `Wrote ${path} with one empty row per ticket. Fill it in and save it as "CSV UTF-8".`,
    );
    return;
  }

  const truthPath = args.truth ?? join(args.input, 'truth.csv');
  const truth = readTruth(truthPath);
  for (const w of truth.warnings) console.log(`Warning: ${w}`);
  if (truth.errors.length > 0) {
    for (const e of truth.errors) console.error(`Error: ${e}`);
    console.error('Fix the truth file and run again. Nothing was read.');
    process.exit(1);
  }
  const dates = [...new Set(truth.rows.map((r) => r.values.date).filter((d) => d !== null))];
  console.log(
    `Truth file: ${truth.rows.length} row(s).` +
      (dates.length > 0
        ? ` Dates in it (check day and month are not swapped): ${dates.slice(0, 8).join(', ')}${dates.length > 8 ? ' …' : ''}`
        : ''),
  );
  const withoutTruth = tickets.filter(
    (t) =>
      !truth.rows.some((r) => r.file.toLowerCase() === t.file.toLowerCase() && r.page === t.page),
  );
  if (withoutTruth.length)
    console.log(
      `Warning: ${withoutTruth.length} ticket(s) have no truth row and will not be graded.`,
    );

  const fake = process.env.EXTRACTOR === 'fake';
  const model = process.env.EXTRACTOR_MODEL || 'claude-opus-5-5';
  const effort = (process.env.EXTRACTOR_EFFORT || DEFAULT_EFFORT) as Effort;
  if (!EFFORTS.includes(effort)) {
    console.error(`EXTRACTOR_EFFORT must be one of ${EFFORTS.join(', ')}; got "${effort}".`);
    process.exit(1);
  }
  // Batch mode costs half (D34): every price below is halved with it.
  const priceFactor = args.batch ? 0.5 : 1;
  const known = estimateUsdPerTicket(model);
  const perTicket = fake
    ? 0
    : known === null
      ? undefined
      : known * priceFactor * EFFORT_COST_GUESS[effort]!;
  const estimate = perTicket === undefined ? null : perTicket * tickets.length;
  // Stop starting new tickets at 1.5 times the estimate, so a surprise can't drain the budget.
  const cap = estimate === null ? null : Math.max(0.5, estimate * 1.5);
  console.log(
    fake
      ? 'Reader: fake (fixtures), free.'
      : `Reader: ${model}, effort ${effort}${args.batch ? ', batch mode (half price; each round usually within an hour, at most 24 hours)' : ''}. Estimated cost: ${estimate === null ? 'unknown for this model' : `about $${estimate.toFixed(2)} ($${perTicket!.toFixed(2)} per ticket); it stops at $${cap!.toFixed(2)}`}.`,
  );
  if (!fake && !args.yes) {
    console.log(
      'Checked only; nothing was read and nothing was spent. Add --yes to read the tickets.',
    );
    return;
  }
  if (cap === null) {
    // Without a price there is no spending stop, so nothing is read.
    console.error(`No price is known for ${model}; add it to tools/poc/src/cost.ts first.`);
    process.exit(1);
  }

  const batchReader =
    !fake && args.batch
      ? new AnthropicBatchExtractor({
          model,
          effort,
          onStatus: (s) =>
            console.log(
              s.state === 'sent'
                ? `\nBatch ${s.batchId}: sent ${s.requests} request(s). Waiting; leave this window open.`
                : s.state === 'ended'
                  ? `Batch ${s.batchId}: finished.`
                  : `Batch ${s.batchId}: ${s.done} of ${s.requests} done …`,
            ),
        })
      : null;
  if (batchReader) {
    // Stopping the program must not leave a batch running (and costing) in the background.
    process.once('SIGINT', () => {
      console.log('\nStopping: cancelling the running batch …');
      void batchReader.cancelAll().finally(() => process.exit(130));
    });
  }
  const extractor: TicketExtractor = fake
    ? new FakeExtractor(new URL('../../../fixtures/extractions/', import.meta.url))
    : (batchReader ?? new AnthropicExtractor({ model, effort }));
  const usage = { input: 0, output: 0 };
  const spent = () => (costUsd(model, usage.input, usage.output) ?? 0) * priceFactor;
  const { report, graded } = await runPoc(tickets, truth.rows, {
    extractor,
    settings: {
      today: todayIn(AGENCY_TIME_ZONE),
      minShiftHours: DEFAULT_MIN_SHIFT_HOURS,
      maxShiftHours: DEFAULT_MAX_SHIFT_HOURS,
      maxDateAgeDays: DEFAULT_MAX_DATE_AGE_DAYS,
    },
    knownWorkplaces: loadList('workplaces.txt'),
    knownNames: loadList('names.txt'),
    onRead: (_pass, u) => {
      usage.input += u.inputTokens;
      usage.output += u.outputTokens;
    },
    canSpend: () => spent() < cap,
    onTicketDone: (done, total) => process.stdout.write(`\rRead ${done} of ${total} …`),
    concurrency: batchReader ? tickets.length : 4,
  });
  process.stdout.write('\n');

  const cost = fake
    ? 'Cost: $0 (fake reader).'
    : `Cost${args.batch ? ' (batch, half price)' : ''}: about $${spent().toFixed(2)} for ${tickets.length} ticket(s) ($${(spent() / Math.max(1, tickets.length)).toFixed(3)} per ticket).`;
  const text = formatReport(report, cost);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const out = join('scan-output', `poc-${stamp}`);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'report.txt'), text + '\n');
  writeFileSync(join(out, 'mistakes.csv'), mistakesCsv(report));
  writeFileSync(
    join(out, 'readings.json'),
    JSON.stringify(graded, (k, v) => (k === 'image' || k === 'crops' ? undefined : v), 2),
  );
  console.log('\n' + text);
  console.log(`\nSaved to ${out}/ (report.txt, mistakes.csv, readings.json).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const status = (error as { status?: number }).status;
    console.error(
      status === 401 ? 'The API key was refused. Check ANTHROPIC_API_KEY in .env.' : error,
    );
    process.exit(1);
  });
}
