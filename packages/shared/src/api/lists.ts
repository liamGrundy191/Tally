// The workplace and names lists that help reading (5.4), shared by all months (D42). The user
// pastes them as text, one entry per line; a line may give one entry's spellings in both
// languages ("Golan Farm = חוות גולן"), or two columns copied from Excel. Shared so the API and
// the web app read a list the same way.
import { z } from 'zod';
import { normaliseName } from '../rules/names.ts';
import { stripInvisible } from '../rules/text.ts';

/** rate57: workers on the *57 pay rate and their places (D66), as "Avi Cohen = place = place". */
export const LIST_KINDS = ['workplace', 'name', 'rate57'] as const;
export type ListKind = (typeof LIST_KINDS)[number];
export const MAX_LIST_ENTRIES = 2000;
export const MAX_LIST_LINE = 200;

/** Fits the API's 100 KB request limit even in Hebrew (2 bytes a letter); real lists are far shorter. */
export const putListSchema = z.object({
  text: z.string().max(40_000, 'The list is too long.'),
});

export interface ListLine {
  name: string;
  spellings: string[];
}

const HEBREW = /[\u0590-\u05FF]/;

/** A line starting with # is a comment, in the pasted lists and in names.txt / workplaces.txt. */
export const isListComment = (line: string) => stripInvisible(line).trim().startsWith('#');

/**
 * A workplace is named by its Hebrew spelling (D36), a worker by the English one, as in the Excel
 * (5.2); the other spellings only help reading. A name on several lines is one entry.
 */
export function parseList(
  kind: ListKind,
  text: string,
): { ok: true; entries: ListLine[] } | { ok: false; problem: string } {
  const entries = new Map<string, Set<string>>();
  for (const [i, line] of text.split(/\r?\n/).entries()) {
    if (isListComment(line)) continue;
    const spellings = line
      .split(/[=\t]/) // Excel copies two columns as "A<tab>B"
      // The month's Excel puts an apostrophe before text that could be a formula (6.2).
      .map((s) =>
        stripInvisible(s)
          .replace(/\s+/g, ' ')
          .trim()
          .replace(/^'(?=[=+\-@\t\r])/, ''),
      )
      .filter((s) => s !== '');
    if (spellings.join(' = ').length > MAX_LIST_LINE) {
      return { ok: false, problem: `Line ${i + 1} is longer than ${MAX_LIST_LINE} characters.` };
    }
    // On the 57 list the worker's English name comes first, then the places.
    const name =
      kind === 'rate57'
        ? spellings[0]
        : (spellings.find((s) => HEBREW.test(s) === (kind === 'workplace')) ?? spellings[0]);
    if (!name) continue;
    const others = entries.get(name) ?? new Set<string>();
    for (const s of spellings) if (s !== name) others.add(s);
    entries.set(name, others);
    if (entries.size > MAX_LIST_ENTRIES) {
      return { ok: false, problem: `The list has more than ${MAX_LIST_ENTRIES} entries.` };
    }
  }
  return { ok: true, entries: [...entries].map(([name, s]) => ({ name, spellings: [...s] })) };
}

/**
 * Is this English name at this place on the 57 list (D66)? Names and places are compared as
 * grouping compares them, and a place is also found by any spelling the workplace list gives it.
 * The answer only pre-ticks a ticket's box; a person's saved tick decides.
 */
export function onRate57List(
  rate57: readonly ListLine[],
  workplaces: readonly ListLine[],
  name: string,
  place: string,
): boolean {
  const n = normaliseName(name);
  if (n === '' || normaliseName(place) === '') return false;
  const canon = (p: string) => {
    const key = normaliseName(p);
    const entry = workplaces.find((w) =>
      [w.name, ...w.spellings].some((s) => normaliseName(s) === key),
    );
    return entry ? normaliseName(entry.name) : key;
  };
  const here = canon(place);
  return rate57.some(
    (e) => normaliseName(e.name) === n && e.spellings.some((p) => canon(p) === here),
  );
}
