import fontkit from '@pdf-lib/fontkit';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { A4_MM, EXAMPLE, HEBREW_FONT_URL, SLIPS_PER_PAGE, renderTicketPdf } from './pdf.ts';
import {
  CELL_MM,
  FIELDS,
  FRAME_MM,
  LABELS_MM,
  MARKER_CENTRES_MM,
  MARKER_CLEARANCE_MM,
  MARKER_MM,
  SLIP_MM,
} from './v1.ts';

const DPI = 150;
const px = (mm: number) => Math.round((mm / 25.4) * DPI);

describe('ticket template v1 field map', () => {
  it('keeps every field inside the marker frame', () => {
    for (const f of FIELDS) {
      expect(f.box.x, f.key).toBeGreaterThan(0);
      expect(f.box.y, f.key).toBeGreaterThan(0);
      expect(f.box.x + f.box.w, f.key).toBeLessThan(1);
      expect(f.box.y + f.box.h, f.key).toBeLessThan(1);
    }
  });

  it('never lets two fields overlap', () => {
    for (const a of FIELDS) {
      for (const b of FIELDS) {
        if (a === b) continue;
        const apart =
          a.box.x + a.box.w <= b.box.x ||
          b.box.x + b.box.w <= a.box.x ||
          a.box.y + a.box.h <= b.box.y ||
          b.box.y + b.box.h <= a.box.y;
        expect(apart, `${a.key} / ${b.key}`).toBe(true);
      }
    }
  });

  it('has the box counts from the plan', () => {
    const cells = (key: string) =>
      [...FIELDS.find((f) => f.key === key)!.pattern].filter((c) => c !== '/' && c !== ':').length;
    expect(cells('firstName')).toBe(12);
    expect(cells('workplace')).toBe(15);
    expect(FIELDS.find((f) => f.key === 'date')!.pattern).toBe('DD/MM/YY');
    for (const key of ['startTime', 'endTime', 'totalWorked']) {
      expect(FIELDS.find((f) => f.key === key)!.pattern).toBe('HH:MM');
    }
  });

  it('keeps every box clear of every marker, so they never merge on a scan', () => {
    const half = MARKER_MM.size / 2 + MARKER_CLEARANCE_MM;
    for (const f of FIELDS) {
      const x = FRAME_MM.x + f.box.x * FRAME_MM.width;
      const y = FRAME_MM.y + f.box.y * FRAME_MM.height;
      const w = f.box.w * FRAME_MM.width;
      const h = f.box.h * FRAME_MM.height;
      for (const [name, c] of Object.entries(MARKER_CENTRES_MM)) {
        const apart =
          x >= c.x + half || x + w <= c.x - half || y >= c.y + half || y + h <= c.y - half;
        expect(apart, `${f.key} / ${name}`).toBe(true);
      }
    }
  });

  it('makes markers big enough that a fully inked box cannot push them out of the search', () => {
    // The marker search ignores marks under a third of the largest one (prepare.ts, D32).
    expect(MARKER_MM.size ** 2).toBeGreaterThan((CELL_MM.width * CELL_MM.height) / 3);
  });

  it('fits every side label in the label column', async () => {
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const hebrew = await doc.embedFont(readFileSync(HEBREW_FONT_URL));
    const latin = await doc.embedFont(StandardFonts.Helvetica);
    const columnPt = ((LABELS_MM.right - LABELS_MM.left) * 72) / 25.4;
    for (const f of FIELDS.filter((f) => !f.labelAbove)) {
      expect(hebrew.widthOfTextAtSize(f.labelHe, 10), f.key).toBeLessThan(columnPt);
      expect(latin.widthOfTextAtSize(f.labelEn, 7), f.key).toBeLessThan(columnPt);
    }
  });

  it('has a glyph in the embedded Hebrew font for every Hebrew character printed', () => {
    const font = fontkit.create(readFileSync(HEBREW_FONT_URL));
    const hebrew = [...FIELDS.map((f) => f.labelHe), EXAMPLE.labelHe, EXAMPLE.name];
    for (const text of hebrew) {
      for (const c of text) {
        expect(font.hasGlyphForCodePoint(c.codePointAt(0)!), `"${c}" in "${text}"`).toBe(true);
      }
    }
  });
});

describe('ticket PDF', () => {
  let dir: string;
  let grey: { data: Buffer; width: number; height: number };
  const at = (xMm: number, yMm: number) => grey.data[px(yMm) * grey.width + px(xMm)]!;
  const meanOf = (xMm: number, yMm: number, wMm: number, hMm: number) => {
    let sum = 0;
    let n = 0;
    for (let y = px(yMm); y < px(yMm + hMm); y++) {
      for (let x = px(xMm); x < px(xMm + wMm); x++) {
        sum += grey.data[y * grey.width + x]!;
        n++;
      }
    }
    return sum / n;
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ticket-pdf-'));
    writeFileSync(join(dir, 'tickets.pdf'), await renderTicketPdf());
    // pdftoppm is from poppler: apt-get install poppler-utils (CI), winget install oschwartz10612.Poppler (Windows).
    execFileSync(
      'pdftoppm',
      ['-r', String(DPI), '-gray', '-png', '-singlefile', 'tickets.pdf', 'page'],
      {
        cwd: dir,
      },
    );
    const { data, info } = await sharp(join(dir, 'page.png'))
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    grey = { data, width: info.width, height: info.height };
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('is one A4 portrait page', () => {
    expect(Math.abs(grey.width - px(A4_MM.width))).toBeLessThanOrEqual(1);
    expect(Math.abs(grey.height - px(A4_MM.height))).toBeLessThanOrEqual(1);
  });

  it('prints all four corner markers on all four slips exactly where the field map says', () => {
    const half = MARKER_MM.size / 2;
    expect(SLIPS_PER_PAGE).toBe(4);
    for (let slip = 0; slip < SLIPS_PER_PAGE; slip++) {
      const slipTop = slip * SLIP_MM.height;
      for (const [name, c] of Object.entries(MARKER_CENTRES_MM)) {
        const y = slipTop + c.y;
        const where = `${name} marker, slip at ${slipTop} mm`;
        // Solid black square...
        expect(
          meanOf(c.x - half + 1, y - half + 1, MARKER_MM.size - 2, MARKER_MM.size - 2),
          where,
        ).toBeLessThan(30);
        // ...whose edges are within 0.5 mm of the map: black just inside each edge, white just outside.
        for (const [dx, dy] of [
          [-1, 0],
          [1, 0],
          [0, -1],
          [0, 1],
        ] as const) {
          const side = `${where}, side ${dx},${dy}`;
          expect(at(c.x + dx * (half - 0.5), y + dy * (half - 0.5)), side).toBeLessThan(60);
          expect(at(c.x + dx * (half + 0.5), y + dy * (half + 0.5)), side).toBeGreaterThan(200);
        }
      }
    }
  });

  it('prints character boxes light enough not to merge with black ink', () => {
    const workplace = FIELDS.find((f) => f.key === 'workplace')!;
    const x = FRAME_MM.x + workplace.box.x * FRAME_MM.width;
    const y = FRAME_MM.y + workplace.box.y * FRAME_MM.height;
    // Darkest pixel in a strip across the left edge of the first box, halfway down.
    let darkest = 255;
    for (let i = px(x - 1); i <= px(x + 1); i++) {
      darkest = Math.min(darkest, grey.data[px(y + CELL_MM.height / 2) * grey.width + i]!);
    }
    expect(darkest).toBeGreaterThan(150); // pale, not ink-dark
    expect(darkest).toBeLessThan(245); // but visible
  });
});
