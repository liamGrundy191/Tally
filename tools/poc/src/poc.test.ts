// End to end with the fake reader (T0.6 "Done when"): a folder of scans and a truth file in,
// a graded report and a mistakes file out. No network.
import { FakeExtractor } from '@tally/shared/extraction';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseCsv } from './csv.ts';
import { formatReport, mistakesCsv, runPoc, scanFolder } from './poc.ts';
import { readTruth } from './truth.ts';

const FIXTURES = new URL('../../../fixtures/extractions/', import.meta.url);
const settings = { today: '2026-11-18', minShiftHours: 2, maxShiftHours: 16, maxDateAgeDays: 45 };
const HEADER = 'file,page,firstName,workplace,date,startTime,endTime,totalWorked,voided';

let dir: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tally-poc-'));
  // Blank images: the fake reader ignores them; preparation flags the missing markers.
  const blank = await sharp({
    create: { width: 900, height: 320, channels: 3, background: '#fff' },
  })
    .png()
    .toBuffer();
  for (const name of ['clean', 'disputed', 'voided', 'broken'])
    writeFileSync(join(dir, `${name}.png`), blank);
  writeFileSync(join(dir, 'notes.txt'), 'not a scan');
  writeFileSync(
    join(dir, 'truth.csv'),
    [
      HEADER,
      // The clean ticket's start really says 09:00, but both readings agree on 08:00 (planted).
      'clean.png,1,יעל,סופר פארם,10/11/26,09:00,16:30,08:30,',
      'disputed.png,1,עומר,שופרסל,12/11/26,22:00,06:00,08:00,',
      'voided.png,1,נועה,רמי לוי,14/11/26,07:00,15:00,08:00,yes',
      'broken.png,1,יעל,סופר פארם,10/11/26,08:00,16:30,08:30,',
      'ghost.png,1,דנה,x,10/11/26,08:00,16:30,08:30,',
    ].join('\n'),
  );
});

describe('pnpm poc, end to end with the fake reader', () => {
  it('scans only the scan files, in name order, one ticket per image', async () => {
    const tickets = await scanFolder(dir);
    expect(tickets.map((t) => [t.file, t.page, t.item.input.id])).toEqual([
      ['broken.png', 1, 'broken'],
      ['clean.png', 1, 'clean'],
      ['disputed.png', 1, 'disputed'],
      ['voided.png', 1, 'voided'],
    ]);
    expect(tickets[0]!.item.imageFlags.map((f) => f.code)).toEqual(['MARKERS_NOT_FOUND']);
  });

  it('reads, grades and reports every outcome', async () => {
    const tickets = await scanFolder(dir);
    const truth = readTruth(join(dir, 'truth.csv'));
    expect(truth.errors).toEqual([]);
    const { report } = await runPoc(tickets, truth.rows, {
      extractor: new FakeExtractor(FIXTURES),
      settings,
    });

    expect(report).toMatchObject({
      tickets: 4,
      graded: 4,
      failed: 1,
      truthWithoutTicket: ['ghost.png page 1'],
    });
    expect(report.voided).toEqual({ caught: 1, missed: 0, wronglyMarked: 0 });
    // The planted wrong start time is the one dangerous mistake, and it fails the gate.
    expect(report.gate).toEqual({ datesTimesWrongNotFlagged: 1, missedVoided: 0, pass: false });
    expect(report.mistakes[0]).toMatchObject({
      file: 'clean.png',
      field: 'startTime',
      what: 'WRONG AND NOT FLAGGED',
    });
    // Disputed: the end time's guess is right (passes A and C agree); the total has no guess.
    expect(report.fields.endTime.flagged_right_guess).toBe(1);
    // The total of the disputed ticket has no guess; the failed ticket adds one per box.
    expect(report.fields.totalWorked.flagged_no_guess).toBe(2);
    expect(report.fields.firstName.flagged_no_guess).toBe(1);
    expect(
      report.mistakes.some((m) => m.file === 'broken.png' && /reading failed/.test(m.what)),
    ).toBe(true);

    const text = formatReport(report, 'Cost: $0');
    expect(text).toMatch(/Gate G0: FAIL: 1 wrong/);
    expect(text).toMatch(/Truth rows with no scan: ghost.png page 1/);
    const rows = parseCsv(mistakesCsv(report));
    expect(rows[0]).toEqual([
      'file',
      'page',
      'box',
      'what happened',
      'really written',
      'system shows',
      'flags on the box',
    ]);
    expect(rows[1]).toEqual([
      'clean.png',
      '1',
      'start',
      'WRONG AND NOT FLAGGED',
      '09:00',
      '08:00',
      '',
    ]);
  });
});
