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

describe('a filled-in ticket comes out the right way up', () => {
  // Dense "handwriting" in every box: thick zigzags, much more ink than real writing. The way up
  // must come from print that writing never covers, not from where the ink is.
  let filled: Buffer;
  let reference: Awaited<ReturnType<typeof decode>>;
  beforeAll(async () => {
    const strokes = FIELDS.map((f) => {
      const x = FRAME_MM.x + f.box.x * FRAME_MM.width;
      const y = FRAME_MM.y + f.box.y * FRAME_MM.height;
      const w = f.box.w * FRAME_MM.width;
      const h = f.box.h * FRAME_MM.height;
      const points = Array.from({ length: 40 }, (_, i) => {
        const px_ = px(x + 1 + (i / 39) * (w - 2));
        const py = px(y + h / 2 + Math.sin(i * 1.3) * (h / 2 - 1.5));
        return `${px_},${py}`;
      }).join(' ');
      return `<polyline points="${points}" fill="none" stroke="#111" stroke-width="${px(1.2)}"/>`;
    }).join('');
    const slip = await sharp(ticket)
      .extract({ left: 60, top: 60, width: px(SLIP_MM.width), height: px(SLIP_MM.height) })
      .png()
      .toBuffer();
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${px(SLIP_MM.width)}" height="${px(SLIP_MM.height)}">${strokes}</svg>`;
    const upright = await sharp(slip)
      .composite([{ input: Buffer.from(svg) }])
      .png()
      .toBuffer();
    filled = await sharp(upright)
      .extend({ top: 60, bottom: 60, left: 60, right: 60, background: '#ffffff' })
      .png()
      .toBuffer();
    reference = await decode({
      data: await sharp(upright)
        .resize(SLIP_MM.width * SLIP_PX_PER_MM, Math.round(SLIP_MM.height * SLIP_PX_PER_MM), {
          fit: 'fill',
        })
        .toBuffer(),
    });
  });

  it.each([0, 9, -12, 180])('rotated %i°', async (angle) => {
    const scan = await sharp(filled).rotate(angle, { background: '#c8c8c8' }).png().toBuffer();
    const prepared = await prepareTicket(scan, TEMPLATE_V1);
    expect(prepared.markersFound).toBe(true);
    const result = await decode(prepared.ticket);
    const w = Math.min(result.width, reference.width);
    const h = Math.min(result.height, reference.height);
    const diff = (flip: boolean) => {
      let sum = 0;
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const r = flip
            ? result.data[(result.height - 1 - y) * result.width + (result.width - 1 - x)]!
            : result.data[y * result.width + x]!;
          sum += Math.abs(r - reference.data[y * reference.width + x]!);
        }
      return sum / (w * h);
    };
    // Upright, the result matches the drawn ticket far better than when turned 180°.
    expect(diff(false)).toBeLessThan(diff(true) / 2);
  });
});

describe('a scribbled-out correction does not hide the markers', () => {
  // A solid black patch over one, two or three boxes (someone blacking out wrong digits). Two
  // boxes make a near-square patch four times a marker's area, the hardest case for 6 mm markers.
  it.each([1, 2, 3])('over %i box(es)', async (boxes) => {
    const date = FIELDS.find((f) => f.key === 'date')!;
    const x = FRAME_MM.x + date.box.x * FRAME_MM.width;
    const y = FRAME_MM.y + date.box.y * FRAME_MM.height;
    const patch = await sharp({
      create: { width: px(boxes * 8), height: px(9), channels: 3, background: '#111111' },
    })
      .png()
      .toBuffer();
    const scan = await sharp(ticket)
      .composite([{ input: patch, left: 60 + px(x), top: 60 + px(y) }])
      .png()
      .toBuffer();
    const tilted = await sharp(scan).rotate(5, { background: '#c8c8c8' }).png().toBuffer();
    const prepared = await prepareTicket(tilted, TEMPLATE_V1);
    expect(prepared.markersFound).toBe(true);
    expect(codes(prepared)).toEqual([]);
  });
});
