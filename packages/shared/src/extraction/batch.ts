// Batch mode (D26, D34): the same requests as AnthropicExtractor, sent through Anthropic's Message
// Batches API at half the price. Results come back within 24 hours, usually within an hour.
import Anthropic from '@anthropic-ai/sdk';
import type { TicketTemplate } from '../templates/v1.ts';
import { toSuccess } from './anthropic.ts';
import {
  DEFAULT_EFFORT,
  type Effort,
  type ExtractionInput,
  type ExtractionPass,
  type ExtractionSuccess,
  ExtractionError,
  type TicketExtractor,
  buildRequest,
  withCache,
} from './extractor.ts';

/**
 * Requests sharing their start (the same pass and lists) are cached when at least this many are in
 * one batch (D65): a 1-hour cache write costs twice the normal price and each hit saves 95%, so it
 * pays from the second hit on.
 */
export const MIN_SHARED_FOR_CACHE = 3;

interface Pending {
  id: string;
  input: ExtractionInput;
  params: ReturnType<typeof buildRequest>;
  resolve: (r: ExtractionSuccess) => void;
  reject: (e: unknown) => void;
}

export interface BatchStatus {
  batchId: string;
  requests: number;
  done: number;
  state: 'sent' | 'waiting' | 'ended';
}

/**
 * Collects every `extract` call made close together into one batch. readBatch asks for a whole
 * round at once (passes A and B for every ticket, then pass C, then the second look), so each
 * round becomes one batch. A request that fails comes back as a failed attempt, like a failed call.
 */
export class AnthropicBatchExtractor implements TicketExtractor {
  private readonly model: string;
  private readonly client: Anthropic;
  private readonly effort: Effort;
  private readonly pollMs: number;
  private readonly gatherMs: number;
  private readonly onStatus?: (s: BatchStatus) => void;
  private queue: Pending[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private counter = 0;
  private readonly running = new Set<string>();
  private cancelled = false;

  constructor(opts: {
    model: string;
    client?: Anthropic;
    effort?: Effort;
    /** How often to ask whether a batch has finished. */
    pollMs?: number;
    /** How long to wait for more requests before sending a batch. */
    gatherMs?: number;
    onStatus?: (s: BatchStatus) => void;
  }) {
    this.model = opts.model;
    this.client = opts.client ?? new Anthropic();
    this.effort = opts.effort ?? DEFAULT_EFFORT;
    this.pollMs = opts.pollMs ?? 30_000;
    this.gatherMs = opts.gatherMs ?? 2_000;
    this.onStatus = opts.onStatus;
  }

  extract(
    input: ExtractionInput,
    template: TicketTemplate,
    pass: ExtractionPass,
  ): Promise<ExtractionSuccess> {
    return new Promise((resolve, reject) => {
      // custom_id must be short and plain, so requests are numbered rather than named.
      const id = `r${++this.counter}`;
      this.queue.push({
        id,
        input,
        params: buildRequest(input, template, pass, this.model, this.effort),
        resolve,
        reject,
      });
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.send(), this.gatherMs);
    });
  }

  /** Cancels every batch still running, e.g. when the program is stopped, so it stops costing. */
  async cancelAll(): Promise<void> {
    this.cancelled = true; // and no batch is sent after this
    await Promise.allSettled(
      [...this.running].map((id) => this.client.messages.batches.cancel(id)),
    );
  }

  private async send(): Promise<void> {
    const group = this.queue;
    this.queue = [];
    this.timer = null;
    if (group.length === 0) return;
    // Caching in batches (D65): one request per shared start is read straight away first and
    // writes the 1-hour cache, then the batch reads it. Hits in a batch are still best-effort.
    // Straight away rather than as a batch of one: that would add a whole batch's wait per round.
    const byStart = new Map<string, Pending[]>();
    for (const p of group) {
      const key = JSON.stringify([
        p.params.system,
        p.params.messages[0]!.content[0],
        p.params.output_config,
      ]);
      byStart.set(key, [...(byStart.get(key) ?? []), p]);
    }
    const first: Pending[] = [];
    for (const shared of byStart.values()) {
      if (shared.length < MIN_SHARED_FOR_CACHE) continue;
      for (const p of shared) p.params = withCache(p.params, '1h');
      first.push(shared[0]!);
    }
    await Promise.all(first.map((p) => this.now(p)));
    await this.run(group.filter((p) => !first.includes(p)));
  }

  /** One request read straight away, at the full price; its answer is used like any other. */
  private async now(p: Pending): Promise<void> {
    try {
      const message = await this.client.messages.create(
        p.params as Anthropic.MessageCreateParamsNonStreaming,
      );
      p.resolve(toSuccess(message, parseAnswer(message), p.input));
    } catch (error) {
      p.reject(error); // an API error is retried by the caller; a bad answer is a failed attempt
    }
  }

  private async run(group: Pending[]): Promise<void> {
    if (group.length === 0) return;
    if (this.cancelled) {
      for (const p of group)
        p.reject(new ExtractionError('invalid_output', 'Reading was stopped.'));
      return;
    }
    const byId = new Map(group.map((p) => [p.id, p]));
    try {
      const batch = await this.client.messages.batches.create({
        requests: group.map((p) => ({ custom_id: p.id, params: p.params })),
      });
      this.running.add(batch.id);
      this.onStatus?.({ batchId: batch.id, requests: group.length, done: 0, state: 'sent' });
      let status = batch;
      while (status.processing_status !== 'ended') {
        await new Promise((r) => setTimeout(r, this.pollMs));
        status = await this.client.messages.batches.retrieve(batch.id);
        const c = status.request_counts;
        const done = c.succeeded + c.errored + c.canceled + c.expired;
        this.onStatus?.({ batchId: batch.id, requests: group.length, done, state: 'waiting' });
      }
      this.running.delete(batch.id);
      this.onStatus?.({
        batchId: batch.id,
        requests: group.length,
        done: group.length,
        state: 'ended',
      });
      for await (const item of await this.client.messages.batches.results(batch.id)) {
        const p = byId.get(item.custom_id);
        if (!p) continue;
        byId.delete(item.custom_id);
        const r = item.result;
        if (r.type !== 'succeeded') {
          p.reject(new ExtractionError('invalid_output', `The batch request ${r.type}.`));
          continue;
        }
        try {
          p.resolve(toSuccess(r.message, parseAnswer(r.message), p.input));
        } catch (error) {
          p.reject(error);
        }
      }
    } catch (error) {
      for (const p of byId.values()) p.reject(error); // e.g. the key was refused: the caller decides
      return;
    }
    for (const p of byId.values()) {
      p.reject(
        new ExtractionError('invalid_output', 'The batch returned no result for this request.'),
      );
    }
  }
}

/** The JSON answer in the message's text, or null when there is none or it does not parse. */
function parseAnswer(message: Anthropic.Message): unknown {
  const text = message.content.find((b) => b.type === 'text');
  if (!text || text.type !== 'text') return null;
  try {
    return JSON.parse(text.text);
  } catch {
    return null;
  }
}
