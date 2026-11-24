// Pipeline steps 1–2 for an uploaded file: what it really is, and its page images.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { imageToJpeg, inspectUpload, pdfPageToJpeg } from './index.ts';

let dir: string;
const file = async (name: string, data: Uint8Array | string) => {
  const path = join(dir, name);
  await writeFile(path, data);
  return path;
};
const twoPagePdf = async () => {
  const doc = await PDFDocument.create();
  doc.addPage([200, 300]);
  doc.addPage([300, 200]);
  return doc.save();
};
const png = (width = 40, height = 20) =>
  sharp({ create: { width, height, channels: 3, background: '#ffffff' } })
    .png()
    .toBuffer();

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tally-intake-test-'));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

describe('inspectUpload: the file type comes from its content, not its name', () => {
  it('knows a PDF and counts its pages', async () => {
    expect(await inspectUpload(await file('scan.pdf', await twoPagePdf()))).toEqual({
      ok: true,
      mime: 'application/pdf',
      pages: 2,
    });
  });

  it('knows a PNG and a JPEG photo, one page each', async () => {
    const jpeg = await sharp(await png())
      .jpeg()
      .toBuffer();
    expect(await inspectUpload(await file('a.png', await png()))).toEqual({
      ok: true,
      mime: 'image/png',
      pages: 1,
    });
    expect(await inspectUpload(await file('b.jpg', jpeg))).toEqual({
      ok: true,
      mime: 'image/jpeg',
      pages: 1,
    });
  });

  it('refuses other files, even when named .pdf', async () => {
    expect(await inspectUpload(await file('notes.pdf', 'just some text'))).toEqual({
      ok: false,
      problem: 'not_supported',
    });
    expect(await inspectUpload(await file('empty.pdf', ''))).toEqual({
      ok: false,
      problem: 'not_supported',
    });
  });

  it('refuses a damaged PDF or image', async () => {
    expect(await inspectUpload(await file('bad.pdf', '%PDF-1.7 and then nothing'))).toEqual({
      ok: false,
      problem: 'damaged',
    });
    const cut = (await png()).subarray(0, 12); // the PNG signature, then nothing readable
    expect(await inspectUpload(await file('bad.png', cut))).toEqual({
      ok: false,
      problem: 'damaged',
    });
  });
});

describe('page images', () => {
  it('renders one PDF page, counted from 0, as a JPEG at 200 dpi', async () => {
    const pdf = await file('two.pdf', await twoPagePdf());
    const second = await sharp(await pdfPageToJpeg(pdf, 1)).metadata();
    // 300 × 200 points at 200 dpi, rounded up by pdftoppm
    expect([second.format, second.width, second.height]).toEqual(['jpeg', 834, 556]);
  });

  it('renders an over-sized page smaller, so it cannot fill the memory (T4.1)', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([14_400, 14_400]); // the largest page a PDF allows: 200 inches square
    doc.addPage([595.28, 841.89]); // A4
    const pdf = await file('huge.pdf', Buffer.from(await doc.save()));
    const huge = await sharp(await pdfPageToJpeg(pdf, 0)).metadata();
    expect(Math.max(huge.width!, huge.height!)).toBeLessThanOrEqual(4000);
    const a4 = await sharp(await pdfPageToJpeg(pdf, 1)).metadata();
    expect(a4.height).toBe(2339); // still 200 dpi
  });

  it('turns a phone photo the right way up and removes its camera details', async () => {
    const photo = await sharp(await png(40, 20))
      .jpeg()
      .withMetadata({ orientation: 6 }) // "rotate 90° to view"
      .toBuffer();
    const page = await sharp(await imageToJpeg(photo)).metadata();
    expect([page.format, page.width, page.height]).toEqual(['jpeg', 20, 40]);
    expect(page.orientation).toBeUndefined();
    expect(page.exif).toBeUndefined();
  });
});
