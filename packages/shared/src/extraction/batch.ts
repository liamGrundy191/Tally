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
} from './extractor.ts';

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
    await Promise.allSettled(
      [...this.running].map((id) => this.client.messages.batches.cancel(id)),
    );
  }

  private async send(): Promise<void> {
    const group = this.queue;
    this.queue = [];
    this.timer = null;
    if (group.length === 0) return;
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
