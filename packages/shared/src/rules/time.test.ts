import { describe, expect, it } from 'vitest';
import { formatMinutes, parseClock, parseDuration, shiftMinutes } from './time.ts';

describe('reading a clock time (start and end)', () => {
  it.each([
    ['08:30', 510],
    ['8:30', 510],
    ['0830', 510],
    ['830', 510],
    ['08.30', 510],
    [' 08 : 30 ', 510],
    ['00:00', 0],
    ['23:59', 1439],
  ])('reads %j as %i minutes after midnight', (raw, minutes) => {
    expect(parseClock(raw)).toBe(minutes);
  });

  it('ignores invisible right-to-left marks the reader may add', () => {
    expect(parseClock('\u200f08:30\u200e')).toBe(510);
  });

  it.each([
    ['24:00', 'hour 24 is only allowed as an end time'],
    ['25:00', 'hour above 24'],
    ['23:60', 'minutes above 59'],
    ['08:75', 'minutes above 59'],
    ['8.5', 'decimal hours, not HH:MM'],
    ['8', 'no minutes'],
    ['08:30:00', 'seconds'],
    ['8:3', 'one minute digit'],
    ['08-30', 'unknown separator'],
    ['', 'empty'],
    ['eight', 'words'],
    ['٠٨:٣٠', 'non-Latin digits'],
  ])('rejects %j (%s)', (raw) => {
    expect(parseClock(raw)).toBeNull();
  });

  it('accepts 24:00 as an end time, meaning midnight', () => {
    expect(parseClock('24:00', { allow24: true })).toBe(0);
    expect(parseClock('24:01', { allow24: true })).toBeNull();
  });
});

describe('reading the total worked', () => {
  it.each([
    ['08:30', 510],
    ['8:30', 510],
    ['00:00', 0],
    ['19:00', 1140],
    ['24:00', 1440],
    ['30:15', 1815],
  ])('reads %j as %i minutes', (raw, minutes) => {
    expect(parseDuration(raw)).toBe(minutes);
  });

  it.each([['8.5'], ['8'], ['08:60'], ['100:00'], ['']])('rejects %j', (raw) => {
    expect(parseDuration(raw)).toBeNull();
  });
});

describe('shift length from start and end (midnight allowed)', () => {
  it('same-day shift: 08:00 → 16:30 = 8:30', () => {
    expect(shiftMinutes(480, 990)).toBe(510);
  });

  it('midnight shift: 22:00 → 06:00 = 8:00', () => {
    expect(shiftMinutes(1320, 360)).toBe(480);
  });

  it('shift ending exactly at midnight: 16:00 → 00:00 = 8:00', () => {
    expect(shiftMinutes(960, 0)).toBe(480);
  });

  it('shift starting at midnight: 00:00 → 08:00 = 8:00', () => {
    expect(shiftMinutes(0, 480)).toBe(480);
  });

  it('start equal to end gives 0, never 24 hours', () => {
    expect(shiftMinutes(480, 480)).toBe(0);
  });

  it('one minute short of a day: 08:01 → 08:00 = 23:59', () => {
    expect(shiftMinutes(481, 480)).toBe(1439);
  });
});

describe('formatting minutes for messages', () => {
  it.each([
    [510, '8:30'],
    [0, '0:00'],
    [5, '0:05'],
    [1815, '30:15'],
  ])('%i minutes → %s', (minutes, text) => {
    expect(formatMinutes(minutes)).toBe(text);
  });
});
