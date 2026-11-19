import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeUtf8, parseCsv, toCsv } from './csv.ts';
import { readTruth, truthTemplate } from './truth.ts';

const dir = mkdtempSync(join(tmpdir(), 'tally-truth-'));
const HEADER = 'file,page,firstName,workplace,date,startTime,endTime,totalWorked,voided';
const write = (name: string, text: string | Buffer) => {
  const p = join(dir, name);
  writeFileSync(p, text);
  return p;
};

describe('CSV as Excel writes it', () => {
  it('handles a BOM, CRLF line ends, quotes, and blank lines', () => {
    const text = '\uFEFFa,b\r\n"x, y","say ""hi"""\r\n\r\n1,2\r\n';
    expect(parseCsv(text)).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"'],
      ['1', '2'],
    ]);
  });

  it('accepts ; as the separator when the header uses it', () => {
    expect(parseCsv('a;b\n1;2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('refuses a file that is not UTF-8, and says how to save it', () => {
    // "דנה" in the old Windows Hebrew code page, which plain "CSV" in Excel produces.
    expect(() => decodeUtf8(Buffer.from([0xe3, 0xf0, 0xe4]), 't.csv')).toThrow(/CSV UTF-8/);
  });

  it('starts the file with the UTF-8 marker bytes Excel looks for', () => {
    expect([...Buffer.from(toCsv([['a']]), 'utf8').subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });

  it('writes Hebrew Excel can open, and makes formula-like text harmless', () => {
    const csv = toCsv([
      ['=SUM(A1)', '+972', 'דנה, כהן', null],
      ['-5', '@x', 'plain', 3],
    ]);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(parseCsv(csv)).toEqual([
      ["'=SUM(A1)", "'+972", 'דנה, כהן', ''],
      ["'-5", "'@x", 'plain', '3'],
    ]);
  });
});

describe('reading truth.csv', () => {
  it('reads a filled-in file, with empty boxes as null', () => {
    const p = write(
      'ok.csv',
      `\uFEFF${HEADER}\r\nscan.pdf,1,דנה,סופר פארם,10/11/26,08:00,16:30,08:30,\r\nscan.pdf,2,,,,,,,yes\r\n`,
    );
    const t = readTruth(p);
    expect(t.errors).toEqual([]);
    expect(t.rows[0]).toEqual({
      file: 'scan.pdf',
      page: 1,
      values: {
        firstName: 'דנה',
        workplace: 'סופר פארם',
        date: '10/11/26',
        startTime: '08:00',
        endTime: '16:30',
        totalWorked: '08:30',
      },
      voided: false,
    });
    expect(t.rows[1]!.voided).toBe(true);
    expect(t.rows[1]!.values.firstName).toBeNull();
  });

  it('drops the seconds Excel adds to times, and accepts a four-digit year', () => {
    const p = write(
      'excel.csv',
      `${HEADER}\nscan.pdf,1,דנה,x,10/11/2026,08:00:00,16:30:00,8:30:00,no\n`,
    );
    const t = readTruth(p);
    expect(t.errors).toEqual([]);
    expect(t.warnings).toEqual([]);
    expect(t.rows[0]!.values).toMatchObject({
      startTime: '08:00',
      endTime: '16:30',
      totalWorked: '8:30',
    });
  });

  it('warns about a value that is not a valid time, but keeps it (it may be what was written)', () => {
    const p = write('odd.csv', `${HEADER}\nscan.pdf,1,דנה,x,10/11/26,25:00,16:30,08:30,\n`);
    const t = readTruth(p);
    expect(t.errors).toEqual([]);
    expect(t.warnings).toHaveLength(1);
    expect(t.rows[0]!.values.startTime).toBe('25:00');
  });

  it('refuses missing columns, bad page numbers, repeated tickets and unclear voided values', () => {
    expect(readTruth(write('cols.csv', 'file,page\nscan.pdf,1\n')).errors[0]).toMatch(
      /missing columns/,
    );
    const bad = readTruth(
      write(
        'bad.csv',
        `${HEADER}\nscan.pdf,0,,,,,,,\nscan.pdf,1,,,,,,,\nSCAN.pdf,1,,,,,,,\nscan.pdf,2,,,,,,,maybe\n`,
      ),
    );
    expect(bad.errors).toHaveLength(3);
    expect(bad.errors.join(' ')).toMatch(/page number.*appears twice.*yes or no/s);
  });

  it('the template has one empty row per ticket and reads back cleanly', () => {
    const p = write(
      'template.csv',
      truthTemplate([
        { file: 'a.pdf', page: 1 },
        { file: 'a.pdf', page: 2 },
      ]),
    );
    expect(readFileSync(p, 'utf8').split('\r\n')[0]).toBe(`\uFEFF${HEADER}`);
    const t = readTruth(p);
    expect(t.errors).toEqual([]);
    expect(t.rows.map((r) => [r.file, r.page, r.voided])).toEqual([
      ['a.pdf', 1, false],
      ['a.pdf', 2, false],
    ]);
  });
});
