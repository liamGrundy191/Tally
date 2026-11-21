import { describe, expect, it } from 'vitest';
import { type DuplicateCandidate, findPossibleDuplicates, namesMatch } from './duplicates.ts';

const at = (h: number, m = 0) => h * 60 + m;
let n = 0;
const ticket = (over: Partial<DuplicateCandidate> = {}): DuplicateCandidate => ({
  id: `t${++n}`,
  name: 'דוד',
  workplaceGroupId: 'super-pharm',
  shiftDate: '2026-11-10',
  startMinutes: at(8),
  endMinutes: at(16),
  ...over,
});
const dupes = (...tickets: DuplicateCandidate[]) => findPossibleDuplicates(tickets);

describe('POSSIBLE_DUPLICATE: same name, same place, same date, whatever the times (D39)', () => {
  it('two Davids at one place with overlapping shifts are asked about (they may be two people)', () => {
    const a = ticket();
    const b = ticket({ startMinutes: at(12), endMinutes: at(20) });
    expect(dupes(a, b)).toEqual([[a.id, b.id]]);
  });

  it('the same ticket scanned twice is asked about', () => {
    const a = ticket();
    const b = ticket();
    expect(dupes(a, b)).toEqual([[a.id, b.id]]);
  });

  it('two identical 0-minute tickets are asked about', () => {
    const a = ticket({ startMinutes: at(8), endMinutes: at(8) });
    const b = ticket({ startMinutes: at(8), endMinutes: at(8) });
    expect(dupes(a, b)).toHaveLength(1);
  });

  it('three copies give three pairs', () => {
    expect(dupes(ticket(), ticket(), ticket())).toHaveLength(3);
  });

  it('two night shifts on the same date that overlap are asked about (22:00–06:00 and 23:00–07:00)', () => {
    const a = ticket({ startMinutes: at(22), endMinutes: at(6) });
    const b = ticket({ startMinutes: at(23), endMinutes: at(7) });
    expect(dupes(a, b)).toHaveLength(1);
  });

  it('names match despite niqqud, final letters, hyphens and capitals', () => {
    expect(namesMatch('אברהם', 'אברהמ')).toBe(true);
    expect(namesMatch('דָּוִד', 'דוד')).toBe(true);
    expect(namesMatch('בן-דוד', 'בן דוד')).toBe(true);
    expect(namesMatch('David', 'DAVID')).toBe(true);
  });

  it('names match in swapped order ("דוד כהן" / "כהן דוד")', () => {
    expect(namesMatch('דוד כהן', 'כהן דוד')).toBe(true);
  });

  it('names match when one adds a surname ("דוד" / "דוד כהן")', () => {
    expect(namesMatch('דוד', 'דוד כהן')).toBe(true);
    expect(dupes(ticket({ name: 'דוד' }), ticket({ name: 'דוד כהן' }))).toHaveLength(1);
  });

  it('asks about back-to-back shifts too (08:00–16:00 then 16:00–22:00)', () => {
    expect(dupes(ticket(), ticket({ startMinutes: at(16), endMinutes: at(22) }))).toHaveLength(1);
  });

  it('asks about a night and a morning shift on the same date (22:00–06:00 and 05:00–09:00)', () => {
    const night = ticket({ startMinutes: at(22), endMinutes: at(6) });
    const morning = ticket({ startMinutes: at(5), endMinutes: at(9) });
    expect(dupes(night, morning)).toHaveLength(1);
  });

  it('asks when either ticket has unknown times but everything else matches', () => {
    const a = ticket({ endMinutes: null });
    const b = ticket({ startMinutes: at(18), endMinutes: at(22) });
    expect(dupes(a, b)).toHaveLength(1);
  });
});

describe('POSSIBLE_DUPLICATE is not raised when the tickets clearly differ', () => {
  it('different names (דוד / דויד)', () => {
    expect(dupes(ticket({ name: 'דוד' }), ticket({ name: 'דויד' }))).toEqual([]);
  });

  it('different names sharing one word ("דוד כהן" / "דוד לוי")', () => {
    expect(namesMatch('דוד כהן', 'דוד לוי')).toBe(false);
  });

  it('a repeated word must appear twice in the other name ("דוד דוד" / "דוד כהן")', () => {
    expect(namesMatch('דוד דוד', 'דוד כהן')).toBe(false);
  });

  it('different workplace groups, even at the same time', () => {
    expect(dupes(ticket(), ticket({ workplaceGroupId: 'shufersal' }))).toEqual([]);
  });

  it('different dates, even if the hours overlap (same date only)', () => {
    expect(dupes(ticket(), ticket({ shiftDate: '2026-11-11' }))).toEqual([]);
  });

  it('night shifts on consecutive nights (Mon 22:00–06:00, Tue 22:00–06:00)', () => {
    const mon = ticket({ shiftDate: '2026-11-09', startMinutes: at(22), endMinutes: at(6) });
    const tue = ticket({ shiftDate: '2026-11-10', startMinutes: at(22), endMinutes: at(6) });
    expect(dupes(mon, tue)).toEqual([]);
  });

  it('tickets without a name, workplace or date are not compared (they are flagged for that already)', () => {
    expect(dupes(ticket({ name: null }), ticket({ name: null }))).toEqual([]);
    expect(dupes(ticket({ name: ' - ' }), ticket({ name: ' - ' }))).toEqual([]);
    expect(dupes(ticket({ workplaceGroupId: null }), ticket({ workplaceGroupId: null }))).toEqual(
      [],
    );
    expect(dupes(ticket({ shiftDate: null }), ticket({ shiftDate: null }))).toEqual([]);
  });
});
