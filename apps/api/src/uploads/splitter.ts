// Pipeline step 2 (section 4), run by the worker: each page of an upload becomes a page image and
// a ticket waiting to be read; then the file as uploaded is deleted, since one upload can hold
// tickets of two months and each page is deleted with its own month. Then the upload is queued
// to be read.
import { Injectable, Logger } from '@nestjs/common';
import { MAX_UPLOAD_BYTES } from '@tally/shared';
import { imageToJpeg, pdfPageToJpeg } from '@tally/shared/imaging';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fromPrisma, PgBoss } from 'pg-boss';
import { PrismaClient } from '../generated/prisma/client.ts';
import { READ_UPLOAD } from '../queue.ts';
import { Storage, saveTo } from '../storage.ts';

/** A split stops in good time before its job expires (30 minutes, queue.ts), page by page. */
const SPLIT_DEADLINE_MS = 25 * 60_000;

@Injectable()
export class Splitter {
  private readonly log = new Logger(Splitter.name);

  constructor(
    private readonly prisma: PrismaClient,
    private readonly boss: PgBoss,
    private readonly storage: Storage,
  ) {}

  /**
   * Safe to run again after a crash: pages already stored are skipped. One page that cannot be
   * turned into an image does not stop the others (principle 4): it is tried again with the job,
   * and on the last attempt it is recorded on the upload so the user can scan it again.
   */
  async split(
    uploadId: string,
    { lastAttempt, deadlineMs = SPLIT_DEADLINE_MS }: { lastAttempt: boolean; deadlineMs?: number },
  ) {
    const stopAt = Date.now() + deadlineMs;
    const upload = await this.prisma.upload.findUnique({
      where: { id: uploadId },
      include: { tickets: { select: { pageIndex: true } } },
    });
    const original = upload?.s3KeyOriginal;
    if (!upload || !original) return; // already split
    const done = new Set(upload.tickets.map((t) => t.pageIndex));
    const pages = upload.pageCount!;
    const failed: number[] = [];
    let replaced = false;

    if (done.size < pages) {
      const dir = await mkdtemp(join(tmpdir(), 'tally-split-'));
      try {
        const file = await this.storage.get(original);
        if (!file) throw new Error(`The file of upload ${uploadId} is missing from storage.`);
        const path = join(dir, 'file');
        // Only the file that passed the checks at upload is split (section 4): its signed upload
        // link works for a few minutes, so another file could have been put in its place.
        replaced = file.size > MAX_UPLOAD_BYTES;
        if (replaced) file.body.destroy();
        else replaced = (await saveTo(file.body, path)) !== upload.sha256;
        if (replaced) this.log.warn(`Upload ${uploadId}: the file changed after it was checked.`);
        for (let pageIndex = 0; pageIndex < pages; pageIndex++) {
          if (done.has(pageIndex)) continue;
          // Out of time: the rest wait for the next attempt (pages done are kept), or fail.
          if (replaced || Date.now() >= stopAt) {
            failed.push(pageIndex);
            continue;
          }
          try {
            const image =
              upload.mime === 'application/pdf'
                ? await pdfPageToJpeg(path, pageIndex)
                : await imageToJpeg(await readFile(path));
            const s3KeyPage = `pages/${uploadId}/${pageIndex}.jpg`;
            await this.storage.put(s3KeyPage, image, 'image/jpeg');
            await this.prisma.ticket.create({ data: { uploadId, pageIndex, s3KeyPage } });
          } catch (e) {
            this.log.warn(`Upload ${uploadId}, page ${pageIndex + 1}: ${(e as Error).message}`);
            failed.push(pageIndex);
          }
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
    // A replaced file is not tried again: it would fail the same way.
    if (failed.length > 0 && !lastAttempt && !replaced) {
      throw new Error(`Upload ${uploadId}: ${failed.length} page(s) failed; trying again.`);
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.upload.update({
        where: { id: uploadId },
        data: { s3KeyOriginal: null, failedPages: failed },
      });
      await this.boss.send(READ_UPLOAD, { uploadId }, { db: fromPrisma(tx) });
    });
    // shortcut: a crash between these two steps leaves the file in storage; the bucket's rule for
    // uploads/ deletes it after 2 days (section 12).
    await this.storage.remove(original);
  }
}
