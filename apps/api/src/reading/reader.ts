// Pipeline steps 3–7 (section 4), run by the worker for one upload at a time: the second look at
// names (6a) needs every ticket of the upload read first, and batch mode sends each round of the
// whole upload as one batch.
import { Injectable } from '@nestjs/common';
import {
  type ExtractionResult,
  type Flag,
  type ReadSpeed,
  TEMPLATE_V1,
  englishName,
  hasHebrew,
  normaliseName,
} from '@tally/shared';
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
import { Organiser } from '../months/organiser.ts';
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
    private readonly organiser: Organiser,
  ) {}

  /**
   * Safe to run again after a crash: saved tickets are skipped, saved answers are reused. A ticket
   * sent to be read again is read straight away (`speed`), whatever its upload's speed.
   */
  async read(uploadId: string, speed?: ReadSpeed) {
    const upload = await this.prisma.upload.findUnique({
      where: { id: uploadId },
      include: { tickets: { where: { status: 'processing' }, orderBy: { pageIndex: 'asc' } } },
    });
    if (!upload) return;
    if (upload.tickets.length > 0) await this.readTickets(upload.tickets, speed ?? upload.speed);
    // Also after a restart that finds every ticket saved: the month may not be organised yet.
    const months = await this.prisma.ticket.findMany({
      where: { uploadId, monthId: { not: null } },
      distinct: ['monthId'],
      select: { monthId: true },
    });
    for (const m of months) await this.organiser.organise(m.monthId!);
  }

  private async readTickets(
    tickets: { id: string; s3KeyPage: string; readRound: number }[],
    speed: ReadSpeed,
  ) {
    const lists = await this.prisma.listEntry.findMany();
    const placeOf = new Map<string, string>();
    for (const l of lists.filter((l) => l.kind === 'workplace')) {
      for (const s of [l.name, ...l.spellings]) placeOf.set(s, l.name);
    }
    const nameEntries = lists.filter((l) => l.kind === 'name');
    const knownNames = nameEntries.flatMap((l) => [l.name, ...l.spellings]);
    // Every spelling of a listed worker gives the English name the Excel uses (5.2).
    // A spelling that two workers share ("יעל = Yael", "יעל = Yaelle") is left out: a person
    // decides which of them a ticket is.
    const englishOf = new Map<string, string>();
    const shared = new Set<string>();
    // A line with no English spelling ("יעל" alone) is named in Hebrew: it helps reading, but
    // gives no English name, so the name is asked (NAME_NOT_CONFIRMED).
    for (const l of nameEntries.filter((l) => !hasHebrew(l.name))) {
      for (const s of [l.name, ...l.spellings]) {
        const key = normaliseName(s);
        if (englishOf.has(key) && englishOf.get(key) !== l.name) shared.add(key);
        englishOf.set(key, l.name);
      }
    }
    for (const key of shared) englishOf.delete(key);

    const items: BatchItem[] = [];
    for (const t of tickets) {
      const page = await this.storage.get(t.s3KeyPage);
      if (!page) throw new Error(`The page image of ticket ${t.id} is missing from storage.`);
      // Step 3: find the corner markers, straighten, measure sharpness and brightness.
      const prepared = await prepareTicket(Buffer.concat(await page.body.toArray()), TEMPLATE_V1);
      items.push({
        input: { id: t.id, image: prepared.ticket, crops: prepared.crops },
        imageFlags: prepared.flags,
      });
    }

    const batch = speed === 'batch';
    const reads = await readBatch(items, {
      extractor: this.saved(
        withRetries(this.config.extractor(speed), {
          firstWaitMs: this.config.firstRetryWaitMs,
        }),
        new Map(tickets.map((t) => [t.id, t.readRound])),
      ),
      template: TEMPLATE_V1,
      settings: this.config.settings(),
      knownWorkplaces: [...placeOf.keys()],
      knownNames,
      concurrency: batch ? items.length : CONCURRENCY,
    });
    for (const r of reads) await this.save(r, placeOf, englishOf);
  }

  /**
   * Keeps every answer as it arrives, and gives back a kept answer instead of asking again, so a
   * job restarted after a crash pays for no reading twice (D43). A ticket sent to be read again
   * starts a new round, which the kept answers of earlier rounds do not answer.
   */
  private saved(extractor: TicketExtractor, rounds: ReadonlyMap<string, number>): TicketExtractor {
    return {
      extract: async (input, template, pass) => {
        const round = rounds.get(input.id) ?? 0;
        const lists = [input.knownWorkplaces ?? [], input.knownNames ?? []];
        const listsKey = createHash('sha256')
          .update(JSON.stringify(round > 0 ? [...lists, round] : lists)) // round 0 keeps its old keys
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
  private async save(
    r: ReadTicket,
    placeOf: ReadonlyMap<string, string>,
    englishOf: ReadonlyMap<string, string>,
  ) {
    const c = r.checked;
    const flags: Flag[] = c
      ? [...c.flags]
      : [{ code: 'EXTRACTION_ERROR', detail: { error: r.error } }];
    // 5.2: the name in English letters, for the worker's Excel row.
    const written = c?.fields.firstName ?? null;
    let workerName: string | null = null;
    if (written) {
      // A name in doubt gets no English spelling yet; the person settles both at once.
      const clear = !flags.some((f) => f.field === 'firstName');
      workerName = !clear
        ? null
        : (englishOf.get(normaliseName(written)) ??
          (hasHebrew(written) ? null : englishName(written)));
      // Without it the ticket has no Excel row, so it is always asked (flags more, assumes less).
      if (!workerName) {
        flags.push({ code: 'NAME_NOT_CONFIRMED', field: 'firstName', detail: { written } });
      }
    }
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
          firstName: written,
          workerName,
          // A list spelling ("Dolev") stands for its place, named in Hebrew (D36).
          workplaceRaw:
            workplace && c?.workplaceFromList ? (placeOf.get(workplace) ?? workplace) : workplace,
          shiftDate: c?.fields.shiftDate ? new Date(c.fields.shiftDate) : null,
          startMinutes: c?.fields.startMinutes ?? null,
          endMinutes: c?.fields.endMinutes ?? null,
          totalMinutes: c?.fields.totalMinutes ?? null,
          totalFromMath: c?.totalFromMath ?? false,
          suggestions: c?.suggestions ?? {},
          status,
          verifiedHow: status === 'verified' ? 'auto' : null,
          version: { increment: 1 }, // a review opened before this reading cannot overwrite it
        },
      });
      if (saved.count === 0) return;
      // Every confirmed name joins the names list, so it keeps up with new workers (5.4).
      if (workerName && !englishOf.has(normaliseName(workerName))) {
        await tx.listEntry.createMany({
          data: [{ kind: 'name', name: workerName }],
          skipDuplicates: true,
        });
      }
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
