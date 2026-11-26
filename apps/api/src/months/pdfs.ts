// The workplace PDFs (section 6.3): one PDF per workplace with each ready ticket's scan as one page,
// by date and then name, all in one ZIP or one workplace at a time. Made from the same ready
// tickets as the Excel, so the two always agree (principle 7, D55).
import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { PDFDocument } from 'pdf-lib';
import { PrismaClient } from '../generated/prisma/client.ts';
import { Storage } from '../storage.ts';
import { readyPlaces } from './excel.ts';
import { MonthsService } from './months.service.ts';
import { finalGroups } from './organiser.ts';
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
// A page of an uploaded PDF is stored at 200 dpi, so it prints at its paper's size; a photo keeps
// its pixels, and PDF viewers fit it to the page.
const SCAN_DPI = 200;

/**
 * "<workplace> <month> <year>.pdf" (Liam, Q13): characters Windows or a ZIP path forbid are
 * removed, and ` (2)`, ` (3)` are added when two names (compared ignoring capitals) would be the same.
 */
export function fileNames(places: string[], month: string) {
  const taken = new Set<string>();
  return places.map((place) => {
    let base = place
      .replace(/[\\/:*?"<>|]|[\p{Cc}\p{Cf}]/gu, '') // and invisible format characters
      .trim()
      .replace(/[. ]+$/, '');
    base = [...base].slice(0, 100).join('').trim() || 'מקום עבודה'; // never half a character
    if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(base)) base = `_${base}`; // Windows device names
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
    // one if the laptop runs short of memory.
    const files = [];
    for (const [i, p] of places.entries())
      files.push({ name: names[i]!, data: await this.pdf(monthId, p) });
    const mm = String(month.month).padStart(2, '0');
    return { zip: zip(files), filename: `tickets-${month.year}-${mm}.zip` };
  }

  /** One workplace's PDF. */
  async one(monthId: string, groupId: string) {
    const { places, names, top } = await this.ready(monthId);
    // A page opened before a merge still asks for the place it joined.
    const i = places.findIndex((p) => p.groupId === top(groupId));
    if (i < 0) throw new NotFoundException('This workplace has no ready tickets in this month.');
    return { pdf: await this.pdf(monthId, places[i]!), filename: names[i]! };
  }

  /** The same ready tickets as the Excel, and each workplace's file name. */
  private async ready(monthId: string) {
    const { month, places, groups } = await this.prisma.$transaction(
      async (tx) => ({
        ...(await readyPlaces(tx, this.months, monthId)),
        groups: await tx.workplaceGroup.findMany({
          where: { monthId },
          select: { id: true, mergedIntoId: true },
        }),
      }),
      { isolationLevel: 'RepeatableRead' },
    );
    const names = fileNames(
      places.map((p) => p.name),
      `${MONTHS[month.month - 1]} ${month.year}`,
    );
    return { month, places, names, top: finalGroups(groups) };
  }

  private async pdf(
    monthId: string,
    place: Awaited<ReturnType<typeof readyPlaces>>['places'][number],
  ) {
    // Rows come sorted by name, and a row's tickets by date and arrival: sorting by date alone
    // (a stable sort) gives date, then name, then the order the scans came in.
    const tickets = place.rows
      .flatMap((r) => r.tickets)
      .sort((a, b) => a.shiftDate!.getTime() - b.shiftDate!.getTime());
    const doc = await PDFDocument.create();
    // One scan at a time, so only one is held besides the PDF being built.
    // Another ticket's shifts share one scan (D68): it is shown once, at its first shift's date.
    const shown = new Set<string>();
    for (const t of tickets) {
      if (shown.has(t.s3KeyPage)) continue;
      shown.add(t.s3KeyPage);
      const file = await this.storage.get(t.s3KeyPage);
      // Never a PDF short of a ticket without a word (6.1).
      if (!file) {
        // Closed meanwhile: its scans are being deleted, which is not a fault.
        const month = await this.prisma.month.findUnique({ where: { id: monthId } });
        if (month?.status !== 'open') {
          throw new ConflictException('This month is being closed or is closed.');
        }
        throw new InternalServerErrorException(
          'The scan of a ticket is missing, so the PDFs were not made.',
        );
      }
      // A copy of its own: pdf-lib reads a small Buffer's shared pool from its start.
      const scan = new Uint8Array(Buffer.concat(await file.body.toArray()));
      const image = await doc.embedJpg(scan); // the JPEG as stored, not encoded again
      const width = (image.width * 72) / SCAN_DPI;
      const height = (image.height * 72) / SCAN_DPI;
      doc.addPage([width, height]).drawImage(image, { x: 0, y: 0, width, height });
    }
    return Buffer.from(await doc.save());
  }
}
