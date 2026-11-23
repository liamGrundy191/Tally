// The lists that help reading (5.4), pasted as text. Names here are invented.
import { describe, expect, it } from 'vitest';
import { MAX_LIST_ENTRIES, MAX_LIST_LINE, parseList } from './lists.ts';

const entries = (kind: 'workplace' | 'name', text: string) => {
  const parsed = parseList(kind, text);
  if (!parsed.ok) throw new Error(parsed.problem);
  return parsed.entries;
};

describe('parseList', () => {
  it('takes one entry per line, skipping blank lines and extra spaces', () => {
    expect(entries('name', '  Kwame \r\n\n  Dana   Levi\n')).toEqual([
      { name: 'Kwame', spellings: [] },
      { name: 'Dana Levi', spellings: [] },
    ]);
  });

  it('skips comment lines starting with #, as in names.txt and workplaces.txt', () => {
    expect(entries('workplace', '# the places\n  # indented\nדולב = Dolev')).toEqual([
      { name: 'דולב', spellings: ['Dolev'] },
    ]);
  });

  it('removes invisible characters that copying can add', () => {
    expect(entries('name', '\u200fKwame\u200e\ufeff')).toEqual([{ name: 'Kwame', spellings: [] }]);
  });

  it('names a workplace by its Hebrew spelling, whichever side it is on (D36)', () => {
    expect(entries('workplace', 'Golan Farm = חוות גולן\nבית הדר = Beit Hadar')).toEqual([
      { name: 'חוות גולן', spellings: ['Golan Farm'] },
      { name: 'בית הדר', spellings: ['Beit Hadar'] },
    ]);
  });

  it('names a worker by the English spelling, as in the Excel (5.2)', () => {
    expect(entries('name', 'דנה = Dana\nYossi = יוסי')).toEqual([
      { name: 'Dana', spellings: ['דנה'] },
      { name: 'Yossi', spellings: ['יוסי'] },
    ]);
  });

  it('accepts two columns copied from Excel, which arrive separated by a tab', () => {
    expect(entries('workplace', 'Golan Farm\tחוות גולן\nNew Place\t')).toEqual([
      { name: 'חוות גולן', spellings: ['Golan Farm'] },
      { name: 'New Place', spellings: [] },
    ]);
  });

  it('drops the apostrophe the Excel puts before a name starting with - (6.2)', () => {
    expect(entries('name', "'-Ann\tאן")).toEqual([{ name: '-Ann', spellings: ['אן'] }]);
  });

  it('keeps a name that appears on several lines once, with all its spellings', () => {
    expect(entries('name', 'Dana\nדנה = Dana\nDana = Danna\nDana')).toEqual([
      { name: 'Dana', spellings: ['דנה', 'Danna'] },
    ]);
  });

  it('refuses a line that is too long, saying which line', () => {
    expect(parseList('name', `Dana\n${'x'.repeat(MAX_LIST_LINE + 1)}`)).toEqual({
      ok: false,
      problem: `Line 2 is longer than ${MAX_LIST_LINE} characters.`,
    });
  });

  it('refuses a list with too many entries', () => {
    const text = Array.from({ length: MAX_LIST_ENTRIES + 1 }, (_, i) => `Worker ${i}`).join('\n');
    expect(parseList('name', text)).toEqual({
      ok: false,
      problem: `The list has more than ${MAX_LIST_ENTRIES} entries.`,
    });
  });

  it('gives an empty list for empty text, so a list can be cleared', () => {
    expect(entries('workplace', ' \n ')).toEqual([]);
  });
});
