// Small geometry helpers for straightening a ticket from its four corner markers.

export interface Point {
  x: number;
  y: number;
}

/** A 3x3 projective transform stored row-major with h33 = 1. */
export type Homography = readonly number[];

/** Solves A·x = b by Gaussian elimination with partial pivoting. */
function solve(a: number[][], b: number[]): number[] {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++)
      if (Math.abs(m[r]![col]!) > Math.abs(m[pivot]![col]!)) pivot = r;
    [m[col], m[pivot]] = [m[pivot]!, m[col]!];
    const p = m[col]![col]!;
    if (Math.abs(p) < 1e-12) throw new Error('Degenerate marker positions');
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r]![col]! / p;
      for (let c = col; c <= n; c++) m[r]![c]! -= f * m[col]![c]!;
    }
  }
  return m.map((row, i) => row[n]! / row[i]!);
}

/** The projective transform that maps each `from[i]` onto `to[i]` (four point pairs). */
export function homography(from: readonly Point[], to: readonly Point[]): Homography {
  const a: number[][] = [];
  const b: number[] = [];
  from.forEach((p, i) => {
    const q = to[i]!;
    a.push([p.x, p.y, 1, 0, 0, 0, -p.x * q.x, -p.y * q.x]);
    b.push(q.x);
    a.push([0, 0, 0, p.x, p.y, 1, -p.x * q.y, -p.y * q.y]);
    b.push(q.y);
  });
  return [...solve(a, b), 1];
}

export function apply(h: Homography, p: Point): Point {
  const w = h[6]! * p.x + h[7]! * p.y + h[8]!;
  return { x: (h[0]! * p.x + h[1]! * p.y + h[2]!) / w, y: (h[3]! * p.x + h[4]! * p.y + h[5]!) / w };
}

export const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** Four points in clockwise order (in image coordinates, y down), starting anywhere. */
export function clockwise(points: readonly Point[]): Point[] {
  const cx = points.reduce((s, p) => s + p.x, 0) / points.length;
  const cy = points.reduce((s, p) => s + p.y, 0) / points.length;
  return [...points].sort(
    (p, q) => Math.atan2(p.y - cy, p.x - cx) - Math.atan2(q.y - cy, q.x - cx),
  );
}
