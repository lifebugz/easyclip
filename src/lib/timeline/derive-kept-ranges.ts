// Pure bridge between editor semantics ("trim window + middle cuts") and
// FFmpeg semantics ("ordered kept ranges"). Half-open [start, end) — the
// same invariant advancePlayhead's skip loop uses, so playback and the
// engine agree on every boundary. Single-element output → stream-copy
// path; multi-element → concat path (spec §2 step 4 branches on length).
import type { KeptRange } from '../types';

interface Range {
  start: number;
  end: number;
}

export function deriveKeptRanges(
  trimRange: Range,
  cuts: readonly { start: number; end: number }[]
): KeptRange[] {
  const { start, end } = trimRange;
  if (!(end > start)) return [];

  const merged: Range[] = [];
  const clamped = cuts
    .map((c) => ({ start: Math.max(c.start, start), end: Math.min(c.end, end) }))
    .filter((c) => c.end > c.start)
    .sort((a, b) => a.start - b.start);
  for (const c of clamped) {
    const last = merged[merged.length - 1];
    if (last !== undefined && c.start <= last.end) {
      last.end = Math.max(last.end, c.end);
    } else {
      merged.push({ ...c });
    }
  }

  const kept: KeptRange[] = [];
  let cursor = start;
  for (const c of merged) {
    if (c.start > cursor) kept.push({ start: cursor, end: c.start });
    cursor = Math.max(cursor, c.end);
  }
  if (end > cursor) kept.push({ start: cursor, end });
  return kept;
}
