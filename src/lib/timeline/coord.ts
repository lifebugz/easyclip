// Pure coordinate helpers for the timeline track. Positioning is full-duration
// based: the track spans the whole clip, so a time's percentage offset is
// seconds / duration * 100 (matches edit-step.jsx t2pct). Consumed by anchors,
// cut regions, AnchorTip (Phase 7) and Playhead / SnapBadge (Phase 8).

/** Convert a time in seconds to a percentage [0..100] of the clip duration. */
export function timeToPct(seconds: number, duration: number): number {
  // Reject non-finite (a NaN/Infinity probe duration) as well as <= 0, so a
  // degenerate probe degrades to 0 rather than leaking NaN into inline styles.
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  return (seconds / duration) * 100;
}

/**
 * Convert a pointer clientX to a time in seconds, given the track's bounding
 * rect. The track is locally LTR (see Timeline.svelte `direction: ltr`), so x
 * always increases left→right regardless of page direction. Clamped to
 * [0, duration].
 *
 * `rect.x` is the track's `getBoundingClientRect().x` (inline-start edge in
 * physical coords — always the left edge because the track overrides direction
 * to ltr).
 */
export function xToTime(
  clientX: number,
  rect: { x: number; width: number },
  duration: number
): number {
  if (rect.width <= 0 || !Number.isFinite(duration) || duration <= 0) return 0;
  const u = (clientX - rect.x) / rect.width;
  const clamped = Math.max(0, Math.min(1, u));
  return clamped * duration;
}
