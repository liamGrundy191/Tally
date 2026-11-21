/**
 * Invisible formatting characters a reader or keyboard may insert: bidi marks (including the
 * Arabic letter mark), zero-width spaces and joiners, soft hyphens, BOM.
 */
const INVISIBLE = /\p{Cf}/gu;

export const stripInvisible = (s: string) => s.replace(INVISIBLE, '');

/** True when the value is missing or only whitespace. */
export const isBlank = (s: string | null | undefined): boolean =>
  s == null || stripInvisible(s).trim() === '';
