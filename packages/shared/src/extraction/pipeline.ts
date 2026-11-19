// Steps 4–6 of plan section 4 for one upload: every ticket is read by passes A and B, pass C
// where they could not settle a field (D27), then unclear names get a second look with the
// upload's clear names (D28). The same code serves the Phase 0 runner and, later, the worker.
import type { ExtractionResult, Flag } from '../rules/schemas.ts';
import {
  type CheckedTicket,
  type RuleSettings,
  batchNameCandidates,
  checkExtraction,
  trustedName,
  unclearFields,
  withRetriedName,
} from '../rules/ticket.ts';
import type { TicketTemplate } from '../templates/v1.ts';
import type { ExtractionInput, ExtractionPass, TicketExtractor } from './extractor.ts';

export interface BatchItem {
  /** The prepared ticket; lists are taken from the batch options. */
  input: ExtractionInput;
  /** Flags from image preparation (MARKERS_NOT_FOUND, IMAGE_BLURRY, IMAGE_DARK). */
  imageFlags: Flag[];
}

export interface ReadTicket {
  id: string;
  /** The checked ticket, including image flags; null when reading failed. */
  checked: CheckedTicket | null;
  /** Why reading failed; the ticket then needs manual entry. */
  error: string | null;
  reads: { A?: ExtractionResult; B?: ExtractionResult; C?: ExtractionResult };
  /** Set when the name got a second look with names from the batch. */
  secondLook: { candidates: string[]; settled: boolean } | null;
}

export interface BatchOptions {
  extractor: TicketExtractor;
  template: TicketTemplate;
  settings: RuleSettings;
  knownWorkplaces?: readonly string[];
  knownNames?: readonly string[];
  /** Tickets read at the same time (plan: worker concurrency 4). */
  concurrency?: number;
  /** Called after every model call, for cost tracking. */
  onRead?: (pass: ExtractionPass, usage: { inputTokens: number; outputTokens: number }) => void;
  /** Checked before every ticket and every second look; false stops spending. */
  canSpend?: () => boolean;
  onTicketDone?: (done: number, total: number) => void;
}

/** A refused API key fails every call, so it stops the whole batch instead of every ticket. */
const isAuthError = (e: unknown) => (e as { status?: number } | null)?.status === 401;
const message = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

export async function readBatch(items: readonly BatchItem[], opts: BatchOptions) {
  const knownWorkplaces = opts.knownWorkplaces ?? [];
  const knownNames = opts.knownNames ?? [];
  const concurrency = opts.concurrency ?? 4;
  const read = async (input: ExtractionInput, pass: ExtractionPass) => {
    const r = await opts.extractor.extract(input, opts.template, pass);
    opts.onRead?.(pass, r.usage);
    return r.result;
  };

  let done = 0;
  const tickets = await mapLimit(items, concurrency, async ({ input }): Promise<ReadTicket> => {
    const out: ReadTicket = {
      id: input.id,
      checked: null,
      error: null,
      reads: {},
      secondLook: null,
    };
    const full = { ...input, knownWorkplaces, knownNames };
    const lists = { knownWorkplaces, knownNames };
    try {
      if (opts.canSpend && !opts.canSpend()) throw new Error('not read: spending cap reached');
      const a = await read(full, 'A');
      const b = await read(full, 'B');
      out.reads = { A: a, B: b };
      out.checked = checkExtraction(a, b, opts.settings, lists);
      if (unclearFields(out.checked).length > 0 && (!opts.canSpend || opts.canSpend())) {
        try {
          const c = await read(full, 'C');
          out.reads.C = c;
          out.checked = checkExtraction(a, b, opts.settings, { ...lists, thirdRead: c });
        } catch (e) {
          // Pass C only improves suggestions; without it the ticket is still fully checked.
          if (isAuthError(e)) throw e;
        }
      }
    } catch (e) {
      if (isAuthError(e)) throw e;
      out.checked = null;
      out.error = message(e);
    }
    opts.onTicketDone?.(++done, items.length);
    return out;
  });

  // Second look at unclear names, once every ticket of the batch has been read (D28).
  const batchNames = [
    ...new Set(
      tickets.flatMap((t) => (t.checked ? [trustedName(t.checked)] : [])).filter((n) => n !== null),
    ),
  ];
  await mapLimit(tickets, concurrency, async (t, i) => {
    const { A: a, B: b } = t.reads;
    if (!t.checked || !a || !b) return;
    const candidates = batchNameCandidates(a, b, t.checked, batchNames, knownNames);
    if (candidates.length === 0 || (opts.canSpend && !opts.canSpend())) return;
    const names = [...knownNames, ...candidates];
    const input = { ...items[i]!.input, knownWorkplaces, knownNames: names };
    try {
      const retry = checkExtraction(await read(input, 'A'), await read(input, 'B'), opts.settings, {
        knownWorkplaces,
        knownNames: names,
      });
      t.checked = withRetriedName(t.checked, retry);
      t.secondLook = { candidates, settled: retry.nameFromList };
    } catch (e) {
      if (isAuthError(e)) throw e;
      t.secondLook = { candidates, settled: false }; // the first reading stands
    }
  });

  for (const [i, t] of tickets.entries()) {
    if (t.checked)
      t.checked = { ...t.checked, flags: [...items[i]!.imageFlags, ...t.checked.flags] };
  }
  return tickets;
}

/** Runs `fn` over `items` with at most `limit` running at once; results keep their order. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
