import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import { renderTicketPdf } from '../templates/pdf.ts';
import { FIELDS, FRAME_MM, MARKER_CENTRES_MM, SLIP_MM, TEMPLATE_V1 } from '../templates/v1.ts';
import {
  CROP_PX_PER_MM,
  type PreparedTicket,
  SLIP_PX_PER_MM,
  pdfToImages,
  prepareTicket,
} from './index.ts';

// Fixture images are generated from the blank ticket PDF, so no real scans are stored.
const DPI = 200;
const px = (mm: number) => Math.round((mm / 25.4) * DPI);
let ticket: Buffer; // one blank slip with a white scan margin

const decode = async (img: { data: Buffer }) => {
  const { data, info } = await sharp(img.data)
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
};
const meanAbsDiff = (a: Buffer, b: Buffer) => {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i]! - b[i]!);
  return sum / a.length;
};
const codes = (p: PreparedTicket) => p.flags.map((f) => f.code);

beforeAll(async () => {
  const [page] = await pdfToImages(Buffer.from(await renderTicketPdf()), DPI);
  ticket = await sharp(page!)
    .extract({ left: 0, top: 0, width: px(SLIP_MM.width), height: px(SLIP_MM.height) })
    .extend({ top: 60, bottom: 60, left: 60, right: 60, background: '#ffffff' })
    .png()
    .toBuffer();
});

describe('PDF pages', () => {
  it('turns each PDF page into an image, in page order', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([200, 300]);
    doc.addPage([300, 200]);
    const pages = await pdfToImages(Buffer.from(await doc.save()), 72);
    const sizes = await Promise.all(pages.map((p) => sharp(p).metadata()));
    expect(sizes.map((s) => [s.width, s.height])).toEqual([
      [200, 300],
      [300, 200],
    ]);
  });
});

describe('a straight, clean scan', () => {
  let prepared: PreparedTicket;
  beforeAll(async () => {
    prepared = await prepareTicket(ticket, TEMPLATE_V1);
  });

  it('finds the markers and raises no flags', () => {
    expect(prepared.markersFound).toBe(true);
    expect(codes(prepared)).toEqual([]);
  });

  it('straightens the ticket to its real size, with the markers exactly in their corners', async () => {
    const slip = await decode(prepared.ticket);
    expect(slip.width).toBe(SLIP_MM.width * SLIP_PX_PER_MM);
    expect(Math.abs(slip.height - SLIP_MM.height * SLIP_PX_PER_MM)).toBeLessThanOrEqual(1);
    for (const c of Object.values(MARKER_CENTRES_MM)) {
      const at =
        slip.data[
          Math.round(c.y * SLIP_PX_PER_MM) * slip.width + Math.round(c.x * SLIP_PX_PER_MM)
        ]!;
      expect(at).toBeLessThan(80);
    }
  });

  it('cuts out every field at full detail, sized from the field map', async () => {
    for (const f of FIELDS) {
      const crop = await decode(prepared.crops![f.key]);
      expect(crop.width, f.key).toBe(Math.round((f.box.w * FRAME_MM.width + 3) * CROP_PX_PER_MM));
      expect(crop.height, f.key).toBe(Math.round((f.box.h * FRAME_MM.height + 3) * CROP_PX_PER_MM));
    }
  });
});

describe('crooked and awkward scans give the same straightened ticket', () => {
  let reference: Awaited<ReturnType<typeof decode>>;
  beforeAll(async () => {
    reference = await decode((await prepareTicket(ticket, TEMPLATE_V1)).ticket);
  });

  it.each([
    ['rotated 10°', (b: Buffer) => sharp(b).rotate(10, { background: '#ffffff' })],
    ['rotated −7°', (b: Buffer) => sharp(b).rotate(-7, { background: '#ffffff' })],
    ['upside down', (b: Buffer) => sharp(b).rotate(180)],
    ['sideways (90°)', (b: Buffer) => sharp(b).rotate(90)],
    [
      'on a grey desk, slightly turned',
      (b: Buffer) =>
        sharp(b)
          .rotate(4, { background: '#ffffff' })
          .extend({ top: 150, bottom: 150, left: 150, right: 150, background: '#808080' }),
    ],
  ])('%s', async (_name, transform) => {
    const prepared = await prepareTicket(await transform(ticket).png().toBuffer(), TEMPLATE_V1);
    expect(prepared.markersFound).toBe(true);
    expect(codes(prepared)).toEqual([]);
    const slip = await decode(prepared.ticket);
    expect(slip.width).toBe(reference.width);
    // Correct results differ by about 1; an upside-down result by more than 5.
    expect(meanAbsDiff(slip.data, reference.data)).toBeLessThan(3);
  });
});

describe('MARKERS_NOT_FOUND / IMAGE_BLURRY / IMAGE_DARK', () => {
  it('flags a blurred scan as IMAGE_BLURRY and still reads it', async () => {
    const prepared = await prepareTicket(await sharp(ticket).blur(2).png().toBuffer(), TEMPLATE_V1);
    expect(codes(prepared)).toEqual(['IMAGE_BLURRY']);
    expect(prepared.crops).toBeDefined();
  });

  it('flags a dark scan as IMAGE_DARK and still reads it', async () => {
    const prepared = await prepareTicket(
      await sharp(ticket).linear(0.4, 0).png().toBuffer(),
      TEMPLATE_V1,
    );
    expect(codes(prepared)).toEqual(['IMAGE_DARK']);
    expect(prepared.crops).toBeDefined();
  });

  it('does not flag a slightly dim scan (60% brightness)', async () => {
    const prepared = await prepareTicket(
      await sharp(ticket).linear(0.6, 0).png().toBuffer(),
      TEMPLATE_V1,
    );
    expect(codes(prepared)).toEqual([]);
  });

  it('flags a page without the corner markers, and still sends the whole page to be read', async () => {
    const page = await sharp({
      create: { width: 1600, height: 900, channels: 3, background: '#ffffff' },
    })
      .png()
      .toBuffer();
    const prepared = await prepareTicket(page, TEMPLATE_V1);
    expect(codes(prepared)).toEqual(['MARKERS_NOT_FOUND']);
    expect(prepared.crops).toBeUndefined();
    expect(prepared.ticket.data.length).toBeGreaterThan(0);
  });

  it('flags a ticket with one marker covered', async () => {
    const meta = await sharp(ticket).metadata();
    const c = MARKER_CENTRES_MM.topRight;
    const cover = await sharp({
      create: { width: px(12), height: px(12), channels: 3, background: '#ffffff' },
    })
      .png()
      .toBuffer();
    const covered = await sharp(ticket)
      .composite([{ input: cover, left: 60 + px(c.x - 6), top: 60 + px(c.y - 6) }])
      .png()
      .toBuffer();
    expect(meta.width).toBeGreaterThan(0);
    expect(codes(await prepareTicket(covered, TEMPLATE_V1))).toEqual(['MARKERS_NOT_FOUND']);
  });
});
