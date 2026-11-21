import { describe, expect, it } from 'vitest';
import { englishName, hasHebrew, nameProblem, normaliseName } from './names.ts';

const RLM = String.fromCharCode(0x200f);
const NBSP = String.fromCharCode(0xa0);

describe('name normalisation (for comparing names, never for display)', () => {
  it.each([
    ['trims and collapses spaces', '  דוד   כהן ', 'דוד כהנ'],
    ['removes niqqud', 'דָּוִד', 'דוד'],
    ['unifies Hebrew final letters', 'אברהם', 'אברהמ'],
    ['unifies all five final letters', 'ך ם ן ף ץ', 'כ מ נ פ צ'],
    ['removes geresh', 'ג׳ורג׳', 'גורג'],
    ['removes gershayim', 'רמב״ם', 'רמבמ'],
    ['removes ASCII apostrophes and quotes', `ג'ורג' "דוד"`, 'גורג דוד'],
    ['treats a hyphen as a space', 'בן-דוד', 'בנ דוד'],
    ['treats a maqaf (Hebrew hyphen) as a space', 'בן־דוד', 'בנ דוד'],
    ['treats an en dash as a space', 'בן–דוד', 'בנ דוד'],
    ['lower-cases Latin letters', 'David COHEN', 'david cohen'],
    ['removes Latin accents', 'José', 'jose'],
    ['removes invisible right-to-left marks', `${RLM}דוד${RLM}`, 'דוד'],
    ['treats a non-breaking space as a space', `דוד${NBSP}כהן`, 'דוד כהנ'],
    ['unpacks Hebrew presentation forms (שׁ)', 'שׁרה', 'שרה'],
    ['removes other punctuation', 'כהן.', 'כהנ'],
    ['keeps digits (for workplaces like branch numbers)', 'סניף 3', 'סניפ 3'],
  ])('%s', (_rule, raw, expected) => {
    expect(normaliseName(raw)).toBe(expected);
  });

  it('makes "סופר-פארם" and "סופר פארם" equal', () => {
    expect(normaliseName('סופר-פארם')).toBe(normaliseName('סופר פארם'));
  });

  it('keeps genuinely different spellings different (דוד / דויד)', () => {
    expect(normaliseName('דוד')).not.toBe(normaliseName('דויד'));
  });

  it('keeps a missing space different from a space (בן דוד / בןדוד)', () => {
    expect(normaliseName('בן דוד')).not.toBe(normaliseName('בןדוד'));
  });

  it('turns punctuation-only input into an empty string', () => {
    expect(normaliseName(' - ״ . ')).toBe('');
  });
});

describe('SCRIPT_UNEXPECTED: names that are not plain Hebrew or English', () => {
  it.each([
    ['Hebrew', 'דוד'],
    ['Hebrew with niqqud', 'דָּוִד'],
    ['Hebrew with a final letter', 'אברהם'],
    ['English', 'David'],
    ['English with an apostrophe', "O'Brien"],
    ['Hebrew with geresh', 'ג׳ורג׳'],
    ['a hyphenated surname', 'בן-דוד'],
    ['two words', 'בת שבע'],
    ['an initial with a full stop', 'J. Smith'],
  ])('accepts %s', (_case, name) => {
    expect(nameProblem(name)).toBeNull();
  });

  it.each([
    ['a digit inside a Hebrew name (likely misread)', 'ד4וד'],
    ['digits only', '123'],
    ['Arabic letters', 'محمد'],
    ['Russian letters', 'Иван'],
    ['a symbol', 'דוד@'],
    ['brackets', 'דוד (כהן)'],
  ])('flags %s', (_case, name) => {
    expect(nameProblem(name)).toBe('unexpected_characters');
  });

  it('flags Hebrew and English letters mixed in one name', () => {
    expect(nameProblem('Davidכהן')).toBe('mixed_scripts');
    expect(nameProblem('David כהן')).toBe('mixed_scripts');
  });
});

describe('englishName: a name as the Excel shows it (5.2)', () => {
  it('turns block letters into a capital and small letters', () => {
    expect(englishName('KWAME')).toBe('Kwame');
    expect(englishName('  kwame   B ')).toBe('Kwame B');
    expect(englishName('MARY-ANN')).toBe('Mary-Ann');
  });

  it('tells a Hebrew name from an English one', () => {
    expect(hasHebrew('דנה')).toBe(true);
    expect(hasHebrew('Dana')).toBe(false);
  });
});
