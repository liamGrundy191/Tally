import fontkit from '@pdf-lib/fontkit';
import { readFileSync } from 'node:fs';
import { PDFDocument, type PDFFont, type PDFPage, StandardFonts, rgb, type RGB } from 'pdf-lib';
import {
  CELL_MM,
  EXAMPLE_STRIP_MM,
  FIELDS,
  FRAME_MM,
  LABELS_MM,
  MARKER_CENTRES_MM,
  MARKER_MM,
  SEPARATOR_MM,
  SLIP_MM,
  TEMPLATE_VERSION,
  isSeparator,
  patternWidthMm,
} from './v1.ts';

export const A4_MM = { width: 210, height: 297 } as const;
export const SLIPS_PER_PAGE = Math.floor(A4_MM.height / SLIP_MM.height);
export const HEBREW_FONT_URL = new URL(
  '../../assets/fonts/NotoSansHebrew-Regular.ttf',
  import.meta.url,
);

// The Hebrew font has only Hebrew letters, space, hyphen and geresh/gershayim (a test checks this).
// English text and digits use Helvetica.

/** Invented example values printed in the strip at the top. */
export const EXAMPLE = {
  labelHe: 'דוגמה',
  labelEn: 'Example',
  name: 'דנה',
  time: '08:30',
} as const;

const MM = 72 / 25.4;
const hex = (h: number) => rgb(((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255);
const BLACK = rgb(0, 0, 0);
const BOX = hex(0xb8d4f0); // pale blue, so box lines do not merge with ink
const SEPARATOR = hex(0x6f93c0);
const SECONDARY = hex(0x555555);
const CUT_LINE = hex(0xaaaaaa);
const isHebrew = (s: string) => /[֐-׿]/.test(s);

export async function renderTicketPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  doc.setTitle(`Shift ticket ${TEMPLATE_VERSION}`);
  const fonts = {
    hebrew: await doc.embedFont(readFileSync(HEBREW_FONT_URL), { subset: false }),
    latin: await doc.embedFont(StandardFonts.Helvetica),
  };
  const page = doc.addPage([A4_MM.width * MM, A4_MM.height * MM]);
  const cut = (x1: number, y1: number, x2: number, y2: number) =>
    page.drawLine({
      start: { x: x1 * MM, y: (A4_MM.height - y1) * MM },
      end: { x: x2 * MM, y: (A4_MM.height - y2) * MM },
      thickness: 0.4,
      color: CUT_LINE,
      dashArray: [4, 4],
    });
  // Slips sit against the left edge; the strip to their right is cut off.
  cut(SLIP_MM.width, 0, SLIP_MM.width, A4_MM.height);
  for (let i = 0; i < SLIPS_PER_PAGE; i++) {
    drawSlip(page, fonts, i * SLIP_MM.height);
    if (i > 0) cut(0, i * SLIP_MM.height, SLIP_MM.width, i * SLIP_MM.height);
  }
  return doc.save();
}

type Fonts = { hebrew: PDFFont; latin: PDFFont };
type Align = 'left' | 'right' | 'center';

function drawSlip(page: PDFPage, fonts: Fonts, slipTopMm: number) {
  // All positions below are millimetres from the slip's top-left corner.
  const point = (x: number, y: number) => ({ x: x * MM, y: (A4_MM.height - slipTopMm - y) * MM });

  const rect = (x: number, y: number, w: number, h: number, style: { fill?: RGB; border?: RGB }) =>
    page.drawRectangle({
      ...point(x, y + h),
      width: w * MM,
      height: h * MM,
      color: style.fill,
      borderColor: style.border,
      borderWidth: style.border ? 0.7 : 0,
    });

  // y is the text baseline. Hebrew strings are passed in logical order; pdf-lib's font layout
  // puts them right-to-left.
  const text = (s: string, size: number, x: number, y: number, align: Align, color = BLACK) => {
    const font = isHebrew(s) ? fonts.hebrew : fonts.latin;
    const w = font.widthOfTextAtSize(s, size) / MM;
    const left = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
    page.drawText(s, { ...point(left, y), size, font, color });
  };

  /** Boxes and printed separators; `fill` writes one character per slot (for the example). */
  const cells = (
    pattern: string,
    x: number,
    y: number,
    cellW: number,
    cellH: number,
    sepW: number,
    fill?: string,
  ) => {
    let cx = x;
    [...pattern].forEach((c, i) => {
      if (isSeparator(c)) {
        text(c, cellH * 1.4, cx + sepW / 2, y + cellH * 0.72, 'center', SEPARATOR);
        cx += sepW;
        return;
      }
      rect(cx, y, cellW, cellH, { border: BOX });
      const ch = fill?.[i];
      if (ch) text(ch, cellH * 1.9, cx + cellW / 2, y + cellH * 0.78, 'center', SECONDARY);
      cx += cellW;
    });
  };

  for (const c of Object.values(MARKER_CENTRES_MM)) {
    const half = MARKER_MM.size / 2;
    rect(c.x - half, c.y - half, MARKER_MM.size, MARKER_MM.size, { fill: BLACK });
  }
  // Version mark beside the bottom-left marker.
  text(
    TEMPLATE_VERSION,
    7,
    MARKER_MM.inset + MARKER_MM.size + 2,
    SLIP_MM.height - MARKER_MM.inset - 1,
    'left',
    SECONDARY,
  );

  // Example strip, centred at the top: label, a name in block letters (first letter in the
  // rightmost box) and a time, read right to left.
  const ex = {
    cellW: 6,
    cellH: EXAMPLE_STRIP_MM.height,
    sepW: 3,
    y: EXAMPLE_STRIP_MM.top,
    gap: 3,
  };
  const name = [...EXAMPLE.name].reverse().join('');
  const labelW =
    Math.max(
      fonts.hebrew.widthOfTextAtSize(EXAMPLE.labelHe, 9),
      fonts.latin.widthOfTextAtSize(EXAMPLE.labelEn, 6.5),
    ) / MM;
  const nameW = name.length * ex.cellW;
  const timeW = patternWidthMm(EXAMPLE.time, ex.cellW, ex.sepW);
  const exRight = (SLIP_MM.width + labelW + ex.gap + nameW + 2 * ex.gap + timeW) / 2;
  text(EXAMPLE.labelHe, 9, exRight, 10.5, 'right');
  text(EXAMPLE.labelEn, 6.5, exRight, 13.5, 'right', SECONDARY);
  const nameRight = exRight - labelW - ex.gap;
  cells('_'.repeat(name.length), nameRight - nameW, ex.y, ex.cellW, ex.cellH, ex.sepW, name);
  const timeRight = nameRight - nameW - 2 * ex.gap;
  cells(EXAMPLE.time, timeRight - timeW, ex.y, ex.cellW, ex.cellH, ex.sepW, EXAMPLE.time);

  for (const f of FIELDS) {
    const x = FRAME_MM.x + f.box.x * FRAME_MM.width;
    const y = FRAME_MM.y + f.box.y * FRAME_MM.height;
    cells(f.pattern, x, y, CELL_MM.width, CELL_MM.height, SEPARATOR_MM);
    if (f.labelAbove) {
      const centre = x + (f.box.w * FRAME_MM.width) / 2;
      text(f.labelHe, 10, centre, y - 4.5, 'center');
      text(f.labelEn, 7, centre, y - 1.3, 'center', SECONDARY);
    } else {
      text(f.labelHe, 10, LABELS_MM.right, y + 4, 'right');
      text(f.labelEn, 7, LABELS_MM.right, y + 7.5, 'right', SECONDARY);
    }
  }
}
