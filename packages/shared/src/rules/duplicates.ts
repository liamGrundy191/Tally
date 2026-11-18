// POSSIBLE_DUPLICATE (plan section 5.2): the system never merges people. It only asks.
import { normaliseName } from './names.ts';
import { shiftMinutes } from './time.ts';

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
 * Shifts on the same date overlap if they share any minute. Back-to-back shifts (one ends as
 * the other starts) do not. Identical start times always overlap, even for 0-minute shifts.
 * If either ticket's times are unknown, assume they overlap so a person is asked.
 */
export function shiftsOverlap(a: DuplicateCandidate, b: DuplicateCandidate): boolean {
  if (a.startMinutes == null || a.endMinutes == null) return true;
  if (b.startMinutes == null || b.endMinutes == null) return true;
  if (a.startMinutes === b.startMinutes) return true;
  const aEnd = a.startMinutes + shiftMinutes(a.startMinutes, a.endMinutes);
  const bEnd = b.startMinutes + shiftMinutes(b.startMinutes, b.endMinutes);
  return a.startMinutes < bEnd && b.startMinutes < aEnd;
}

/**
 * Pairs of tickets in a job with matching names, the same workplace group, the same date
 * (Liam: same date only) and overlapping times. Callers leave out excluded tickets.
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
        if (namesMatch(a.name, b.name) && shiftsOverlap(a, b)) pairs.push([a.id, b.id]);
      }
    }
  }
  return pairs;
}
