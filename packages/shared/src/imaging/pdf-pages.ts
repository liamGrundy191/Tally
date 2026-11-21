import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Step 1 for PDFs: one PNG per page, rendered by poppler's pdftoppm. */
export async function pdfToImages(pdf: Buffer, dpi = 200): Promise<Buffer[]> {
  const dir = await mkdtemp(join(tmpdir(), 'tally-pdf-'));
  try {
    await writeFile(join(dir, 'in.pdf'), pdf);
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
    const { stdout } = await run('pdfinfo', [path]);
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
 * pdfToImages. One page at a time keeps memory small for a 300-page scan.
 */
export async function pdfPageToJpeg(path: string, pageIndex: number, dpi = 200): Promise<Buffer> {
  const out = `${path}-page`;
  const page = String(pageIndex + 1);
  await run('pdftoppm', [
    ...['-f', page, '-l', page, '-r', String(dpi)],
    ...['-jpeg', '-jpegopt', 'quality=90', '-singlefile', path, out],
  ]);
  try {
    return await readFile(`${out}.jpg`);
  } finally {
    await rm(`${out}.jpg`, { force: true });
  }
}
