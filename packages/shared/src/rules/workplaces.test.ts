import { describe, expect, it } from 'vitest';
import { normaliseName } from './names.ts';
import { areSimilarWorkplaces, findSimilarWorkplaces, levenshtein } from './workplaces.ts';

const similar = (a: string, b: string) => areSimilarWorkplaces(normaliseName(a), normaliseName(b));

describe('edit distance', () => {
  it.each([
    ['', '', 0],
    ['', 'abc', 3],
    ['kitten', 'sitting', 3],
    ['דוד', 'דויד', 1],
    ['סופר', 'סופר', 0],
  ])('%j → %j is %i', (a, b, d) => {
    expect(levenshtein(a, b)).toBe(d);
  });
});

describe('workplace grouping: same normalised name means same group, no question asked', () => {
  it.each([
    ['סופר-פארם', 'סופר פארם'],
    ['Super-Pharm', 'super pharm'],
    ['מקדונלד׳ס', "מקדונלד'ס"],
    ['  רמי לוי ', 'רמי לוי'],
  ])('%j and %j share a group', (a, b) => {
    expect(normaliseName(a)).toBe(normaliseName(b));
  });
});

describe('WORKPLACE_SIMILAR: similar but not the same, so a person decides', () => {
  it.each([
    ['a missing space', 'סופר פארם', 'סופרפארם'],
    ['one letter different', 'רמי לוי', 'רמי לוו'],
    ['two letters different', 'רמי לוי', 'רמה לוו'],
    ['one name inside the other', 'סופר פארם', 'סופר פארם רמת גן'],
    ['a branch number added', 'שופרסל', 'שופרסל 3'],
    ['English and short', 'AM', 'PM'],
  ])('asks about %s: %j / %j', (_case, a, b) => {
    expect(similar(a, b)).toBe(true);
  });

  it.each([
    ['different places', 'שופרסל', 'סופר פארם'],
    ['three letters different', 'אבגד', 'אהוז'],
  ])('does not ask about %s: %j / %j', (_case, a, b) => {
    expect(similar(a, b)).toBe(false);
  });

  it('never treats an empty or punctuation-only workplace as similar to anything', () => {
    expect(similar('', 'שופרסל')).toBe(false);
    expect(similar('-', 'שופרסל')).toBe(false);
  });

  it('lists each similar pair once; in a chain (A~B, B~C) A and C are only paired if similar themselves', () => {
    const groups = [
      { id: 'a', normalisedName: normaliseName('סופר פארם') },
      { id: 'b', normalisedName: normaliseName('סופרפארם') },
      { id: 'c', normalisedName: normaliseName('סופרפארמ ב') },
      { id: 'd', normalisedName: normaliseName('שופרסל') },
    ];
    // 'סופר פארם' → 'סופרפארם ב' is three edits and neither contains the other.
    expect(findSimilarWorkplaces(groups)).toEqual([
      ['a', 'b'],
      ['b', 'c'],
    ]);
  });
});
