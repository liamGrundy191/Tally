// Pipeline steps 2–3 (plan section 4): normalise, find the corner markers, straighten the
// ticket, cut out each field, and measure sharpness and brightness.
import sharp from 'sharp';
import type { TicketImage } from '../extraction/extractor.ts';
import type { FieldKey, Flag } from '../rules/schemas.ts';
import {
  FRAME_MM,
  EXAMPLE_STRIP_MM,
  MARKER_CENTRES_MM,
  MARKER_MM,
  SLIP_MM,
  type TicketTemplate,
} from '../templates/v1.ts';
import { type Homography, type Point, apply, clockwise, distance, homography } from './geometry.ts';

export interface Grey {
  data: Uint8Array;
  width: number;
  height: number;
}

/** Output scales: the straightened ticket for pass A, and the field crops for pass B. */
export const SLIP_PX_PER_MM = 10;
export const CROP_PX_PER_MM = 12;
const CROP_MARGIN_MM = 1.5;
const MAX_SOURCE_PX = 4000; // bounds memory on very large photos
const DETECT_PX = 1200; // marker search runs on a smaller copy

/**
 * Quality limits on the straightened ticket at SLIP_PX_PER_MM. Brightness is the mean before
 * the contrast stretch; sharpness is measured after it, so lighting does not affect it.
 * shortcut: set from four phone scans and blurred/darkened copies (sharp scans 135–179, Gaussian
 * blur σ1.5 35–59, σ2 17–41); retune on the Phase 0 set.
 */
export const QUALITY_LIMITS = { minBrightness: 120, minSharpness: 50 };

export interface PreparedTicket {
  /** The straightened ticket when the markers were found, otherwise the normalised page. */
  ticket: TicketImage;
  /** One crop per field, only when the markers were found. */
  crops?: Record<FieldKey, TicketImage>;
  markersFound: boolean;
  quality: { brightness: number; sharpness: number | null };
  flags: Flag[];
}

async function toGrey(image: Buffer, maxSide: number, stretch = false): Promise<Grey> {
  let s = sharp(image)
    .rotate() // apply EXIF orientation
    .flatten({ background: '#ffffff' })
    .greyscale()
    .resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true });
  if (stretch) s = s.normalise();
  const { data, info } = await s.raw().toBuffer({ resolveWithObject: true });
  return {
    data: new Uint8Array(data.buffer, data.byteOffset, data.length),
    width: info.width,
    height: info.height,
  };
}

const toJpeg = async (g: Grey): Promise<TicketImage> => ({
  data: await sharp(Buffer.from(g.data), { raw: { width: g.width, height: g.height, channels: 1 } })
    .jpeg({ quality: 90 })
    .toBuffer(),
  mediaType: 'image/jpeg',
});

/** Step 2: apply phone rotation, greyscale, cap the long edge at 2000 px, JPEG. */
export async function normaliseImage(image: Buffer): Promise<Buffer> {
  return sharp(image)
    .rotate()
    .flatten({ background: '#ffffff' })
    .greyscale()
    .resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 90 })
    .toBuffer();
}

interface Blob {
  centre: Point;
  area: number;
}

/** Solid, roughly square dark patches: candidates for the corner markers. */
function darkBlobs(img: Grey, threshold = 80): Blob[] {
  const { data, width, height } = img;
  const seen = new Uint8Array(width * height);
  const stack = new Int32Array(width * height);
  const blobs: Blob[] = [];
  const maxSide = 0.15 * Math.max(width, height);
  for (let start = 0; start < data.length; start++) {
    if (seen[start] || data[start]! >= threshold) continue;
    let top = 0;
    stack[top++] = start;
    seen[start] = 1;
    let count = 0,
      sumX = 0,
      sumY = 0;
    let minX = width,
      maxX = 0,
      minY = height,
      maxY = 0;
    while (top > 0) {
      const i = stack[--top]!;
      const x = i % width;
      const y = (i - x) / width;
      count++;
      sumX += x;
      sumY += y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      for (const j of [i - 1, i + 1, i - width, i + width]) {
        if (j < 0 || j >= data.length || seen[j] || data[j]! >= threshold) continue;
        if ((j === i - 1 && x === 0) || (j === i + 1 && x === width - 1)) continue;
        seen[j] = 1;
        stack[top++] = j;
      }
    }
    const w = maxX - minX + 1;
    const h = maxY - minY + 1;
    const solid = count / (w * h) >= 0.5;
    const squarish = Math.max(w, h) / Math.min(w, h) <= 2;
    if (w >= 5 && h >= 5 && solid && squarish && Math.max(w, h) <= maxSide) {
      blobs.push({ centre: { x: sumX / count, y: sumY / count }, area: count });
    }
  }
  return blobs;
}

const FRAME_RATIO = FRAME_MM.width / FRAME_MM.height;

/**
 * The four blobs that best form the marker rectangle: opposite sides equal, diagonals equal,
 * the frame's width-to-height ratio, and blobs the size a marker should be. Clockwise order.
 * Markers are the largest solid marks and the ticket fills a fair part of the picture, so small
 * print (labels, digits) can never stand in for a missing marker.
 */
function findMarkerQuad(blobs: Blob[], img: Grey): Point[] | null {
  // A scribbled-out correction can be a solid patch several times a marker's size, which would
  // push the markers under the size cut-off. If nothing is found, try again without the one or
  // two largest patches; the four markers must still match each other in size (D32).
  const sorted = [...blobs].sort((a, b) => b.area - a.area);
  for (let skip = 0; skip <= 2; skip++) {
    const quad = searchQuad(sorted.slice(skip), img);
    if (quad) return quad;
  }
  return null;
}

function searchQuad(sorted: Blob[], img: Grey): Point[] | null {
  const largest = sorted[0]?.area ?? 0;
  const cands = sorted.filter((b) => b.area >= largest / 3).slice(0, 30);
  const minLongSide = 0.25 * Math.max(img.width, img.height);
  let best: { points: Point[]; score: number } | null = null;
  for (let i = 0; i < cands.length; i++)
    for (let j = i + 1; j < cands.length; j++)
      for (let k = j + 1; k < cands.length; k++)
        for (let l = k + 1; l < cands.length; l++) {
          const group = [cands[i]!, cands[j]!, cands[k]!, cands[l]!];
          const areas = group.map((b) => b.area);
          if (Math.max(...areas) / Math.min(...areas) > 3) continue;
          const p = clockwise(group.map((b) => b.centre));
          const s = [0, 1, 2, 3].map((n) => distance(p[n]!, p[(n + 1) % 4]!));
          const rel = (a: number, b: number) => Math.abs(a - b) / Math.max(a, b);
          const sides = rel(s[0]!, s[2]!) + rel(s[1]!, s[3]!);
          const diagonals = rel(distance(p[0]!, p[2]!), distance(p[1]!, p[3]!));
          const long = Math.max(s[0]! + s[2]!, s[1]! + s[3]!) / 2;
          const short = Math.min(s[0]! + s[2]!, s[1]! + s[3]!) / 2;
          const ratio = Math.abs(long / short - FRAME_RATIO) / FRAME_RATIO;
          const markerSide = Math.sqrt(areas.reduce((a, b) => a + b) / 4);
          const expectedSide = (long * MARKER_MM.size) / FRAME_MM.width;
          const size = markerSide / expectedSide;
          if (sides > 0.3 || diagonals > 0.1 || ratio > 0.25 || size < 0.6 || size > 1.6) continue;
          if (long < minLongSide) continue;
          const score = sides + diagonals + ratio;
          if (!best || score < best.score) best = { points: p, score };
        }
  return best?.points ?? null;
}

/** Marker centres in slip millimetres, in the order TL, TR, BR, BL. */
const MARKERS_MM: Point[] = [
  MARKER_CENTRES_MM.topLeft,
  MARKER_CENTRES_MM.topRight,
  MARKER_CENTRES_MM.bottomRight,
  MARKER_CENTRES_MM.bottomLeft,
];

function bilinear(img: Grey, x: number, y: number): number {
  if (x < 0 || y < 0 || x > img.width - 1 || y > img.height - 1) return 255;
  const x0 = Math.floor(x),
    y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, img.width - 1),
    y1 = Math.min(y0 + 1, img.height - 1);
  const fx = x - x0,
    fy = y - y0;
  const at = (xx: number, yy: number) => img.data[yy * img.width + xx]!;
  return (
    at(x0, y0) * (1 - fx) * (1 - fy) +
    at(x1, y0) * fx * (1 - fy) +
    at(x0, y1) * (1 - fx) * fy +
    at(x1, y1) * fx * fy
  );
}

/** Samples a straightened rectangle (in slip mm) out of the source image. */
function warp(
  src: Grey,
  slipToSrc: Homography,
  x0: number,
  y0: number,
  w: number,
  h: number,
  pxPerMm: number,
): Grey {
  const width = Math.round(w * pxPerMm);
  const height = Math.round(h * pxPerMm);
  const data = new Uint8Array(width * height);
  for (let v = 0; v < height; v++)
    for (let u = 0; u < width; u++) {
      const p = apply(slipToSrc, { x: x0 + (u + 0.5) / pxPerMm, y: y0 + (v + 0.5) / pxPerMm });
      data[v * width + u] = Math.round(bilinear(src, p.x, p.y));
    }
  return { data, width, height };
}

/** Mean ink (0 = white, 255 = black) in a slip-mm rectangle, sampled on a coarse grid. */
function inkIn(
  img: Grey,
  slipToImg: Homography,
  x0: number,
  y0: number,
  w: number,
  h: number,
): number {
  let sum = 0,
    n = 0;
  for (let y = y0; y < y0 + h; y += 0.5)
    for (let x = x0; x < x0 + w; x += 0.5) {
      const p = apply(slipToImg, { x, y });
      sum += 255 - bilinear(img, p.x, p.y);
      n++;
    }
  return sum / n;
}

/**
 * Which way up the ticket is. The four markers are symmetric, so the two rotations 180° apart
 * both fit. The printed example strip at the top decides: turned 180°, it would sit below the
 * time boxes, where nothing is printed or written. Handwriting cannot tip this, unlike the old
 * check (labels against the box side), which dense writing turned upside down.
 */
function orient(quad: Point[], img: Grey): Homography {
  const s0 = distance(quad[0]!, quad[1]!);
  const s1 = distance(quad[1]!, quad[2]!);
  const starts = s0 >= s1 ? [0, 2] : [1, 3]; // the side from TL to TR is a long side
  const options = starts.map((start) => {
    const ordered = [0, 1, 2, 3].map((n) => quad[(start + n) % 4]!);
    const h = homography(MARKERS_MM, ordered);
    // A band through the example strip's characters, and the same band turned 180°.
    const band = { x: SLIP_MM.width / 2 - 25, y: EXAMPLE_STRIP_MM.top + 0.5, w: 50, h: 4 };
    const top = inkIn(img, h, band.x, band.y, band.w, band.h);
    const bottom = inkIn(img, h, band.x, SLIP_MM.height - band.y - band.h, band.w, band.h);
    return { h, score: top - bottom };
  });
  return options[0]!.score >= options[1]!.score ? options[0]!.h : options[1]!.h;
}

const mean = (g: Grey) => g.data.reduce((a, b) => a + b, 0) / g.data.length;

/**
 * Stretches contrast so the darkest 1% becomes black and the lightest 1% white. Makes dim
 * photos easier to read, and makes the sharpness measure independent of lighting.
 */
function stretch(g: Grey): Grey {
  const hist = new Array<number>(256).fill(0);
  for (const v of g.data) hist[v]!++;
  const pick = (target: number) => {
    let acc = 0;
    for (let v = 0; v < 256; v++) if ((acc += hist[v]!) >= target) return v;
    return 255;
  };
  const lo = pick(g.data.length * 0.01);
  const hi = pick(g.data.length * 0.99);
  if (hi <= lo) return g;
  const data = g.data.map((v) =>
    Math.max(0, Math.min(255, Math.round(((v - lo) * 255) / (hi - lo)))),
  );
  return { ...g, data };
}

/** Variance of the Laplacian: low when the image is blurred. */
function sharpness(g: Grey): number {
  const { data, width, height } = g;
  let sum = 0,
    sumSq = 0,
    n = 0;
  for (let y = 1; y < height - 1; y++)
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const lap = data[i - 1]! + data[i + 1]! + data[i - width]! + data[i + width]! - 4 * data[i]!;
      sum += lap;
      sumSq += lap * lap;
      n++;
    }
  return sumSq / n - (sum / n) ** 2;
}

/** Steps 2–3 for one page image: straighten, crop, measure. Never throws for a bad image. */
export async function prepareTicket(
  image: Buffer,
  template: TicketTemplate,
): Promise<PreparedTicket> {
  const flags: Flag[] = [];
  const detect = await toGrey(image, DETECT_PX, true);
  const quad = findMarkerQuad(darkBlobs(detect), detect);

  if (!quad) {
    flags.push({ code: 'MARKERS_NOT_FOUND' });
    const page = await toGrey(image, 2000);
    const brightness = mean(page);
    if (brightness < QUALITY_LIMITS.minBrightness)
      flags.push({ code: 'IMAGE_DARK', detail: { brightness } });
    // shortcut: no sharpness check without markers (no fixed scale to compare); the ticket is flagged anyway.
    return {
      ticket: { data: await normaliseImage(image), mediaType: 'image/jpeg' },
      markersFound: false,
      quality: { brightness, sharpness: null },
      flags,
    };
  }

  const src = await toGrey(image, MAX_SOURCE_PX);
  const scaleX = src.width / detect.width;
  const scaleY = src.height / detect.height;
  const slipToDetect = orient(quad, detect);
  const corners = MARKERS_MM.map((p) => apply(slipToDetect, p));
  const slipToSrc = homography(
    MARKERS_MM,
    corners.map((p) => ({ x: p.x * scaleX, y: p.y * scaleY })),
  );

  const raw = warp(src, slipToSrc, 0, 0, SLIP_MM.width, SLIP_MM.height, SLIP_PX_PER_MM);
  const brightness = mean(raw);
  const slip = stretch(raw);
  const sharp_ = sharpness(slip);
  if (brightness < QUALITY_LIMITS.minBrightness)
    flags.push({ code: 'IMAGE_DARK', detail: { brightness } });
  if (sharp_ < QUALITY_LIMITS.minSharpness)
    flags.push({ code: 'IMAGE_BLURRY', detail: { sharpness: sharp_ } });

  const crops = {} as Record<FieldKey, TicketImage>;
  for (const f of template.fields) {
    const x = FRAME_MM.x + f.box.x * FRAME_MM.width - CROP_MARGIN_MM;
    const y = FRAME_MM.y + f.box.y * FRAME_MM.height - CROP_MARGIN_MM;
    const w = f.box.w * FRAME_MM.width + 2 * CROP_MARGIN_MM;
    const h = f.box.h * FRAME_MM.height + 2 * CROP_MARGIN_MM;
    crops[f.key] = await toJpeg(stretch(warp(src, slipToSrc, x, y, w, h, CROP_PX_PER_MM)));
  }

  return {
    ticket: await toJpeg(slip),
    crops,
    markersFound: true,
    quality: { brightness, sharpness: sharp_ },
    flags,
  };
}
