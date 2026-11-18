// `pnpm ticket:pdf`: writes the blank printable ticket (A4, two A5 slips) to tickets-v1.pdf.
import { writeFileSync } from 'node:fs';
import { renderTicketPdf } from './pdf.ts';

writeFileSync('tickets-v1.pdf', await renderTicketPdf());
console.log('Wrote tickets-v1.pdf');
