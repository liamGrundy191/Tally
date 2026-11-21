// Uploading scans (section 3, "Request flow"): the browser asks for signed links and sends each
// file straight to storage, then confirms it. Confirming runs the intake checks (step 1) and
// queues the file to be split.
import { Injectable } from '@nestjs/common';
import {
  MAX_PDF_PAGES,
  MAX_UPLOAD_BYTES,
  type ReadSpeed,
  UPLOAD_KEY,
  type UploadResult,
} from '@tally/shared';
import { inspectUpload } from '@tally/shared/imaging';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fromPrisma, PgBoss } from 'pg-boss';
import { audit } from '../audit.ts';
import { Prisma, PrismaClient, type Upload } from '../generated/prisma/client.ts';
import { SPLIT_UPLOAD } from '../queue.ts';
import { Storage, saveTo } from '../storage.ts';

const PROBLEMS = {
  not_supported: 'Only PDF, JPEG and PNG files can be read.',
  damaged: 'This file could not be opened. It may be damaged.',
};

const day = (d: Date) =>
  d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Jerusalem',
  });

const queued = (key: string, u: Upload): UploadResult => ({
  key,
  status: 'queued',
  uploadId: u.id,
  pages: u.pageCount!,
});

@Injectable()
export class UploadsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly boss: PgBoss,
    private readonly storage: Storage,
  ) {}

  /** One upload link per file; each key is new and random (section 11). */
  sign(count: number) {
    return Promise.all(
      Array.from({ length: count }, async () => {
        const key = `uploads/${randomUUID()}`;
        return { key, url: await this.storage.signPut(key) };
      }),
    );
  }

  async complete(userId: string, speed: ReadSpeed, files: { key: string; name: string }[]) {
    const results: UploadResult[] = [];
    for (const f of files) results.push(await this.completeOne(userId, speed, f.key, f.name));
    return results;
  }

  private async completeOne(
    userId: string,
    speed: ReadSpeed,
    key: string,
    name: string,
  ): Promise<UploadResult> {
    const id = UPLOAD_KEY.exec(key)![1]!;
    const done = await this.prisma.upload.findUnique({ where: { id } });
    if (done) return queued(key, done); // confirmed again, e.g. after a lost answer
    const rejected = async (message: string): Promise<UploadResult> => {
      await this.storage.remove(key); // a refused file is not kept
      return { key, status: 'rejected', message };
    };

    const file = await this.storage.get(key);
    if (!file)
      return {
        key,
        status: 'rejected',
        message: 'This file did not arrive. Please upload it again.',
      };
    if (file.size > MAX_UPLOAD_BYTES) {
      file.body.destroy();
      return rejected('This file is larger than 50 MB. Please split it into smaller files.');
    }
    const dir = await mkdtemp(join(tmpdir(), 'tally-upload-'));
    try {
      const path = join(dir, 'file');
      const sha256 = await saveTo(file.body, path);
      const found = await inspectUpload(path);
      if (!found.ok) return await rejected(PROBLEMS[found.problem]);
      if (found.pages > MAX_PDF_PAGES) {
        return await rejected(
          `This PDF has ${found.pages} pages. At most ${MAX_PDF_PAGES} can be read at once: please split it.`,
        );
      }
      try {
        const upload = await this.prisma.$transaction(async (tx) => {
          const upload = await tx.upload.create({
            data: {
              id,
              uploadedById: userId,
              originalFilename: name,
              s3KeyOriginal: key,
              sha256,
              mime: found.mime,
              pageCount: found.pages,
              speed,
            },
          });
          await this.boss.send(SPLIT_UPLOAD, { uploadId: id }, { db: fromPrisma(tx) });
          await audit(tx, {
            userId,
            action: 'upload',
            entity: 'Upload',
            entityId: id,
            after: { mime: found.mime, pages: found.pages, speed },
          });
          return upload;
        });
        return queued(key, upload);
      } catch (e) {
        if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
        const again = await this.prisma.upload.findUnique({ where: { id } });
        if (again) return queued(key, again); // two confirmations of one file at once
        // The same file is already held (step 1): it is not read, or paid for, twice.
        const first = await this.prisma.upload.findUniqueOrThrow({ where: { sha256 } });
        await this.storage.remove(key);
        return {
          key,
          status: 'duplicate',
          message: `This file was already uploaded on ${day(first.createdAt)} as "${first.originalFilename}". It was not read again.`,
        };
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
