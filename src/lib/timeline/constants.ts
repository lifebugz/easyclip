// Named gesture constants for the timeline editor. Mirrors the magic numbers in
// the design bundle (edit-step.jsx) so none are buried literals.

/** Shortest committable / resizable middle cut, in seconds (edit-step.jsx MIN_CUT_DUR). */
export const MIN_CUT_DUR = 0.25;

/** Shortest trim window (gap between head and tail anchors), in seconds (edit-step.jsx anchor clamp ±1). */
export const MIN_TRIM_DUR = 1.0;

/** Pixels the pointer must travel from pointerdown before an empty-band drag becomes a create-cut (edit-step.jsx CUT_DRAG_THRESH_PX). */
export const CUT_DRAG_THRESH_PX = 4;

/** Snap radius in pixels. Consumed in Phase 8 only; defined here so both phases share one source. */
export const SNAP_PX = 14;

/** Poster-mode re-extract floor (ms): caps the self-pacing refresh at ~10fps (§6). */
export const POSTER_MIN_SPACING_MS = 100;

/** Debounce (ms) for poster re-extraction on scrub while paused (§6). */
export const POSTER_SCRUB_DEBOUNCE_MS = 150;

/** Classification timeout (ms): if neither loadedmetadata nor error fires, fall
 *  back to codec-only routing (poster when hasVideo, else art) so the box never
 *  hangs (§3). */
export const DECODE_TIMEOUT_MS = 4000;
