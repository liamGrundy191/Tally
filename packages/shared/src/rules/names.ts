// Name normalisation (plan section 5.1) is for comparison only. Exports show names as read.
import { stripInvisible } from './text.ts';

const FINAL_LETTERS: Record<string, string> = { ך: 'כ', ם: 'מ', ן: 'נ', ף: 'פ', ץ: 'צ' };

/** Hyphen, Unicode dashes, Hebrew maqaf and minus sign. Treated the same as a space. */
const HYPHENS = /[-‐-―־−]/g;

/**
 * Trim; collapse spaces; remove punctuation, quotes, geresh/gershayim and niqqud; unify Hebrew
 * final letters; lower-case Latin letters; hyphens and spaces are equal.
 */
export function normaliseName(raw: string): string {
  return stripInvisible(raw)
    .normalize('NFKD') // splits Hebrew presentation forms and accented letters into base + mark
    .replace(/\p{M}/gu, '') // niqqud, cantillation marks, Latin accents
    .replace(HYPHENS, ' ')
    .replace(/[\p{P}\p{S}]/gu, '') // quotes, geresh, gershayim and all other punctuation or symbols
    .replace(/[ךםןףץ]/g, (c) => FINAL_LETTERS[c]!)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export type NameProblem = 'unexpected_characters' | 'mixed_scripts';

/** Hebrew or Latin letters, spaces, hyphens, apostrophes, quotes, geresh/gershayim, full stop. */
const ALLOWED_IN_NAME = /^[א-תA-Za-z\s\-‐-―־'`´‘’"“”׳״.]*$/;

/**
 * Names may be Hebrew or English. Anything else (digits, other alphabets, symbols), or Hebrew
 * and English letters mixed in one name, is probably a misreading and goes to a person.
 */
export function nameProblem(raw: string): NameProblem | null {
  const s = stripInvisible(raw).normalize('NFKD').replace(/\p{M}/gu, '');
  if (!ALLOWED_IN_NAME.test(s)) return 'unexpected_characters';
  if (/[א-ת]/.test(s) && /[A-Za-z]/.test(s)) return 'mixed_scripts';
  return null;
}
