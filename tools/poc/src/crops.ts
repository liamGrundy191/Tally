// `pnpm crops <scan>`: straightens each ticket in a scan (PDF, JPEG or PNG) and saves the
// straightened ticket and every field crop to scan-output/<scan name>/, so a person can check them.
// Free: no AI calls. The scan-output/ folder is not committed.
import { TEMPLATE_V1 } from '@tally/shared';
import { prepareTicket } from '@tally/shared/imaging';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { scanPages } from './pages.ts';

const path = process.argv[2];
if (!path) {
  console.error('Usage: pnpm crops <scan: .pdf, .jpg or .png>');
  process.exit(1);
}
const outRoot = join('scan-output', basename(path, extname(path)));
const pages = await scanPages(path);
for (const [i, page] of pages.entries()) {
  const prepared = await prepareTicket(page, TEMPLATE_V1);
  const dir = join(outRoot, `page-${i + 1}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'ticket.jpg'), prepared.ticket.data);
  for (const [field, crop] of Object.entries(prepared.crops ?? {})) {
    writeFileSync(join(dir, `${field}.jpg`), crop.data);
  }
  const flags = prepared.flags.map((f) => f.code).join(', ') || 'none';
  console.log(
    `Page ${i + 1}: markers ${prepared.markersFound ? 'found' : 'NOT found'}, flags: ${flags} → ${dir}`,
  );
}
