// Pipeline steps 3–7 (section 4), run by the worker for one upload at a time: the second look at
// names (6a) needs every ticket of the upload read first, and batch mode sends each round of the
// whole upload as one batch.
import { Injectable } from '@nestjs/common';
import { type ExtractionResult, type Flag, TEMPLATE_V1 } from '@tally/shared';
import {
  type BatchItem,
  type ReadTicket,
  type TicketExtractor,
  readBatch,
  withRetries,
} from '@tally/shared/extraction';
import { prepareTicket } from '@tally/shared/imaging';
import { createHash } from 'node:crypto';
import { Prisma, PrismaClient } from '../generated/prisma/client.ts';
import { monthOf } from '../months/months.service.ts';
import { Storage } from '../storage.ts';
import { ReadingConfig } from './config.ts';

/** Readings at once for an upload read straight away (section 10: concurrency 4). */
const CONCURRENCY = 4;

@Injectable()
export class Reader {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly storage: Storage,
    private readonly config: ReadingConfig,
  ) {}

  /** Safe to run again after a crash: saved tickets are skipped, saved answers are reused. */
  async read(uploadId: string) {
    const upload = await this.prisma.upload.findUnique({
      where: { id: uploadId },
      include: { tickets: { where: { status: 'processing' }, orderBy: { pageIndex: 'asc' } } },
    });
    if (!upload || upload.tickets.length === 0) return;

    const lists = await this.prisma.listEntry.findMany();
    const placeOf = new Map<string, string>();
    for (const l of lists.filter((l) => l.kind === 'workplace')) {
      for (const s of [l.name, ...l.spellings]) placeOf.set(s, l.name);
    }
    const knownNames = lists
      .filter((l) => l.kind === 'name')
      .flatMap((l) => [l.name, ...l.spellings]);

    const items: BatchItem[] = [];
    for (const t of upload.tickets) {
      const page = await this.storage.get(t.s3KeyPage);
      if (!page) throw new Error(`The page image of ticket ${t.id} is missing from storage.`);
      // Step 3: find the corner markers, straighten, measure sharpness and brightness.
      const prepared = await prepareTicket(Buffer.concat(await page.body.toArray()), TEMPLATE_V1);
      items.push({
        input: { id: t.id, image: prepared.ticket, crops: prepared.crops },
        imageFlags: prepared.flags,
      });
    }

    const batch = upload.speed === 'batch';
    const reads = await readBatch(items, {
      extractor: this.saved(
        withRetries(this.config.extractor(upload.speed), {
          firstWaitMs: this.config.firstRetryWaitMs,
        }),
      ),
      template: TEMPLATE_V1,
      settings: this.config.settings(),
      knownWorkplaces: [...placeOf.keys()],
      knownNames,
      concurrency: batch ? items.length : CONCURRENCY,
    });
    for (const r of reads) await this.save(r, placeOf);
  }

  /**
   * Keeps every answer as it arrives, and gives back a kept answer instead of asking again, so a
   * job restarted after a crash pays for no reading twice (D43).
   */
  private saved(extractor: TicketExtractor): TicketExtractor {
    return {
      extract: async (input, template, pass) => {
        const listsKey = createHash('sha256')
          .update(JSON.stringify([input.knownWorkplaces ?? [], input.knownNames ?? []]))
          .digest('hex');
        const where = { ticketId_pass_listsKey: { ticketId: input.id, pass, listsKey } };
        const kept = await this.prisma.reading.findUnique({ where });
        if (kept) {
          return {
            result: kept.answer as unknown as ExtractionResult,
            model: kept.model,
            promptVersion: kept.promptVersion,
            usage: { inputTokens: 0, outputTokens: 0 }, // already paid for
          };
        }
        const r = await extractor.extract(input, template, pass);
        await this.prisma.reading.createMany({
          data: [
            {
              ticketId: input.id,
              pass,
              listsKey,
              answer: r.result as unknown as Prisma.InputJsonValue,
              model: r.model,
              promptVersion: r.promptVersion,
              inputTokens: r.usage.inputTokens,
              outputTokens: r.usage.outputTokens,
            },
          ],
          skipDuplicates: true,
        });
        return r;
      },
    };
  }

  /** Steps 6c and 7 for one ticket, in one transaction. */
  private async save(r: ReadTicket, placeOf: ReadonlyMap<string, string>) {
    const c = r.checked;
    const flags: Flag[] = c
      ? [...c.flags]
      : [{ code: 'EXTRACTION_ERROR', detail: { error: r.error } }];
    await this.prisma.$transaction(async (tx) => {
      // 6c: a ticket whose date is settled joins its month; one with any doubt about the date
      // waits outside any month until a person confirms it.
      let monthId: string | null = null;
      if (c?.fields.shiftDate && !flags.some((f) => f.field === 'date')) {
        const month = await monthOf(tx, new Date(c.fields.shiftDate));
        if (month.status === 'open') monthId = month.id;
        else
          flags.push({
            code: 'MONTH_CLOSED',
            field: 'date',
            detail: { year: month.year, month: month.month },
          });
      }
      const status = !c
        ? 'needs_manual_entry'
        : flags.length > 0 || this.config.reviewEverything
          ? 'needs_review'
          : 'verified';
      const workplace = c?.fields.workplace ?? null;
      const saved = await tx.ticket.updateMany({
        where: { id: r.id, status: 'processing' }, // a ticket is saved once
        data: {
          monthId,
          templateVersion: TEMPLATE_V1.version,
          firstName: c?.fields.firstName ?? null,
          // A list spelling ("Dolev") stands for its place, named in Hebrew (D36).
          workplaceRaw:
            workplace && c?.workplaceFromList ? (placeOf.get(workplace) ?? workplace) : workplace,
          shiftDate: c?.fields.shiftDate ? new Date(c.fields.shiftDate) : null,
          startMinutes: c?.fields.startMinutes ?? null,
          endMinutes: c?.fields.endMinutes ?? null,
          totalMinutes: c?.fields.totalMinutes ?? null,
          totalFromMath: c?.totalFromMath ?? false,
          status,
          verifiedHow: status === 'verified' ? 'auto' : null,
        },
      });
      if (saved.count === 0) return;
      await tx.flag.createMany({
        data: flags.map((f) => ({
          ticketId: r.id,
          code: f.code,
          field: f.field ?? null,
          detail: (f.detail ?? {}) as Prisma.InputJsonValue,
        })),
      });
    });
  }
}
