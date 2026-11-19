import { pdfToImages } from '@tally/shared/imaging';
import { readFileSync } from 'node:fs';

/** The pages of a scan: every page of a PDF, or the single image. */
export async function scanPages(path: string): Promise<Buffer[]> {
  const file = readFileSync(path);
  return path.toLowerCase().endsWith('.pdf') ? pdfToImages(file) : [file];
}
