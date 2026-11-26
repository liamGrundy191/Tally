import { describe, expect, it } from 'vitest';
import { hoursToMinutes, onRate57List, parseList } from '../index.ts';

describe('morning hours as typed (D66)', () => {
  it('reads decimals as exact minutes', () => {
    expect(hoursToMinutes('37.5')).toBe(2250);
    expect(hoursToMinutes('4.25')).toBe(255);
    expect(hoursToMinutes('8')).toBe(480);
    expect(hoursToMinutes('0.1')).toBe(6);
    expect(hoursToMinutes(' 7,75 ')).toBe(465); // a comma, as Hebrew Excel writes it
  });

  it('refuses what is not a whole number of minutes above zero, rather than round it', () => {
    for (const bad of ['37.33', '0', '0.0', '-3', '', 'abc', '1.234', '1000'])
      expect(hoursToMinutes(bad)).toBeNull();
  });
});

describe('the 57 list (D66)', () => {
  const list = (text: string, kind: 'rate57' | 'workplace') => {
    const r = parseList(kind, text);
    if (!r.ok) throw new Error(r.problem);
    return r.entries;
  };
  const workplaces = list('משק ברזלי = Barzilai Farm\nבית הדר', 'workplace');
  const rate57 = list('Avi Cohen = משק ברזלי = בית הדר', 'rate57');

  it('keeps the English name first and the places after it', () => {
    expect(rate57).toEqual([{ name: 'Avi Cohen', spellings: ['משק ברזלי', 'בית הדר'] }]);
  });

  it('matches the name and one of its places, as grouping compares them', () => {
    expect(onRate57List(rate57, workplaces, 'avi  cohen', 'משק ברזלי')).toBe(true);
    expect(onRate57List(rate57, workplaces, 'Avi Cohen', 'בית הדר')).toBe(true);
    // The place's English spelling on the workplace list is the same place.
    expect(onRate57List(rate57, workplaces, 'Avi Cohen', 'Barzilai Farm')).toBe(true);
  });

  it('does not match the same name at another place, another name, or nothing', () => {
    expect(onRate57List(rate57, workplaces, 'Avi Cohen', 'חוות גולן')).toBe(false);
    expect(onRate57List(rate57, workplaces, 'Avi Levi', 'משק ברזלי')).toBe(false);
    expect(onRate57List(rate57, workplaces, '', 'משק ברזלי')).toBe(false);
    expect(onRate57List([], workplaces, 'Avi Cohen', 'משק ברזלי')).toBe(false);
  });
});
