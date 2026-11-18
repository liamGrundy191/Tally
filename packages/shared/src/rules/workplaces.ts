// Workplace grouping (plan section 5.3). Workplaces with the same normalised name share a group
// automatically; similar names are only merged after a person confirms (WORKPLACE_SIMILAR).

/** Edit distance between two strings, counted in characters (code points). */
export function levenshtein(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const row = [i];
    for (let j = 1; j <= y.length; j++) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;
      row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + cost);
    }
    prev = row;
  }
  return prev[y.length]!;
}

export const MAX_SIMILAR_DISTANCE = 2;

/** Two normalised workplace names are similar if 1–2 edits apart, or one contains the other. */
export function areSimilarWorkplaces(a: string, b: string): boolean {
  if (a === '' || b === '') return false; // an empty name is "contained" in everything
  return a.includes(b) || b.includes(a) || levenshtein(a, b) <= MAX_SIMILAR_DISTANCE;
}

export interface WorkplaceGroupName {
  id: string;
  normalisedName: string;
}

/** Every pair of groups in a job that a person should be asked about. Each pair appears once. */
export function findSimilarWorkplaces(groups: readonly WorkplaceGroupName[]): [string, string][] {
  const pairs: [string, string][] = [];
  for (let i = 0; i < groups.length; i++) {
    for (let j = i + 1; j < groups.length; j++) {
      const a = groups[i]!;
      const b = groups[j]!;
      if (areSimilarWorkplaces(a.normalisedName, b.normalisedName)) pairs.push([a.id, b.id]);
    }
  }
  return pairs;
}
