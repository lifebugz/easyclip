// Pure per-frame playhead math + navigation-reset decision (amendment §6.2).
// No DOM, no RAF, no runes — the controller in playback.svelte.ts wraps these.
import type { WizardStep } from '../wizard/state.svelte';

/** One RAF tick. `cuts` must be the COMMITTED cuts, never the in-flight
 *  pendingCut — skipping a moving pending range would fight the drag (amendment
 *  §6.2 / §10.4). Cut order is not assumed (see the skip loop). Returns the next
 *  playhead and whether playback continues. */
export function advancePlayhead(input: {
  playhead: number;
  rawDt: number; // seconds since the last frame, before clamping
  trimStart: number;
  trimEnd: number;
  cuts: { start: number; end: number }[];
}): { playhead: number; playing: boolean } {
  // 100 ms clamp: when the tab/window is hidden RAF pauses, and the first frame
  // back reports a multi-second rawDt that would lurch the playhead forward.
  const dt = Math.min(input.rawDt, 0.1);
  let next = input.playhead + dt;

  // Half-open [start, end): playhead === cut.start is inside (skip);
  // playhead === cut.end is outside (continue). We loop to a fixpoint rather
  // than assume one forward pass suffices: committed cuts are normally sorted
  // ascending (commitCut/commitMerge sort), but a cut-handle resize via
  // proposeCutEdit does NOT re-sort, so the array read here can be out of order
  // and a single pass could leave `next` inside an earlier-iterated cut.
  // Re-passing until no skip occurs is order-independent and overlap-safe;
  // `next` only ever increases (bounded by trimEnd), so this terminates.
  let skipped = true;
  while (skipped) {
    skipped = false;
    for (const c of input.cuts) {
      if (next >= c.start && next < c.end) {
        next = c.end;
        skipped = true;
      }
    }
  }

  if (next >= input.trimEnd) return { playhead: input.trimEnd, playing: false };
  if (next < input.trimStart) next = input.trimStart;
  return { playhead: next, playing: true };
}

export type PlaybackMove = 'reset' | 'pause' | 'none';

/** Maps a wizard navigation (from → to) to a playback side effect, per the
 *  amendment §6.2 reset table. 'reset' → playhead = trimStart, playing = false;
 *  'pause' → playing = false (playhead kept); 'none' → leave as-is. Start Over
 *  is handled by resetAll (zeroes both) and never routes here.
 *
 *  Leaving timeline-edit (the only step with playback) always pauses — both the
 *  Continue→save and Back→file-pick exits — so `playing` is never left stale on a
 *  step that has no RAF loop running. (Re-entry from file-pick/processing resets.) */
export function playbackTransition(from: WizardStep, to: WizardStep): PlaybackMove {
  if (to === 'timeline-edit' && (from === 'file-pick' || from === 'processing')) return 'reset';
  if (from === 'timeline-edit') return 'pause';
  return 'none';
}
