// POSSIBLE_DUPLICATE (plan section 5.2): the system never merges people. It only asks.
import { normaliseName } from './names.ts';

export interface DuplicateCandidate {
  id: string;
  name: string | null;
  /** The resolved group, after any merges the user confirmed. */
  workplaceGroupId: string | null;
  /** ISO date, YYYY-MM-DD. */
  shiftDate: string | null;
  startMinutes: number | null;
  endMinutes: number | null;
}

const nameWords = (name: string | null) =>
  name ? normaliseName(name).split(' ').filter(Boolean) : [];

/**
 * Names match if they have the same words in any order ("דוד כהן" / "כהן דוד"), or every word
 * of one appears in the other ("דוד" / "דוד כהן"), since the ticket has only one name field.
 */
export function namesMatch(a: string | null, b: string | null): boolean {
  const x = nameWords(a);
  const y = nameWords(b);
  if (x.length === 0 || y.length === 0) return false;
  const [shorter, longer] = x.length <= y.length ? [x, y] : [y, x];
  const pool = [...longer];
  return shorter.every((w) => {
    const i = pool.indexOf(w);
    if (i === -1) return false;
    pool.splice(i, 1);
    return true;
  });
}

/**
 * Pairs of tickets in a month with matching names, the same workplace group and the same date,
 * whatever their times (5.2, D39): two shifts of one name on one day are never added together
 * without asking. Callers leave out excluded tickets.
 */
export function findPossibleDuplicates(tickets: readonly DuplicateCandidate[]): [string, string][] {
  const byPlaceAndDate = new Map<string, DuplicateCandidate[]>();
  for (const t of tickets) {
    if (!t.workplaceGroupId || !t.shiftDate || nameWords(t.name).length === 0) continue;
    const key = `${t.workplaceGroupId}|${t.shiftDate}`;
    byPlaceAndDate.set(key, [...(byPlaceAndDate.get(key) ?? []), t]);
  }
  const pairs: [string, string][] = [];
  for (const group of byPlaceAndDate.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i]!;
        const b = group[j]!;
        if (namesMatch(a.name, b.name)) pairs.push([a.id, b.id]);
      }
    }
  }
  return pairs;
}
