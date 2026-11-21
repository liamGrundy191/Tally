// Pipeline step 2 (section 4), run by the worker: each page of an upload becomes a page image and
// a ticket waiting to be read; then the file as uploaded is deleted, since one upload can hold
// tickets of two months and each page is deleted with its own month. Then the upload is queued
// to be read.
import { Injectable, Logger } from '@nestjs/common';
import { imageToJpeg, pdfPageToJpeg } from '@tally/shared/imaging';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fromPrisma, PgBoss } from 'pg-boss';
import { PrismaClient } from '../generated/prisma/client.ts';
import { READ_UPLOAD } from '../queue.ts';
import { Storage, saveTo } from '../storage.ts';

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
  async split(uploadId: string, { lastAttempt }: { lastAttempt: boolean }) {
    const upload = await this.prisma.upload.findUnique({
      where: { id: uploadId },
      include: { tickets: { select: { pageIndex: true } } },
    });
    const original = upload?.s3KeyOriginal;
    if (!upload || !original) return; // already split
    const done = new Set(upload.tickets.map((t) => t.pageIndex));
    const pages = upload.pageCount!;
    const failed: number[] = [];

    if (done.size < pages) {
      const dir = await mkdtemp(join(tmpdir(), 'tally-split-'));
      try {
        const file = await this.storage.get(original);
        if (!file) throw new Error(`The file of upload ${uploadId} is missing from storage.`);
        const path = join(dir, 'file');
        await saveTo(file.body, path);
        for (let pageIndex = 0; pageIndex < pages; pageIndex++) {
          if (done.has(pageIndex)) continue;
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
    if (failed.length > 0 && !lastAttempt) {
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
