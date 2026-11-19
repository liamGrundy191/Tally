import { existsSync, readFileSync } from 'node:fs';

/**
 * The agency's workplaces from a text file: one per line, blank lines and lines starting with
 * # ignored. No file means no list.
 * shortcut: a local file until the app has an "upload Excel" screen for this.
 */
export function loadWorkplaces(path = 'workplaces.txt'): string[] {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
  return [...new Set(lines)];
}
