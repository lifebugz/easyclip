import { test, expect } from 'bun:test';
import { advancePlayhead, playbackTransition } from './playback';

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
