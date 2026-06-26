// Timeline writers — the ONLY code allowed to mutate wizardState.cuts /
// wizardState.trimRange. They take the state as a parameter and mutate it by
// reassignment (Svelte 5 $state deep-proxy tracks reassignment), which keeps
// them pure-over-param and Bun-testable with a plain object. No parallel store:
// the Cut interface and the trimRange/cuts fields are the existing ones on
// wizardState (relative import — Bun ignores the $lib alias).

import type { Cut, WizardStateShape } from '../wizard/state.svelte';
import { MIN_CUT_DUR, MIN_TRIM_DUR } from './constants';
import { clampToTrim, rangesOverlap, mergeRanges } from './overlap';

export type ProposeResult =
  | { kind: 'reject' }
  | { kind: 'commit'; range: { start: number; end: number } }
  | { kind: 'merge'; overlapsId: string; range: { start: number; end: number } };

/**
 * Read-only. Decides what a freshly-drawn range would do: reject (too short),
 * merge (overlaps an existing cut — the orchestrator commits it then raises the
 * merge prompt for the overlapping pair), or commit. Mints no id, mutates
 * nothing. The range is clamped to the trim window first.
 */
export function proposeCut(
  state: WizardStateShape,
  range: { start: number; end: number }
): ProposeResult {
  const lo = Math.min(range.start, range.end);
  const hi = Math.max(range.start, range.end);
  const start = clampToTrim(lo, state.trimRange);
  const end = clampToTrim(hi, state.trimRange);
  if (end - start < MIN_CUT_DUR) return { kind: 'reject' };
  for (const c of state.cuts) {
    if (rangesOverlap({ start, end }, c)) {
      return { kind: 'merge', overlapsId: c.id, range: { start, end } };
    }
  }
  return { kind: 'commit', range: { start, end } };
}

/** Mint a uuid'd cut, append, re-sort ascending by start. Returns the new cut. */
export function commitCut(state: WizardStateShape, range: { start: number; end: number }): Cut {
  const created: Cut = { id: crypto.randomUUID(), start: range.start, end: range.end };
  state.cuts = [...state.cuts, created].sort((a, b) => a.start - b.start);
  return created;
}

/** Move one edge of an existing cut, clamped to the trim window and floored at MIN_CUT_DUR. */
export function proposeCutEdit(
  state: WizardStateShape,
  id: string,
  edge: 'start' | 'end',
  time: number
): void {
  state.cuts = state.cuts.map((c) => {
    if (c.id !== id) return c;
    if (edge === 'start') {
      // MIN_CUT_DUR is the OUTER (winning) clamp so the cut never inverts even
      // when the trim window has been narrowed past this cut: clamp the pointer
      // time up to trim.start first, then cap it at end - MIN_CUT_DUR.
      const next = Math.min(c.end - MIN_CUT_DUR, Math.max(state.trimRange.start, time));
      return { ...c, start: next };
    }
    const next = Math.max(c.start + MIN_CUT_DUR, Math.min(state.trimRange.end, time));
    return { ...c, end: next };
  });
}

/** Remove a cut by id. Does NOT touch the merge prompt (transient component state). */
export function deleteCut(state: WizardStateShape, id: string): void {
  state.cuts = state.cuts.filter((c) => c.id !== id);
}

/**
 * Merge two cuts into one spanning their union. Keeps the EARLIER-start cut's
 * id (drops the other) so the keyed render reuses that node and focus transfers
 * cleanly. Argument order does not matter. No-op if either id is missing.
 */
export function commitMerge(state: WizardStateShape, aId: string, bId: string): void {
  const first = state.cuts.find((c) => c.id === aId);
  const second = state.cuts.find((c) => c.id === bId);
  if (first === undefined || second === undefined) return;
  const earlier = first.start <= second.start ? first : second;
  const span = mergeRanges(first, second);
  const merged: Cut = { id: earlier.id, start: span.start, end: span.end };
  state.cuts = state.cuts
    .filter((c) => c.id !== aId && c.id !== bId)
    .concat(merged)
    .sort((a, b) => a.start - b.start);
}

/**
 * Store the whole trim range. Defensively clamps to [0, duration] and enforces
 * MIN_TRIM_DUR when the clip is long enough; for a clip shorter than MIN_TRIM_DUR
 * the [0, duration] cap wins, yielding the full (sub-minimum) clip rather than an
 * impossible window. Callers (anchor-drag handler) pass an already per-edge-clamped
 * range; this is the transactional commit + final guard, and also future-proofs
 * the deferred I/O set-in/out shortcuts.
 *
 * Also keeps the playhead within the new window (§6.2): the playhead must never
 * sit outside [start, end], or the transport/preview timecode would show a time
 * the marker can't reach (the marker hides when out of range). Narrowing the
 * window past a paused playhead snaps it to the nearest bound; an in-window
 * playhead is untouched.
 */
export function setTrimRange(state: WizardStateShape, range: { start: number; end: number }): void {
  const duration = state.mediaInfo?.duration ?? range.end;
  const start = Math.max(0, Math.min(range.start, duration - MIN_TRIM_DUR));
  const end = Math.min(duration, Math.max(range.end, start + MIN_TRIM_DUR));
  state.trimRange = { start, end };
  state.playhead = Math.max(start, Math.min(state.playhead, end));
}

/**
 * Read-only. The trim range to seed on first entry to the editor, or null when
 * seeding should be skipped. Seeds {0, duration} only when the range is still
 * pristine (end === 0) AND the probe reported a usable positive duration — a
 * zero, negative, or non-finite (NaN/Infinity) duration from a failed or
 * degenerate probe must NOT seed a {0,0}/{0,NaN} window. A range already set
 * (end !== 0) is left untouched so returning from Save preserves the selection.
 */
export function seedTrimRange(state: WizardStateShape): { start: number; end: number } | null {
  const info = state.mediaInfo;
  if (info === null) return null;
  if (!Number.isFinite(info.duration) || info.duration <= 0) return null;
  if (state.trimRange.end !== 0) return null;
  return { start: 0, end: info.duration };
}
