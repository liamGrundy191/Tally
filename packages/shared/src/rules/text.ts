/** Invisible characters a reader or keyboard may insert: bidi marks, zero-width spaces, BOM. */
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;

export const stripInvisible = (s: string) => s.replace(INVISIBLE, '');

/** True when the value is missing or only whitespace. */
export const isBlank = (s: string | null | undefined): boolean =>
  s == null || stripInvisible(s).trim() === '';
