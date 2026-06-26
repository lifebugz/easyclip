// Format a duration in seconds as a human-readable timecode.
//
// < 1h         → "M:SS" or "MM:SS" (no leading zero on minutes)
// >= 1h        → "H:MM:SS" or "HH:MM:SS"
// NaN / ±Inf / negative → "—" (em dash; defensive fallback so the UI
//                              never renders NaN:NaN when ffprobe yields
//                              an unusable duration)
//
// Sub-second fractions round to the nearest whole second.
//
// Pure — no module-scope state, no side effects. Bun-testable.

const EM_DASH = '—';

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return EM_DASH;
  }
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  const pad = (n: number): string => (n < 10 ? `0${String(n)}` : String(n));

  if (hours === 0) {
    return `${String(minutes)}:${pad(secs)}`;
  }
  return `${String(hours)}:${pad(minutes)}:${pad(secs)}`;
}
