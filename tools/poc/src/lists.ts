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
    .filter((l) => l !== '' && !l.startsWith('#'));
  return [...new Set(lines)];
}
