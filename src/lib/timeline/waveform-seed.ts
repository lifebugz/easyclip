// Decorative waveform amplitudes from a deterministic per-file seed (amendment §6.3).
//
// HONESTY RULE (load-bearing — see amendment §6.3): these are NOT real audio peaks.
// They are an FNV-1a hash of the file path per bin, so the same file always draws
// the same pattern and different files look different, with no claim of accuracy.
// Real audio peaks are deferred to v2. A future contributor seeing WaveformOverlay
// should not mistake this for an FFmpeg integration point.
export function seedToWaveBars(path: string, bins: number): number[] {
  if (bins <= 0) return [];
  const bars: number[] = [];
  for (let i = 0; i < bins; i++) {
    let h = 0x811c9dc5; // FNV-1a 32-bit offset basis
    const s = `${path}#${String(i)}`; // independent value per bar
    for (let j = 0; j < s.length; j++) {
      h ^= s.charCodeAt(j);
      h = Math.imul(h, 0x01000193) >>> 0; // FNV prime, kept unsigned 32-bit
    }
    const unit = h / 0xffffffff; // [0, 1]
    // Floor at 0.18 so every bar stays visible (matches the bundle's min height);
    // 0.18..1 is within the spec's 0..1 normalised range.
    bars.push(0.18 + 0.82 * unit);
  }
  return bars;
}
