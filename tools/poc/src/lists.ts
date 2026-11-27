import { isListComment } from '@tally/shared';
import { existsSync, readFileSync } from 'node:fs';

/**
 * A list from a text file (workplaces.txt, names.txt): one entry per line, blank lines and lines
 * starting with # ignored. No file means no list.
 * shortcut: local files until the app has an "upload Excel" screen for these.
 */
export function loadList(path: string): string[] {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !isListComment(l));
  return [...new Set(lines)];
}

/**
 * workplaces.txt, where a line may give one place's spellings: "Einav = עינב". Every spelling is
 * on the list; `placeOf` gives each spelling the place's name, the Hebrew one (D36).
 */
export function loadWorkplaces(path: string) {
  const placeOf = new Map<string, string>();
  for (const line of loadList(path)) {
    const spellings = line
      .split('=')
      .map((s) => s.trim())
      .filter((s) => s !== '');
    const name = spellings.find((s) => /[\u0590-\u05FF]/.test(s)) ?? spellings[0];
    for (const s of spellings) placeOf.set(s, name!);
  }
  return { list: [...placeOf.keys()], placeOf };
}
