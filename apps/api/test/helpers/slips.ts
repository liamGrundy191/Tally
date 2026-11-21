// Test scans: PDFs whose pages are blank printed slips, with their corner markers, as a
// sheet-fed scanner gives them. Made from the real ticket template, so no real scan is stored.
import { renderTicketPdf } from '@tally/shared/ticket-pdf';
import { PDFDocument } from 'pdf-lib';

const MM = 72 / 25.4;
const SLIP = { width: 157.5 * MM, height: 74.25 * MM };
const MARGIN = 8 * MM; // white scanner margin around the slip
let template: Uint8Array | undefined;

/** A PDF of `pages` slips. `title` makes each file's bytes different, so it is not a duplicate. */
export async function slipsPdf(pages: number, title: string) {
  template ??= await renderTicketPdf();
  const source = (await PDFDocument.load(template)).getPage(0);
  const top = source.getHeight();
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  const slip = await doc.embedPage(source, {
    left: 0,
    right: SLIP.width,
    top,
    bottom: top - SLIP.height,
  });
  for (let i = 0; i < pages; i++) {
    doc
      .addPage([SLIP.width + 2 * MARGIN, SLIP.height + 2 * MARGIN])
      .drawPage(slip, { x: MARGIN, y: MARGIN });
  }
  return doc.save();
}
