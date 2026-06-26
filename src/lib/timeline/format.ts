// Centisecond-precision timecode formatter for the AnchorTip tooltip and the
// cut-duration pill. Reuses the shipped formatDuration for the M:SS / H:MM:SS
// grammar (single source of truth) but floors the seconds first — formatDuration
// rounds, whereas a precise timecode must show the floored second plus the
// centisecond remainder. Relative import (Bun test runtime ignores $lib alias).

import { formatDuration } from '../util/format-duration';

/**
 * Format seconds as `M:SS.cc` / `H:MM:SS.cc` (two-digit centiseconds).
 * Negative / NaN / Infinity delegate to formatDuration (returns the em-dash).
 * Callers always pass non-negative finite values; the guard is defensive.
 */
export function formatTimecodePrecise(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return formatDuration(seconds);
  let whole = Math.floor(seconds);
  let cc = Math.round((seconds - whole) * 100);
  if (cc === 100) {
    whole += 1;
    cc = 0;
  }
  return `${formatDuration(whole)}.${String(cc).padStart(2, '0')}`;
}
