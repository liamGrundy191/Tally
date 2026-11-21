// T1.3 "Done when": a PDF and an image uploaded to file storage are queued; a duplicate file is
// detected. Plus the intake checks (section 4, step 1), splitting into page images (step 2) and
// the signed upload links (section 11). Runs the real API and worker against a throwaway database
// schema and file storage bucket.
import type { INestApplication } from '@nestjs/common';
import { PDFDocument } from 'pdf-lib';
import { PgBoss } from 'pg-boss';
import type { UploadResult } from '@tally/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { READ_UPLOAD, SPLIT_UPLOAD } from '../src/queue.ts';
import { createAdmin } from '../src/users/create-admin.ts';
import { startWorker } from '../src/worker.ts';
import { Browser } from './helpers/browser.ts';
import { testApp } from './helpers/test-app.ts';
import { databaseUrl, testDatabase } from './helpers/test-db.ts';
import { storageConfigured, testStorage } from './helpers/test-storage.ts';

const OWNER = { email: 'owner@example.com', password: 'owner password 1' };

async function pdf(pages: number) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([446, 210]); // a slip, 157.5 × 74.25 mm
  return doc.save();
}
// The smallest PNG: one white pixel.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC',
  'base64',
);

async function until<T>(check: () => Promise<T | null | undefined | false>, ms = 30_000) {
  for (const end = Date.now() + ms; Date.now() < end;) {
    const result = await check();
    if (result) return result;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('Timed out waiting.');
}

describe.skipIf(!databaseUrl || !storageConfigured)('uploading scans (T1.3)', () => {
  const db = testDatabase();
  const prisma = db.prisma;
  const files = testStorage();
  let app: INestApplication;
  let owner: Browser;
  let base: string;
  let twoPages: Uint8Array;

  const sign = async (b = owner) =>
    (await b.send('POST', '/api/uploads/sign', { count: 1 })).body[0] as {
      key: string;
      url: string;
    };
  const complete = async (key: string, name: string) =>
    (
      (await owner.send('POST', '/api/uploads/complete', { files: [{ key, name }] }))
        .body as UploadResult[]
    )[0]!;
  async function upload(name: string, data: Uint8Array) {
    const { key, url } = await sign();
    expect((await fetch(url, { method: 'PUT', body: data })).status).toBe(200);
    return complete(key, name);
  }
  /** Uploads a file that must be refused, and checks that it is not kept. */
  async function refused(name: string, data: Uint8Array) {
    const result = await upload(name, data);
    expect(result.status).toBe('rejected');
    expect(await files.keys()).not.toContain(result.key);
    return result;
  }
  const jobs = (queue: string) => app.get(PgBoss).findJobs<Record<string, string>>(queue);

  beforeAll(async () => {
    await Promise.all([db.migrate(), files.create()]);
    await createAdmin(prisma, OWNER.email, OWNER.password);
    ({ app, base } = await testApp(db, { storage: files.storage }));
    owner = new Browser(base);
    await owner.login(OWNER.email, OWNER.password);
    twoPages = await pdf(2);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await files.drop();
    await db.drop();
  });

  it('needs a login', async () => {
    const stranger = new Browser(base);
    expect((await stranger.send('POST', '/api/uploads/sign', { count: 1 })).status).toBe(401);
    expect(
      (await stranger.send('POST', '/api/uploads/complete', { files: [] }, { csrf: 'x' })).status,
    ).toBe(401);
  });

  it('uploads a PDF and a photo to file storage and queues each one', async () => {
    const scan = await upload('week 1.pdf', twoPages);
    const photo = await upload('photo.png', PNG);
    expect(scan).toMatchObject({ status: 'queued', pages: 2 });
    expect(photo).toMatchObject({ status: 'queued', pages: 1 });
    const uploads = await prisma.upload.findMany({ orderBy: { createdAt: 'asc' } });
    expect(uploads.map((u) => [u.originalFilename, u.mime, u.pageCount])).toEqual([
      ['week 1.pdf', 'application/pdf', 2],
      ['photo.png', 'image/png', 1],
    ]);
    expect(uploads.every((u) => /^[0-9a-f]{64}$/.test(u.sha256))).toBe(true);
    const queued = await jobs(SPLIT_UPLOAD);
    expect(queued.map((j) => j.data.uploadId).sort()).toEqual(uploads.map((u) => u.id).sort());
  });

  it('splits each file into one ticket per page, deletes the file and queues it to be read', async () => {
    await startWorker(app);
    await until(async () => (await prisma.upload.count({ where: { s3KeyOriginal: null } })) === 2);
    const tickets = await prisma.ticket.findMany({
      include: { upload: true },
      orderBy: [{ upload: { createdAt: 'asc' } }, { pageIndex: 'asc' }],
    });
    expect(
      tickets.map((t) => [t.upload.originalFilename, t.pageIndex, t.status, t.monthId]),
    ).toEqual([
      ['week 1.pdf', 0, 'processing', null],
      ['week 1.pdf', 1, 'processing', null],
      ['photo.png', 0, 'processing', null],
    ]);
    // Only the page images are kept: the file as uploaded is deleted (step 2).
    expect(await files.keys()).toEqual(tickets.map((t) => t.s3KeyPage).sort());
    const page = await files.storage.get(tickets[0]!.s3KeyPage);
    const bytes = Buffer.concat(await page!.body.toArray());
    expect([...bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]); // a JPEG
    // Each upload is then queued to be read, as a whole (T1.4).
    const reads = await jobs(READ_UPLOAD);
    expect(reads.map((j) => j.data.uploadId).sort()).toEqual(
      [...new Set(tickets.map((t) => t.uploadId))].sort(),
    );
  });

  it('detects a file uploaded again and does not read it twice', async () => {
    const again = await upload('week 1 again.pdf', twoPages);
    expect(again).toMatchObject({ status: 'duplicate' });
    expect(again).toHaveProperty(
      'message',
      expect.stringMatching(/already uploaded on .*"week 1\.pdf"/),
    );
    expect(await prisma.upload.count()).toBe(2);
    expect((await files.keys()).filter((k) => k.startsWith('uploads/'))).toEqual([]);
  });

  it('gives the same answer when a file is confirmed twice', async () => {
    const { key, url } = await sign();
    await fetch(url, { method: 'PUT', body: await pdf(3) });
    const first = await complete(key, 'three.pdf');
    expect(first).toMatchObject({ status: 'queued', pages: 3 });
    expect(await complete(key, 'three.pdf')).toEqual(first);
    expect(await prisma.upload.count({ where: { originalFilename: 'three.pdf' } })).toBe(1);
  });

  it('refuses a file that is not a PDF, JPEG or PNG, whatever its name', async () => {
    expect(await refused('notes.pdf', Buffer.from('not a scan'))).toEqual({
      key: expect.any(String),
      status: 'rejected',
      message: 'Only PDF, JPEG and PNG files can be read.',
    });
  });

  it('refuses a damaged file', async () => {
    expect(await refused('broken.pdf', Buffer.from('%PDF-1.7 cut short'))).toMatchObject({
      status: 'rejected',
      message: 'This file could not be opened. It may be damaged.',
    });
  });

  it('refuses a PDF of more than 300 pages', async () => {
    expect(await refused('huge.pdf', await pdf(301))).toMatchObject({
      status: 'rejected',
      message: 'This PDF has 301 pages. At most 300 can be read at once: please split it.',
    });
  });

  it('refuses a file over 50 MB', async () => {
    expect(await refused('big.pdf', Buffer.alloc(50 * 1024 * 1024 + 1))).toMatchObject({
      status: 'rejected',
      message: 'This file is larger than 50 MB. Please split it into smaller files.',
    });
  }, 60_000);

  it('says when a file never arrived', async () => {
    const { key } = await sign();
    expect(await complete(key, 'lost.pdf')).toMatchObject({
      status: 'rejected',
      message: 'This file did not arrive. Please upload it again.',
    });
  });

  it('signs a link for 5 minutes and for one file only (section 11)', async () => {
    const { key, url } = await sign();
    expect(key).toMatch(/^uploads\/[0-9a-f-]{36}$/);
    expect(new URL(url).searchParams.get('X-Amz-Expires')).toBe('300');
    const elsewhere = url.replace(key, 'uploads/00000000-0000-4000-8000-000000000000');
    expect((await fetch(elsewhere, { method: 'PUT', body: PNG })).status).toBe(403);
  });

  it('refuses a key it did not give out', async () => {
    const res = await owner.send('POST', '/api/uploads/complete', {
      files: [{ key: 'pages/x/0.jpg', name: 'a.pdf' }],
    });
    expect(res).toMatchObject({
      status: 400,
      body: { message: 'That file was not uploaded here.' },
    });
  });
});
