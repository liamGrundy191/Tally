import { describe, expect, it } from 'vitest';
import {
  autoDeleteOn,
  daysBetween,
  isMonthName,
  monthName,
  parseTicketDate,
  todayIn,
  warnFrom,
} from './date.ts';

describe('reading the ticket date (DD/MM/YY)', () => {
  it.each([
    ['18/11/26', '2026-11-18'],
    ['181126', '2026-11-18'],
    ['18.11.26', '2026-11-18'],
    ['18-11-26', '2026-11-18'],
    ['1/2/26', '2026-02-01'],
    ['18/11/2026', '2026-11-18'],
    ['18112026', '2026-11-18'],
    [' 18 / 11 / 26 ', '2026-11-18'],
    ['\u200f18/11/26', '2026-11-18'],
    ['29/02/28', '2028-02-29'],
    ['31/12/26', '2026-12-31'],
    ['18/11/1926', '1926-11-18'],
  ])('reads %j as %s', (raw, iso) => {
    expect(parseTicketDate(raw)).toEqual({ ok: true, date: iso });
  });

  it.each([
    ['31/02/26', '31/02 is not a real date'],
    ['29/02/26', '2026 is not a leap year'],
    ['31/04/26', 'April has 30 days'],
    ['00/11/26', 'day 0'],
    ['18/00/26', 'month 0'],
    ['18/13/26', 'month 13'],
    ['11/18/26', 'month-first (US) order gives month 18'],
    ['00/00/00', 'all zeros'],
    ['18/11/0026', 'year 26 AD'],
    ['18/11/2126', 'year beyond 2099'],
  ])('flags %j as not a real date (%s)', (raw) => {
    expect(parseTicketDate(raw)).toEqual({ ok: false, reason: 'not_a_date' });
  });

  it.each([['1811'], ['18/11'], ['18/11/6'], ['18/11/026'], ['18//26'], ['abc'], ['']])(
    'flags %j as unreadable as a date',
    (raw) => {
      expect(parseTicketDate(raw)).toEqual({ ok: false, reason: 'unparseable' });
    },
  );
});

describe('counting days', () => {
  it('counts whole days between two dates', () => {
    expect(daysBetween('2026-11-18', '2026-11-18')).toBe(0);
    expect(daysBetween('2026-10-04', '2026-11-18')).toBe(45);
    expect(daysBetween('2026-11-18', '2026-11-17')).toBe(-1);
  });

  it('is not thrown off by daylight-saving changes', () => {
    // Israel moves clocks back on 25 Oct 2026; days are still whole.
    expect(daysBetween('2026-10-24', '2026-10-26')).toBe(2);
  });

  it('crosses a leap day and a year end', () => {
    expect(daysBetween('2028-02-28', '2028-03-01')).toBe(2);
    expect(daysBetween('2026-12-31', '2027-01-01')).toBe(1);
  });
});

describe("today's date is taken in Israel time, not the server's clock", () => {
  it('23:30 UTC on 18 Nov is already 19 Nov in Israel', () => {
    expect(todayIn('Asia/Jerusalem', new Date('2026-11-18T23:30:00Z'))).toBe('2026-11-19');
  });

  it('21:30 UTC on 18 Nov is still 18 Nov in Israel', () => {
    expect(todayIn('Asia/Jerusalem', new Date('2026-11-18T21:30:00Z'))).toBe('2026-11-18');
  });
});

describe('closing a month (6.1)', () => {
  it('names a month the way the app shows it', () => {
    expect(monthName({ year: 2026, month: 11 })).toBe('November 2026');
    expect(monthName({ year: 2027, month: 1 })).toBe('January 2027');
  });

  it('accepts the typed name ignoring capitals and extra spaces, and nothing else', () => {
    const nov = { year: 2026, month: 11 };
    expect(isMonthName(' november   2026 ', nov)).toBe(true);
    expect(isMonthName('November 2026', nov)).toBe(true);
    expect(isMonthName('November 2025', nov)).toBe(false);
    expect(isMonthName('October 2026', nov)).toBe(false);
    expect(isMonthName('', nov)).toBe(false);
  });

  it('deletes a month 60 days after its last day, warning from day 50', () => {
    expect(autoDeleteOn({ year: 2026, month: 11 })).toBe('2027-01-29');
    expect(warnFrom({ year: 2026, month: 11 })).toBe('2027-01-19');
    expect(autoDeleteOn({ year: 2026, month: 12 })).toBe('2027-03-01');
    expect(autoDeleteOn({ year: 2028, month: 2 })).toBe('2028-04-29'); // leap February
  });
});
