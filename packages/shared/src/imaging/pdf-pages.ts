import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
// Uploaded PDFs are untrusted: poppler is stopped if one makes it hang (T4.1).
const INFO_TIMEOUT_MS = 30_000;
const PAGE_TIMEOUT_MS = 30_000;
/** A page image's longest side, in pixels: a page drawn huge is rendered smaller, not refused. */
const MAX_PAGE_PX = 4000;

/** Step 1 for PDFs: one PNG per page, rendered by poppler's pdftoppm. */
export async function pdfToImages(pdf: Buffer, dpi = 200): Promise<Buffer[]> {
  const dir = await mkdtemp(join(tmpdir(), 'tally-pdf-'));
  try {
    await writeFile(join(dir, 'in.pdf'), pdf);
    // No time limit: only the local tools render whole files, never an upload (T4.1).
    await run('pdftoppm', ['-r', String(dpi), '-png', 'in.pdf', 'page'], { cwd: dir });
    const pageNumber = (f: string) => Number(/-(\d+)\.png$/.exec(f)?.[1]);
    const pages = (await readdir(dir))
      .filter((f) => f.startsWith('page-'))
      .sort((a, b) => pageNumber(a) - pageNumber(b));
    return Promise.all(pages.map((f) => readFile(join(dir, f))));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The number of pages, or null when poppler cannot open the file. */
export async function pdfPageCount(path: string): Promise<number | null> {
  try {
    const { stdout } = await run('pdfinfo', [path], { timeout: INFO_TIMEOUT_MS });
    const pages = Number(/^Pages:\s+(\d+)/m.exec(stdout)?.[1]);
    return pages > 0 ? pages : null;
  } catch (e) {
    // A missing pdfinfo is the server's fault, not a damaged file.
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw e;
    return null;
  }
}

/**
 * Step 2 for PDFs: one page (counted from 0) as a colour JPEG, rendered at the same resolution as
 * pdfToImages. One page at a time keeps memory small for a 300-page scan. A page drawn larger
 * than about 50 cm is rendered at a lower resolution, so its image stays within MAX_PAGE_PX.
 */
export async function pdfPageToJpeg(path: string, pageIndex: number, dpi = 200): Promise<Buffer> {
  const out = `${path}-page`;
  const page = String(pageIndex + 1);
  const { stdout } = await run('pdfinfo', ['-f', page, '-l', page, path], {
    timeout: INFO_TIMEOUT_MS,
  });
  // pdfinfo writes large sizes as 2e+06. A size it cannot give, or a page too large to render
  // even at 1 dpi, fails the page rather than rendering it blank or full size.
  const size = /^Page\s+\d+\s+size:\s+([\d.e+]+)\s+x\s+([\d.e+]+)/m.exec(stdout);
  if (!size) throw new Error('The page size could not be read.');
  const longest = Math.max(Number(size[1]), Number(size[2]));
  const pageDpi = Math.min(dpi, Math.floor((MAX_PAGE_PX * 72) / longest));
  if (!(pageDpi >= 1)) throw new Error('The page is too large to render.');
  await run(
    'pdftoppm',
    [
      // The crop box (the page as shown) is what pdfinfo measured, so it is what is rendered.
      ...['-f', page, '-l', page, '-cropbox', '-r', String(pageDpi)],
      ...['-jpeg', '-jpegopt', 'quality=90', '-singlefile', path, out],
    ],
    { timeout: PAGE_TIMEOUT_MS },
  );
  try {
    return await readFile(`${out}.jpg`);
  } finally {
    await rm(`${out}.jpg`, { force: true });
  }
}
