// The workplace and names lists that help reading (5.4), shared by all months (D42). The user
// pastes them as text, one entry per line; a line may give one entry's spellings in both
// languages ("Golan Farm = חוות גולן"), or two columns copied from Excel. Shared so the API and
// the web app read a list the same way.
import { z } from 'zod';
import { stripInvisible } from '../rules/text.ts';

export const LIST_KINDS = ['workplace', 'name'] as const;
export type ListKind = (typeof LIST_KINDS)[number];
export const MAX_LIST_ENTRIES = 2000;
export const MAX_LIST_LINE = 200;

export const putListSchema = z.object({
  text: z.string().max(MAX_LIST_ENTRIES * MAX_LIST_LINE, 'The list is too long.'),
});

export interface ListLine {
  name: string;
  spellings: string[];
}

const HEBREW = /[\u0590-\u05FF]/;

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
    const spellings = line
      .split(/[=\t]/) // Excel copies two columns as "A<tab>B"
      .map((s) => stripInvisible(s).replace(/\s+/g, ' ').trim())
      .filter((s) => s !== '');
    if (spellings.join(' = ').length > MAX_LIST_LINE) {
      return { ok: false, problem: `Line ${i + 1} is longer than ${MAX_LIST_LINE} characters.` };
    }
    const name = spellings.find((s) => HEBREW.test(s) === (kind === 'workplace')) ?? spellings[0];
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
