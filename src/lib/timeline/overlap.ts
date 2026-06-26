// Pure interval math for cut regions. `Cut` is imported as a type only (erased
// at compile time, so importing from the .svelte.ts module costs no rune load
// in the Bun test runtime).

import type { Cut } from '../wizard/state.svelte';

export interface Range {
  start: number;
  end: number;
}

/** Strict overlap: the ranges share interior, not merely a touching edge. */
export function rangesOverlap(a: Range, b: Range): boolean {
  return a.start < b.end && b.start < a.end;
}

/**
 * First adjacent overlapping-OR-touching pair (sorted by start), or null.
 * Touching (`b.start <= a.end`) counts, matching the bundle's merge-prompt
 * trigger (edit-step.jsx:177). Returned `{ a, b }` is always in start order.
 */
export function findOverlapping(cuts: Cut[]): { a: Cut; b: Cut } | null {
  const sorted = [...cuts].sort((x, y) => x.start - y.start);
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (a !== undefined && b !== undefined && b.start <= a.end) return { a, b };
  }
  return null;
}

/** Clamp a value into [trim.start, trim.end]. */
export function clampToTrim(value: number, trim: Range): number {
  return Math.max(trim.start, Math.min(value, trim.end));
}

/** Union span of two ranges. */
export function mergeRanges(a: Range, b: Range): Range {
  return { start: Math.min(a.start, b.start), end: Math.max(a.end, b.end) };
}

/**
 * Total seconds removed by `cuts` within `trim`, counting any overlap ONCE — the
 * measure of the union of the trim-clamped cut intervals. Cuts can legitimately
 * overlap (the merge prompt is dismissible via "Keep separate"), so summing each
 * cut's length independently would double-count the shared span and over-report
 * the removed duration. A standard sort-and-sweep over the clamped intervals
 * yields the union measure. Cuts that fall entirely outside the trim window
 * contribute 0.
 */
export function removedWithinTrim(cuts: Cut[], trim: Range): number {
  const clamped = cuts
    .map((c) => ({ start: Math.max(c.start, trim.start), end: Math.min(c.end, trim.end) }))
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start);
  let total = 0;
  let curStart = 0;
  let curEnd = 0;
  let open = false;
  for (const r of clamped) {
    if (!open) {
      curStart = r.start;
      curEnd = r.end;
      open = true;
    } else if (r.start <= curEnd) {
      curEnd = Math.max(curEnd, r.end); // overlap or touch → extend the run
    } else {
      total += curEnd - curStart; // disjoint → flush the completed run
      curStart = r.start;
      curEnd = r.end;
    }
  }
  if (open) total += curEnd - curStart;
  return total;
}
