// T3.2 "Done when": the workplace PDFs of a month (section 6.3). Every ready ticket's scan is in its
// workplace's PDF, in date order (then name), and no removed, replaced or unready ticket is in any.
// The ZIP is unpacked by .NET (Windows) or Python (CI), readers independent of ours. Names here are invented.
import type { INestApplication } from '@nestjs/common';
import { imageToJpeg, pdfToImages } from '@tally/shared/imaging';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { PDFDict, PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { monthOf } from '../src/months/months.service.ts';
import { fileNames } from '../src/months/pdfs.ts';
import { zip } from '../src/months/zip.ts';
import { createAdmin } from '../src/users/create-admin.ts';
import { Browser } from './helpers/browser.ts';
import { testApp } from './helpers/test-app.ts';
import { databaseUrl, testDatabase } from './helpers/test-db.ts';
import { storageConfigured, testStorage } from './helpers/test-storage.ts';

const OWNER = { email: 'owner@example.com', password: 'owner password 1' };
const MONTH = 'נובמבר 2026';

/** The ZIP's files by name, as another tool unpacks them (Windows' tar.exe cannot write Hebrew names). */
async function unzip(bytes: Buffer) {
  const dir = await mkdtemp(join(tmpdir(), 'tally-zip-'));
  try {
    const [file, out] = [join(dir, 'all.zip'), join(dir, 'out')];
    await writeFile(file, bytes);
    await mkdir(out);
    const run = promisify(execFile);
    if (process.platform === 'win32') {
      const net = 'Add-Type -A System.IO.Compression.FileSystem; [IO.Compression.ZipFile]';
      await run('powershell', [
        '-NoProfile',
        '-Command',
        `${net}::ExtractToDirectory('${file}', '${out}')`,
      ]);
    } else {
      await run('python3', ['-m', 'zipfile', '-e', file, out]);
    }
    const names = await readdir(out);
    return new Map(
      await Promise.all(names.map(async (n) => [n, await readFile(join(out, n))] as const)),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** Each page's scan, in page order, as the SHA-256 of the JPEG embedded unchanged. */
async function pages(pdf: Uint8Array) {
  const doc = await PDFDocument.load(pdf);
  return doc.getPages().map((p) => {
    const images = p.node.Resources()!.lookup(PDFName.of('XObject'), PDFDict);
    expect(images.keys()).toHaveLength(1);
    return sha((doc.context.lookup(images.values()[0]!) as PDFRawStream).contents);
  });
}

describe('file names and the ZIP', () => {
  it('names each workplace PDF safely, with the month, and numbers names that collide', () => {
    expect(
      fileNames(
        ['חוות גולן', 'a/../b', 'Dolev', 'dolev', 'x:*?"<>|\\y', ' . ', 'z'.repeat(200)],
        MONTH,
      ),
    ).toEqual([
      `חוות גולן ${MONTH}.pdf`,
      `a..b ${MONTH}.pdf`,
      `Dolev ${MONTH}.pdf`,
      `dolev ${MONTH} (2).pdf`, // Windows compares file names ignoring capitals
      `xy ${MONTH}.pdf`,
      `מקום עבודה ${MONTH}.pdf`,
      `${'z'.repeat(100)} ${MONTH}.pdf`,
    ]);
  });

  it('writes a ZIP that another tool reads, Hebrew names included', async () => {
    const a = Buffer.from('first file');
    const b = Buffer.alloc(70_000, 7);
    const files = await unzip(
      Buffer.concat(
        zip([
          { name: `חוות גולן ${MONTH}.pdf`, data: a },
          { name: 'b.pdf', data: b },
        ]),
      ),
    );
    expect([...files.keys()].sort()).toEqual(['b.pdf', `חוות גולן ${MONTH}.pdf`]);
    expect(files.get(`חוות גולן ${MONTH}.pdf`)).toEqual(a);
    expect(files.get('b.pdf')).toEqual(b);
    expect((await unzip(Buffer.concat(zip([])))).size).toBe(0);
  });
});

describe.skipIf(!databaseUrl || !storageConfigured)('the workplace PDFs (T3.2)', () => {
  const db = testDatabase();
  const prisma = db.prisma;
  const files = testStorage();
  let app: INestApplication;
  let owner: Browser;
  let base: string;
  let monthId: string;
  let golan: string;
  let merged: string;
  let zipped: Map<string, Buffer>;
  /** The scans each workplace's PDF must hold, in order (SHA-256). */
  const expected = new Map<string, string[]>();
  const unready: string[] = [];
  let missing: { id: string; key: string; scan: Buffer };

  beforeAll(async () => {
    await Promise.all([db.migrate(), files.create()]);
    await createAdmin(prisma, OWNER.email, OWNER.password);
    const ownerId = (await prisma.user.findFirstOrThrow()).id;
    ({ app, base } = await testApp(db, { storage: files.storage }));
    owner = new Browser(base);
    await owner.login(OWNER.email, OWNER.password);

    // Real scans, each different: one page per size, as the splitter stores them (JPEG).
    const doc = await PDFDocument.create();
    for (let i = 0; i < 12; i++) doc.addPage([200 + i * 10, 150]);
    const scans = await Promise.all(
      (await pdfToImages(Buffer.from(await doc.save()))).map((p) => imageToJpeg(p)),
    );

    monthId = (await monthOf(prisma, new Date('2026-11-01'))).id;
    const uploadId = (
      await prisma.upload.create({
        data: {
          uploadedById: ownerId,
          originalFilename: 'week.pdf',
          sha256: 'pdfs',
          mime: 'application/pdf',
          pageCount: 12,
        },
      })
    ).id;
    const group = async (displayName: string, mergedIntoId?: string) =>
      (
        await prisma.workplaceGroup.create({
          data: { monthId, displayName, normalisedName: displayName, mergedIntoId },
        })
      ).id;
    let page = 0;
    const ticket = async (groupId: string, day: number, name: string, more = {}) => {
      const scan = scans[page]!;
      const key = `pages/${uploadId}/${page}.jpg`;
      await files.storage.put(key, scan, 'image/jpeg');
      const t = await prisma.ticket.create({
        data: {
          uploadId,
          monthId,
          pageIndex: page++,
          s3KeyPage: key,
          firstName: name,
          workerName: name,
          workplaceGroupId: groupId,
          workplaceRaw: 'as written',
          shiftDate: new Date(Date.UTC(2026, 10, day)),
          totalMinutes: 480,
          status: 'verified',
          ...more,
        },
      });
      return { id: t.id, key, scan };
    };

    golan = await group('חוות גולן');
    const hadar = await group('בית הדר');
    merged = await group('חוות הגולן', golan);
    const slashed = await group('a/../b');
    const late = await ticket(golan, 5, 'Kwame');
    const kwame = await ticket(golan, 2, 'Kwame'); // made before Dana, but Dana sorts first
    const dana = await ticket(golan, 2, 'Dana');
    const again = await ticket(golan, 2, 'kwame '); // "Keep both": the same row, after the first
    expected.set(
      `חוות גולן ${MONTH}.pdf`,
      [dana, kwame, again, late].map((t) => sha(t.scan)),
    );
    const ann = await ticket(hadar, 4, 'Ann');
    expected.set(`בית הדר ${MONTH}.pdf`, [sha(ann.scan)]);
    missing = await ticket(slashed, 1, 'Moshe');
    expected.set(`a..b ${MONTH}.pdf`, [sha(missing.scan)]);
    // Left out of every PDF: not ready, removed, replaced, scanned twice.
    const removed = { status: 'excluded' as const, excludedById: ownerId };
    for (const t of [
      await ticket(golan, 6, 'Kwame', { status: 'needs_review' }),
      await ticket(hadar, 7, 'Ann', { status: 'needs_manual_entry' }),
      await ticket(golan, 8, 'Dana', { ...removed, excludedReason: 'removed' }),
      await ticket(golan, 2, 'Kwame', {
        ...removed,
        excludedReason: 'replaced',
        replacedById: kwame.id,
      }),
      await ticket(hadar, 4, 'Ann', { ...removed, excludedReason: 'duplicate' }),
    ]) {
      unready.push(sha(t.scan));
    }

    const res = await owner.download(`/api/months/${monthId}/pdfs`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="tickets-2026-11.zip"',
    );
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    zipped = await unzip(res.bytes);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await files.drop();
    await db.drop();
  });

  it('has one PDF per workplace with ready tickets, named with the workplace and the month', () => {
    expect([...zipped.keys()].sort()).toEqual([...expected.keys()].sort());
  });

  it('puts every ready ticket in its workplace PDF, in date order and then name', async () => {
    for (const [name, scans] of expected) {
      expect(await pages(zipped.get(name)!), name).toEqual(scans);
    }
  });

  it('leaves out removed, replaced and unready tickets', async () => {
    const all = (await Promise.all([...zipped.values()].map(pages))).flat();
    for (const scan of unready) expect(all).not.toContain(scan);
    expect(all).toHaveLength(6);
  });

  it('gives one workplace at a time, named in Hebrew', async () => {
    const res = await owner.download(`/api/months/${monthId}/pdfs?workplace=${golan}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const disposition = res.headers.get('content-disposition')!;
    const encoded = /filename\*=UTF-8''(.+)$/.exec(disposition)![1]!;
    expect(decodeURIComponent(encoded)).toBe(`חוות גולן ${MONTH}.pdf`);
    expect(await pages(res.bytes)).toEqual(expected.get(`חוות גולן ${MONTH}.pdf`));
  });

  it('needs a login, a real month that is open, and a workplace with ready tickets', async () => {
    expect((await new Browser(base).download(`/api/months/${monthId}/pdfs`)).status).toBe(401);
    expect((await owner.download('/api/months/not-a-month/pdfs')).status).toBe(404);
    const none = '00000000-0000-4000-8000-000000000000';
    expect((await owner.download(`/api/months/${none}/pdfs`)).status).toBe(404);
    for (const w of ['not-a-place', none, merged]) {
      expect((await owner.download(`/api/months/${monthId}/pdfs?workplace=${w}`)).status).toBe(404);
    }
    for (const status of ['closing', 'closed'] as const) {
      const m = await prisma.month.create({
        data: { year: 2025, month: status === 'closing' ? 1 : 2, status },
      });
      expect((await owner.download(`/api/months/${m.id}/pdfs`)).status).toBe(409);
    }
  });

  it('gives an empty ZIP for a month with nothing ready, so it can still be closed', async () => {
    const empty = await prisma.month.create({ data: { year: 2025, month: 3 } });
    const res = await owner.download(`/api/months/${empty.id}/pdfs`);
    expect(res.status).toBe(200);
    expect((await unzip(res.bytes)).size).toBe(0);
  });

  it('waits while a ready ticket is not sorted into a workplace yet', async () => {
    const t = await prisma.ticket.findUniqueOrThrow({ where: { id: missing.id } });
    await prisma.ticket.update({ where: { id: t.id }, data: { workplaceGroupId: null } });
    try {
      const res = await owner.send('GET', `/api/months/${monthId}/pdfs`);
      expect(res).toMatchObject({
        status: 409,
        body: { message: 'Some tickets are still being sorted. Try again in a minute.' },
      });
    } finally {
      await prisma.ticket.update({
        where: { id: t.id },
        data: { workplaceGroupId: t.workplaceGroupId },
      });
    }
  });

  it('refuses rather than leave out a ticket whose scan is missing', async () => {
    await files.storage.remove(missing.key);
    try {
      const res = await owner.send('GET', `/api/months/${monthId}/pdfs`);
      expect(res.status).toBe(500);
    } finally {
      await files.storage.put(missing.key, missing.scan, 'image/jpeg');
    }
  });
});
