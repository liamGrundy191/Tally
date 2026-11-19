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
