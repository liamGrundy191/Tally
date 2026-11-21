// Pipeline steps 1–2 for an uploaded file (plan section 4): what it really is, judged by its
// content, and the page image of a photo.
import { open } from 'node:fs/promises';
import sharp from 'sharp';
import { pdfPageCount } from './pdf-pages.ts';

export type UploadMime = 'application/pdf' | 'image/jpeg' | 'image/png';
export type Inspection =
  | { ok: true; mime: UploadMime; pages: number }
  | { ok: false; problem: 'not_supported' | 'damaged' };

const SIGNATURES: [UploadMime, number[]][] = [
  ['application/pdf', [0x25, 0x50, 0x44, 0x46, 0x2d]], // "%PDF-"
  ['image/jpeg', [0xff, 0xd8, 0xff]],
  ['image/png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
];
/** sharp refuses to decode images larger than this, so they are refused at intake instead. */
const MAX_PIXELS = 268_402_689;

export async function inspectUpload(path: string): Promise<Inspection> {
  const head = Buffer.alloc(8);
  const file = await open(path);
  try {
    await file.read(head, 0, head.length, 0);
  } finally {
    await file.close();
  }
  const mime = SIGNATURES.find(([, signature]) => signature.every((b, i) => head[i] === b))?.[0];
  if (!mime) return { ok: false, problem: 'not_supported' };
  if (mime === 'application/pdf') {
    const pages = await pdfPageCount(path);
    return pages ? { ok: true, mime, pages } : { ok: false, problem: 'damaged' };
  }
  const size = await sharp(path)
    .metadata()
    .then((m) => (m.width ?? 0) * (m.height ?? 0))
    .catch(() => 0);
  return size > 0 && size <= MAX_PIXELS
    ? { ok: true, mime, pages: 1 }
    : { ok: false, problem: 'damaged' };
}

/** A photo's page image: the right way up, with the camera's details (EXIF, location) removed. */
export function imageToJpeg(image: Buffer): Promise<Buffer> {
  // failOn 'none': a slightly damaged photo still becomes a ticket a person can look at.
  return sharp(image, { failOn: 'none' })
    .rotate()
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 90 })
    .toBuffer();
}
