// The workplace PDFs (section 6.3): one PDF per workplace with each ready ticket's scan as one page,
// by date and then name, all in one ZIP or one workplace at a time. Made from the same ready
// tickets as the Excel, so the two always agree (principle 7, D55).
import { Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { PDFDocument } from 'pdf-lib';
import { PrismaClient } from '../generated/prisma/client.ts';
import { Storage } from '../storage.ts';
import { readyPlaces } from './excel.ts';
import { MonthsService } from './months.service.ts';
import { zip } from './zip.ts';

const MONTHS = [
  'ינואר',
  'פברואר',
  'מרץ',
  'אפריל',
  'מאי',
  'יוני',
  'יולי',
  'אוגוסט',
  'ספטמבר',
  'אוקטובר',
  'נובמבר',
  'דצמבר',
];
const SCAN_DPI = 200; // pages are scanned at 200 dpi, so each prints at its paper's size

/**
 * "<workplace> <month> <year>.pdf" (Liam, Q13): characters Windows or a ZIP path forbid are
 * removed, and ` (2)`, ` (3)` are added when two names (compared ignoring capitals) would be the same.
 */
export function fileNames(places: string[], month: string) {
  const taken = new Set<string>();
  return places.map((place) => {
    let base = place
      .replace(/[\\/:*?"<>|]|\p{Cc}/gu, '')
      .trim()
      .replace(/[. ]+$/, '');
    base = [...base].slice(0, 100).join('').trim() || 'מקום עבודה'; // never half a character
    for (let i = 1; ; i++) {
      const name = `${base} ${month}${i === 1 ? '' : ` (${i})`}.pdf`;
      if (!taken.has(name.toLowerCase())) {
        taken.add(name.toLowerCase());
        return name;
      }
    }
  });
}

@Injectable()
export class WorkplacePdfExporter {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly months: MonthsService,
    private readonly storage: Storage,
  ) {}

  /** All the workplace PDFs in one ZIP. */
  async all(monthId: string) {
    const { month, places, names } = await this.ready(monthId);
    // shortcut: holds every workplace PDF in memory (about the month's scans); stream them one by
    // one if the production server runs short (T4.3).
    const files = [];
    for (const [i, p] of places.entries()) files.push({ name: names[i]!, data: await this.pdf(p) });
    const mm = String(month.month).padStart(2, '0');
    return { zip: zip(files), filename: `tickets-${month.year}-${mm}.zip` };
  }

  /** One workplace's PDF. */
  async one(monthId: string, groupId: string) {
    const { places, names } = await this.ready(monthId);
    const i = places.findIndex((p) => p.groupId === groupId);
    if (i < 0) throw new NotFoundException('This workplace has no ready tickets in this month.');
    return { pdf: await this.pdf(places[i]!), filename: names[i]! };
  }

  /** The same ready tickets as the Excel, and each workplace's file name. */
  private async ready(monthId: string) {
    const { month, places } = await this.prisma.$transaction(
      (tx) => readyPlaces(tx, this.months, monthId),
      { isolationLevel: 'RepeatableRead' },
    );
    const names = fileNames(
      places.map((p) => p.name),
      `${MONTHS[month.month - 1]} ${month.year}`,
    );
    return { month, places, names };
  }

  private async pdf(place: Awaited<ReturnType<typeof readyPlaces>>['places'][number]) {
    // Rows come sorted by name, and a row's tickets by date and arrival: sorting by date alone
    // (a stable sort) gives date, then name, then the order the scans came in.
    const tickets = place.rows
      .flatMap((r) => r.tickets)
      .sort((a, b) => a.shiftDate!.getTime() - b.shiftDate!.getTime());
    const scans = await Promise.all(
      tickets.map(async (t) => {
        const file = await this.storage.get(t.s3KeyPage);
        // Never a PDF short of a ticket without a word (6.1).
        if (!file) {
          throw new InternalServerErrorException(
            'The scan of a ticket is missing, so the PDFs were not made.',
          );
        }
        // A copy of its own: pdf-lib reads a small Buffer's shared pool from its start.
        return new Uint8Array(Buffer.concat(await file.body.toArray()));
      }),
    );
    const doc = await PDFDocument.create();
    for (const scan of scans) {
      const image = await doc.embedJpg(scan); // the JPEG as stored, not encoded again
      const width = (image.width * 72) / SCAN_DPI;
      const height = (image.height * 72) / SCAN_DPI;
      doc.addPage([width, height]).drawImage(image, { x: 0, y: 0, width, height });
    }
    return Buffer.from(await doc.save());
  }
}
