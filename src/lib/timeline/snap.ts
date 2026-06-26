// Keyframe snapping for the timeline gestures (amendment §6.1). Pure + Bun-tested.
//
// keyframes MUST be ascending — we binary-search it. The Rust probe emits packets
// in ffprobe order and does not sort, so the caller (Timeline) sorts defensively
// before calling; it is [] when over MAX_KF, which disables snap. We binary-search
// the insertion point of `time`, then compare its two neighbours and return the
// closer one if it lies within `radiusSec`.
// O(log n): at the §3.5 cap (50K) that is ~16 comparisons per pointermove tick.
//
// Tie-break: the lower index wins (the left neighbour is compared first with a
// strict `<`, so an equidistant right neighbour never displaces it). This matches
// the bundle's linear-scan first-wins behaviour, which §6.1 supersedes.
//
// `index` is returned in addition to the §6.1 signature so the gesture handler can
// dedupe the snap badge at the source (only repaint/announce when the snapped
// keyframe index changes). -1 when not snapped.
export function snapToKeyframe(
  time: number,
  keyframes: number[],
  radiusSec: number
): { time: number; snapped: boolean; index: number } {
  const n = keyframes.length;
  if (n === 0) return { time, snapped: false, index: -1 };

  // First index whose keyframe is >= time (insertion point).
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const kfMid = keyframes[mid];
    // kfMid is always defined: 0 <= mid < n holds across the loop. The guard
    // (and `bestVal` capture below) narrows `number | undefined` for the
    // strictest tsconfig's noUncheckedIndexedAccess, matching overlap.ts.
    if (kfMid !== undefined && kfMid < time) lo = mid + 1;
    else hi = mid;
  }

  // Candidate neighbours: lo-1 (left) compared first so it wins ties.
  let bestIdx = -1;
  let bestVal = time;
  let bestD = Infinity;
  for (const i of [lo - 1, lo]) {
    if (i < 0 || i >= n) continue;
    const kf = keyframes[i];
    if (kf === undefined) continue;
    const d = Math.abs(kf - time);
    if (d < bestD) {
      bestD = d;
      bestIdx = i;
      bestVal = kf;
    }
  }

  if (bestIdx !== -1 && bestD <= radiusSec) {
    return { time: bestVal, snapped: true, index: bestIdx };
  }
  return { time, snapped: false, index: -1 };
}
