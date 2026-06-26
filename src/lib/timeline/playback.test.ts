import { test, expect } from 'bun:test';
import {
  advancePlayhead,
  playbackTransition,
  derivePreviewMode,
  syncFromMedia,
  posterDelayMs,
  resolvePlayStart,
  SEEK_EPSILON
} from './playback';

const TRIM = { trimStart: 0, trimEnd: 120 };

test('advances the playhead by dt when nothing is in the way', () => {
  const r = advancePlayhead({ playhead: 5, rawDt: 0.016, ...TRIM, cuts: [] });
  expect(r).toEqual({ playhead: 5.016, playing: true });
});

test('clamps a multi-second rawDt to 0.1s (hidden-tab safety)', () => {
  // Tab was hidden; first frame back reports rawDt = 5s. Without the clamp the
  // playhead would lurch to 15; clamped it advances only 0.1s.
  const r = advancePlayhead({ playhead: 10, rawDt: 5, ...TRIM, cuts: [] });
  expect(r).toEqual({ playhead: 10.1, playing: true });
});

test('half-open cut-skip: landing on cut.start jumps to cut.end', () => {
  // next = 9.999 + 0.002 = 10.001 → inside [10, 20) → jumps to 20
  const r = advancePlayhead({
    playhead: 9.999,
    rawDt: 0.002,
    ...TRIM,
    cuts: [{ start: 10, end: 20 }]
  });
  expect(r).toEqual({ playhead: 20, playing: true });
});

test('half-open cut-skip: landing exactly on cut.end does NOT skip', () => {
  // next = 19.99 + 0.01 = 20 → 20 is NOT < 20 → continues
  const r = advancePlayhead({
    playhead: 19.99,
    rawDt: 0.01,
    ...TRIM,
    cuts: [{ start: 10, end: 20 }]
  });
  expect(r.playing).toBe(true);
  expect(r.playhead).toBeCloseTo(20, 6);
});

test('adjacent cuts chain in a single pass (sorted ascending)', () => {
  const r = advancePlayhead({
    playhead: 9.99,
    rawDt: 0.02, // → 10.01, in [10,20) → 20, then in [20,30) → 30
    ...TRIM,
    cuts: [
      { start: 10, end: 20 },
      { start: 20, end: 30 }
    ]
  });
  expect(r).toEqual({ playhead: 30, playing: true });
});

test('chains cuts regardless of array order (proposeCutEdit can leave them unsorted)', () => {
  // Same two adjacent cuts as above but reversed: a single forward pass would
  // land next=20 inside the now-earlier-iterated [20,30) and stop there. The
  // fixpoint loop re-passes and skips to 30.
  const r = advancePlayhead({
    playhead: 9.99,
    rawDt: 0.02,
    ...TRIM,
    cuts: [
      { start: 20, end: 30 },
      { start: 10, end: 20 }
    ]
  });
  expect(r).toEqual({ playhead: 30, playing: true });
});

test('stops and parks at trimEnd when the frame would overrun', () => {
  const r = advancePlayhead({ playhead: 119.95, rawDt: 0.1, ...TRIM, cuts: [] });
  expect(r).toEqual({ playhead: 120, playing: false });
});

test('snaps up to trimStart if the playhead is below it (start dragged past playhead)', () => {
  const r = advancePlayhead({ playhead: 5, rawDt: 0.016, trimStart: 10, trimEnd: 120, cuts: [] });
  expect(r).toEqual({ playhead: 10, playing: true });
});

test('playbackTransition: fresh entry/cancel reset; leaving timeline-edit always pauses; else none', () => {
  expect(playbackTransition('file-pick', 'timeline-edit')).toBe('reset');
  expect(playbackTransition('processing', 'timeline-edit')).toBe('reset');
  expect(playbackTransition('timeline-edit', 'save')).toBe('pause');
  // Back out of the editor also pauses, so `playing` is never left true on a
  // step with no RAF loop (previously this returned 'none').
  expect(playbackTransition('timeline-edit', 'file-pick')).toBe('pause');
  expect(playbackTransition('save', 'timeline-edit')).toBe('none');
});

test('derivePreviewMode: table over source/video/decode/error', () => {
  const base = {
    hasSource: true,
    hasVideo: true,
    decoded: false,
    audioDecoded: false,
    errored: false
  };
  // No source → art regardless of everything else.
  expect(derivePreviewMode({ ...base, hasSource: false })).toBe('art');
  // Decoded a real video frame → video.
  expect(derivePreviewMode({ ...base, decoded: true })).toBe('video');
  // hasVideo but errored → poster.
  expect(derivePreviewMode({ ...base, errored: true })).toBe('poster');
  // No video stream, audio decoded → audio.
  expect(derivePreviewMode({ ...base, hasVideo: false, audioDecoded: true })).toBe('audio');
  // No video stream, errored → art.
  expect(derivePreviewMode({ ...base, hasVideo: false, errored: true })).toBe('art');
  // Pending video (no event yet) → optimistic video so the <video> stays mounted.
  expect(derivePreviewMode(base)).toBe('video');
  // Pending audio-only → optimistic audio.
  expect(derivePreviewMode({ ...base, hasVideo: false })).toBe('audio');
  // Late error AFTER a video classification reroutes to poster (errored wins).
  expect(derivePreviewMode({ ...base, decoded: true, errored: true })).toBe('poster');
});

const SYNC = { trimStart: 0, trimEnd: 120, seekInFlight: false };

test('syncFromMedia: plays through clear media time', () => {
  expect(syncFromMedia({ mediaTime: 5, cuts: [], ...SYNC })).toEqual({
    playhead: 5,
    seekTo: null,
    playing: true,
    inCut: false
  });
});

test('syncFromMedia: stops and parks at trimEnd', () => {
  expect(syncFromMedia({ mediaTime: 120, cuts: [], ...SYNC })).toEqual({
    playhead: 120,
    seekTo: null,
    playing: false,
    inCut: false
  });
});

test('syncFromMedia: mediaTime inside a cut, no seek in flight → seekTo = cut.end + EPSILON', () => {
  const r = syncFromMedia({ mediaTime: 12, cuts: [{ start: 10, end: 20 }], ...SYNC });
  expect(r.playing).toBe(true);
  expect(r.seekTo).toBeCloseTo(20 + SEEK_EPSILON, 6);
  expect(r.playhead).toBeCloseTo(20 + SEEK_EPSILON, 6);
  expect(r.inCut).toBe(true);
});

test('syncFromMedia: clear media time reports inCut false (lets the controller clear a stuck seek latch)', () => {
  // seekInFlight true but mediaTime is in clear time: inCut must be false so the
  // controller's watchdog clears pendingSeek even if `seeked` was never delivered.
  const r = syncFromMedia({
    mediaTime: 5,
    cuts: [{ start: 10, end: 20 }],
    ...SYNC,
    seekInFlight: true
  });
  expect(r.inCut).toBe(false);
  expect(r.seekTo).toBeNull();
  expect(r.playing).toBe(true);
});

test('syncFromMedia: mediaTime snapped back into the just-skipped cut, seek already in flight → seekTo null', () => {
  const r = syncFromMedia({
    mediaTime: 12,
    cuts: [{ start: 10, end: 20 }],
    ...SYNC,
    seekInFlight: true
  });
  expect(r.seekTo).toBeNull();
  expect(r.playing).toBe(true);
  expect(r.playhead).toBeCloseTo(20 + SEEK_EPSILON, 6);
});

test('syncFromMedia: chained adjacent cuts skip to the far end', () => {
  const r = syncFromMedia({
    mediaTime: 12,
    cuts: [
      { start: 10, end: 20 },
      { start: 20, end: 30 }
    ],
    ...SYNC
  });
  expect(r.seekTo).toBeCloseTo(30 + SEEK_EPSILON, 6);
  expect(r.playhead).toBeCloseTo(30 + SEEK_EPSILON, 6);
  expect(r.playing).toBe(true);
});

test('syncFromMedia: mediaTime before trimStart clamps up to trimStart', () => {
  expect(syncFromMedia({ mediaTime: -1, cuts: [], ...SYNC })).toEqual({
    playhead: 0,
    seekTo: null,
    playing: true,
    inCut: false
  });
});

test('syncFromMedia: a non-finite mediaTime is treated as trimStart (never poisons the playhead)', () => {
  // An HTMLMediaElement can momentarily report NaN currentTime before metadata
  // loads. NaN is invisible to every comparison, so without the guard it would
  // flow straight into the playhead. It must instead behave exactly like a clock
  // sitting at trimStart, with any leading cut skipped.
  for (const bad of [NaN, Infinity, -Infinity]) {
    const r = syncFromMedia({
      mediaTime: bad,
      cuts: [],
      trimStart: 3,
      trimEnd: 120,
      seekInFlight: false
    });
    expect(Number.isFinite(r.playhead)).toBe(true);
    expect(r.playhead).toBe(3);
    expect(r.playing).toBe(true);
  }
  // With a leading cut at trimStart, a non-finite clock still skips out of it.
  const r = syncFromMedia({
    mediaTime: NaN,
    cuts: [{ start: 3, end: 8 }],
    trimStart: 3,
    trimEnd: 120,
    seekInFlight: false
  });
  expect(r.playhead).toBeCloseTo(8 + SEEK_EPSILON, 6);
  expect(r.inCut).toBe(true);
});

test('syncFromMedia: a cut running past trimEnd stops playback', () => {
  const r = syncFromMedia({
    mediaTime: 118,
    cuts: [{ start: 115, end: 125 }],
    trimStart: 0,
    trimEnd: 120,
    seekInFlight: false
  });
  expect(r).toEqual({ playhead: 120, seekTo: null, playing: false, inCut: true });
});

test('posterDelayMs: floor reached → 0; recent extract → remaining wait', () => {
  expect(posterDelayMs(1000, 800, 100)).toBe(0); // 200ms since last ≥ 100 floor
  expect(posterDelayMs(1000, 950, 100)).toBe(50); // only 50ms elapsed → wait 50
});

test('resolvePlayStart: a playhead in clear time is returned unchanged', () => {
  expect(resolvePlayStart(5, 0, 120, [])).toBe(5);
});

test('resolvePlayStart: a playhead inside a mid-clip cut snaps forward to cut.end', () => {
  expect(resolvePlayStart(5, 0, 120, [{ start: 4, end: 8 }])).toBe(8);
});

test('resolvePlayStart: parked at trimEnd rewinds to trimStart (replay-from-end)', () => {
  expect(resolvePlayStart(120, 0, 120, [])).toBe(0);
});

test('resolvePlayStart: paused inside a cut that ends AT trimEnd rewinds to start (no dead play)', () => {
  // Regression for the dead-play-press: playhead 119 sits inside [118,120) whose
  // end === trimEnd. Skipping forward walks it to 120 (= trimEnd); without the
  // rewind the first RAF tick would stop instantly and nothing would play.
  expect(resolvePlayStart(119, 0, 120, [{ start: 118, end: 120 }])).toBe(0);
});

test('resolvePlayStart: the replay rewind re-skips a cut sitting at trimStart', () => {
  // After rewinding to trimStart=0, a leading cut [0,5) must also be skipped, or
  // play() would (again) start inside a cut.
  expect(resolvePlayStart(120, 0, 120, [{ start: 0, end: 5 }])).toBe(5);
});
