// Pipeline step 2 (section 4), run by the worker: each page of an upload becomes a page image and
// a ticket waiting to be read; then the file as uploaded is deleted, since one upload can hold
// tickets of two months and each page is deleted with its own month.
import { Injectable } from '@nestjs/common';
import { imageToJpeg, pdfPageToJpeg } from '@tally/shared/imaging';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fromPrisma, PgBoss } from 'pg-boss';
import { PrismaClient } from '../generated/prisma/client.ts';
import { READ_TICKET } from '../queue.ts';
import { Storage, saveTo } from '../storage.ts';

@Injectable()
export class Splitter {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly boss: PgBoss,
    private readonly storage: Storage,
  ) {}

  /** Safe to run again after a crash: pages already stored are skipped. */
  async split(uploadId: string) {
    const upload = await this.prisma.upload.findUnique({
      where: { id: uploadId },
      include: { tickets: { select: { pageIndex: true } } },
    });
    const original = upload?.s3KeyOriginal;
    if (!upload || !original) return; // already split
    const done = new Set(upload.tickets.map((t) => t.pageIndex));
    const pages = upload.pageCount!;

    if (done.size < pages) {
      const dir = await mkdtemp(join(tmpdir(), 'tally-split-'));
      try {
        const file = await this.storage.get(original);
        if (!file) throw new Error(`The file of upload ${uploadId} is missing from storage.`);
        const path = join(dir, 'file');
        await saveTo(file.body, path);
        for (let pageIndex = 0; pageIndex < pages; pageIndex++) {
          if (done.has(pageIndex)) continue;
          const image =
            upload.mime === 'application/pdf'
              ? await pdfPageToJpeg(path, pageIndex)
              : await imageToJpeg(await readFile(path));
          const s3KeyPage = `pages/${uploadId}/${pageIndex}.jpg`;
          await this.storage.put(s3KeyPage, image, 'image/jpeg');
          await this.prisma.$transaction(async (tx) => {
            const ticket = await tx.ticket.create({ data: { uploadId, pageIndex, s3KeyPage } });
            await this.boss.send(READ_TICKET, { ticketId: ticket.id }, { db: fromPrisma(tx) });
          });
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
    await this.prisma.upload.update({ where: { id: uploadId }, data: { s3KeyOriginal: null } });
    // shortcut: a crash between these two lines leaves the file in storage; the bucket's rule for
    // uploads/ deletes it after 2 days (section 12).
    await this.storage.remove(original);
  }
}
