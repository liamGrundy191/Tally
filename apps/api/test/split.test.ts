// Step 2, splitting an upload into tickets: safe to run again after a crash, and one page that
// fails does not lose the others (principle 4). The splitter is called directly, without the
// worker, so each test controls exactly what has happened before.
import type { INestApplication } from '@nestjs/common';
import type { UploadResult } from '@tally/shared';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { READ_UPLOAD } from '../src/queue.ts';
import { Storage } from '../src/storage.ts';
import { Splitter } from '../src/uploads/splitter.ts';
import { createAdmin } from '../src/users/create-admin.ts';
import { Browser } from './helpers/browser.ts';
import { slipsPdf } from './helpers/slips.ts';
import { testApp } from './helpers/test-app.ts';
import { databaseUrl, testDatabase } from './helpers/test-db.ts';
import { storageConfigured, testStorage } from './helpers/test-storage.ts';

const OWNER = { email: 'owner@example.com', password: 'owner password 1' };

/** Storage where saving a chosen page image fails, as a full disk or a lost connection would. */
class FlakyStorage extends Storage {
  failing = new Set<string>();
  override async put(key: string, body: Buffer, contentType: string) {
    if (this.failing.has(key)) throw new Error('storage unavailable');
    return super.put(key, body, contentType);
  }
}

describe.skipIf(!databaseUrl || !storageConfigured)('splitting an upload (step 2)', () => {
  const db = testDatabase();
  const prisma = db.prisma;
  const files = testStorage();
  const storage = new FlakyStorage(files.storage.s3, files.storage.bucket);
  let app: INestApplication;
  let owner: Browser;
  const split = (id: string, lastAttempt = false) => app.get(Splitter).split(id, { lastAttempt });

  async function upload(name: string, pages: number) {
    const [{ key, url }] = (await owner.send('POST', '/api/uploads/sign', { count: 1 })).body;
    await fetch(url, { method: 'PUT', body: await slipsPdf(pages, name) });
    const { body } = await owner.send('POST', '/api/uploads/complete', {
      files: [{ key, name }],
    });
    return (body as UploadResult[])[0] as { uploadId: string };
  }
  const pagesOf = async (uploadId: string) =>
    (await prisma.ticket.findMany({ where: { uploadId }, orderBy: { pageIndex: 'asc' } })).map(
      (t) => t.pageIndex,
    );
  const readJobs = async (uploadId: string) =>
    (await app.get(PgBoss).findJobs<{ uploadId: string }>(READ_UPLOAD)).filter(
      (j) => j.data.uploadId === uploadId,
    ).length;

  beforeAll(async () => {
    await Promise.all([db.migrate(), files.create()]);
    await createAdmin(prisma, OWNER.email, OWNER.password);
    let base: string;
    ({ app, base } = await testApp(db, { storage }));
    owner = new Browser(base);
    await owner.login(OWNER.email, OWNER.password);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await files.drop();
    await db.drop();
  });

  it('carries on after a crash, skipping the pages already stored', async () => {
    const { uploadId } = await upload('crash.pdf', 3);
    // The first run stored page 0 and its ticket, then the worker died.
    await storage.put(`pages/${uploadId}/0.jpg`, Buffer.from('x'), 'image/jpeg');
    await prisma.ticket.create({
      data: { uploadId, pageIndex: 0, s3KeyPage: `pages/${uploadId}/0.jpg` },
    });
    await split(uploadId);
    expect(await pagesOf(uploadId)).toEqual([0, 1, 2]);
    expect(await prisma.upload.findUnique({ where: { id: uploadId } })).toMatchObject({
      s3KeyOriginal: null,
      failedPages: [],
    });
    expect((await files.keys()).filter((k) => k.startsWith('uploads/'))).toEqual([]);
    expect(await readJobs(uploadId)).toBe(1);
  });

  it('does nothing for an upload already split', async () => {
    const { uploadId } = await upload('twice.pdf', 1);
    await split(uploadId);
    await split(uploadId);
    expect(await pagesOf(uploadId)).toEqual([0]);
    expect(await readJobs(uploadId)).toBe(1);
  });

  it('does not lose the other pages when one fails, and records it on the last attempt', async () => {
    const { uploadId } = await upload('flaky.pdf', 3);
    storage.failing.add(`pages/${uploadId}/1.jpg`);
    // Not the last attempt: the job fails so it is tried again, keeping the pages that worked.
    await expect(split(uploadId)).rejects.toThrow(/1 page\(s\) failed/);
    expect(await pagesOf(uploadId)).toEqual([0, 2]);
    expect(await readJobs(uploadId)).toBe(0);
    // The last attempt: the rest is read, and the user can be told to scan page 2 again.
    await split(uploadId, true);
    expect(await prisma.upload.findUnique({ where: { id: uploadId } })).toMatchObject({
      s3KeyOriginal: null,
      failedPages: [1],
    });
    expect(await readJobs(uploadId)).toBe(1);
  });

  it('stops when its time is up, before the job would expire (T4.1)', async () => {
    const { uploadId } = await upload('slow.pdf', 2);
    const splitter = app.get(Splitter);
    // Out of time: the job is tried again, keeping any page already stored.
    await expect(splitter.split(uploadId, { lastAttempt: false, deadlineMs: 0 })).rejects.toThrow(
      /2 page\(s\) failed/,
    );
    expect(await pagesOf(uploadId)).toEqual([]);
    // On the last attempt the pages are recorded as failed and the upload finishes as usual.
    await splitter.split(uploadId, { lastAttempt: true, deadlineMs: 0 });
    expect(await prisma.upload.findUnique({ where: { id: uploadId } })).toMatchObject({
      s3KeyOriginal: null,
      failedPages: [0, 1],
    });
    expect(await readJobs(uploadId)).toBe(1);
  });

  it('splits nothing from a file replaced after it was checked (T4.1)', async () => {
    const { uploadId } = await upload('swapped.pdf', 2);
    const { s3KeyOriginal } = await prisma.upload.findUniqueOrThrow({ where: { id: uploadId } });
    // The signed upload link still works for a few minutes: another file is put in its place.
    await storage.put(
      s3KeyOriginal!,
      Buffer.from(await slipsPdf(5, 'other.pdf')),
      'application/pdf',
    );
    await split(uploadId); // not retried: trying again cannot help
    expect(await pagesOf(uploadId)).toEqual([]);
    expect(await prisma.upload.findUnique({ where: { id: uploadId } })).toMatchObject({
      s3KeyOriginal: null,
      failedPages: [0, 1],
    });
    expect(await storage.get(s3KeyOriginal!)).toBeNull();
    expect(await readJobs(uploadId)).toBe(1);
  });
});
