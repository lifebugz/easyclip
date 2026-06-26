import { test, expect } from 'bun:test';
import {
  proposeCut,
  commitCut,
  commitMerge,
  proposeCutEdit,
  deleteCut,
  setTrimRange,
  seedTrimRange
} from './state';
import type { WizardStateShape } from '../wizard/state.svelte';

function baseState(over: Partial<WizardStateShape> = {}): WizardStateShape {
  return {
    currentStep: 'timeline-edit',
    mediaInfo: {
      path: '/x.mp4',
      duration: 120,
      container: 'mov,mp4',
      codec: 'h264',
      ext: 'mp4',
      hasAudio: true,
      keyframes: []
    },
    saveName: '',
    saveDir: '',
    trimRange: { start: 0, end: 120 },
    cuts: [],
    playhead: 0,
    playing: false,
    errorKey: null,
    errorDetails: null,
    ...over
  };
}

test('proposeCut rejects a range shorter than MIN_CUT_DUR', () => {
  const s = baseState();
  expect(proposeCut(s, { start: 10, end: 10.1 })).toEqual({ kind: 'reject' });
});

test('proposeCut commits a clamped range that does not overlap an existing cut', () => {
  const s = baseState();
  expect(proposeCut(s, { start: 10, end: 20 })).toEqual({
    kind: 'commit',
    range: { start: 10, end: 20 }
  });
});

test('proposeCut clamps the range to the trim window', () => {
  const s = baseState({ trimRange: { start: 5, end: 100 } });
  expect(proposeCut(s, { start: 0, end: 20 })).toEqual({
    kind: 'commit',
    range: { start: 5, end: 20 }
  });
});

test('proposeCut returns merge when the range overlaps an existing cut', () => {
  const s = baseState({ cuts: [{ id: 'a', start: 30, end: 50 }] });
  expect(proposeCut(s, { start: 40, end: 60 })).toEqual({
    kind: 'merge',
    overlapsId: 'a',
    range: { start: 40, end: 60 }
  });
});

test('commitCut mints a uuid, appends, and keeps cuts sorted ascending by start', () => {
  const s = baseState({ cuts: [{ id: 'a', start: 60, end: 70 }] });
  const created = commitCut(s, { start: 10, end: 20 });
  expect(typeof created.id).toBe('string');
  expect(created.id.length).toBeGreaterThan(0);
  expect(s.cuts.map((c) => c.start)).toEqual([10, 60]);
});

test('proposeCutEdit moves the start edge but floors the cut at MIN_CUT_DUR', () => {
  const s = baseState({ cuts: [{ id: 'a', start: 10, end: 20 }] });
  proposeCutEdit(s, 'a', 'start', 19.95); // would leave 0.05s < MIN_CUT_DUR
  expect(s.cuts[0]?.start).toBeCloseTo(19.75, 5); // clamped to end - MIN_CUT_DUR
});

test('proposeCutEdit clamps the start edge to the trim window', () => {
  const s = baseState({
    trimRange: { start: 5, end: 120 },
    cuts: [{ id: 'a', start: 10, end: 20 }]
  });
  proposeCutEdit(s, 'a', 'start', 0);
  expect(s.cuts[0]?.start).toBe(5);
});

test('proposeCutEdit never inverts a cut stranded in the trimmed-off head (start edge)', () => {
  // The trim.start floor must NOT override the MIN_CUT_DUR ceiling: a cut sitting
  // before the (later-narrowed) trim window must keep start <= end - MIN_CUT_DUR.
  const s = baseState({
    trimRange: { start: 5.3, end: 120 },
    cuts: [{ id: 'a', start: 5.0, end: 5.2 }]
  });
  proposeCutEdit(s, 'a', 'start', 5.25);
  const c = s.cuts[0];
  expect(c?.start).toBeLessThan(c?.end ?? 0); // never inverted
  expect((c?.end ?? 0) - (c?.start ?? 0)).toBeGreaterThanOrEqual(0.25 - 1e-9); // MIN_CUT_DUR
});

test('proposeCutEdit never inverts a cut stranded past the trimmed-off tail (end edge)', () => {
  const s = baseState({
    trimRange: { start: 0, end: 4.8 },
    cuts: [{ id: 'a', start: 5.0, end: 5.2 }]
  });
  proposeCutEdit(s, 'a', 'end', 4.5);
  const c = s.cuts[0];
  expect(c?.end).toBeGreaterThan(c?.start ?? 0); // never inverted
  expect((c?.end ?? 0) - (c?.start ?? 0)).toBeGreaterThanOrEqual(0.25 - 1e-9); // MIN_CUT_DUR
});

test('deleteCut removes by id and leaves others untouched', () => {
  const s = baseState({
    cuts: [
      { id: 'a', start: 10, end: 20 },
      { id: 'b', start: 30, end: 40 }
    ]
  });
  deleteCut(s, 'a');
  expect(s.cuts).toEqual([{ id: 'b', start: 30, end: 40 }]);
});

test('commitMerge keeps the earlier-start id and spans the union', () => {
  const s = baseState({
    cuts: [
      { id: 'a', start: 10, end: 25 },
      { id: 'b', start: 20, end: 40 }
    ]
  });
  commitMerge(s, 'a', 'b');
  expect(s.cuts).toEqual([{ id: 'a', start: 10, end: 40 }]);
});

test('commitMerge keeps the earlier id even when called with args reversed', () => {
  const s = baseState({
    cuts: [
      { id: 'a', start: 10, end: 25 },
      { id: 'b', start: 20, end: 40 }
    ]
  });
  commitMerge(s, 'b', 'a');
  expect(s.cuts).toEqual([{ id: 'a', start: 10, end: 40 }]);
});

test('setTrimRange stores a valid range', () => {
  const s = baseState();
  setTrimRange(s, { start: 10, end: 100 });
  expect(s.trimRange).toEqual({ start: 10, end: 100 });
});

test('setTrimRange enforces MIN_TRIM_DUR and clamps to [0, duration]', () => {
  const s = baseState(); // duration 120
  setTrimRange(s, { start: 50, end: 50.2 }); // window too small
  expect(s.trimRange.end - s.trimRange.start).toBeGreaterThanOrEqual(1.0);
  setTrimRange(s, { start: -5, end: 999 });
  expect(s.trimRange.start).toBe(0);
  expect(s.trimRange.end).toBe(120);
});

test('setTrimRange snaps a paused playhead into the new window (§6.2 invariant)', () => {
  const s = baseState({ playhead: 5 });
  setTrimRange(s, { start: 50, end: 120 }); // narrow past the playhead
  expect(s.playhead).toBe(50); // pulled up to the new start
});

test('setTrimRange leaves an in-window playhead untouched', () => {
  const s = baseState({ playhead: 30 });
  setTrimRange(s, { start: 10, end: 100 });
  expect(s.playhead).toBe(30);
});

test('setTrimRange pulls a playhead above the new end down to it', () => {
  const s = baseState({ playhead: 110 });
  setTrimRange(s, { start: 0, end: 80 });
  expect(s.playhead).toBe(80);
});

function infoWithDuration(duration: number): WizardStateShape['mediaInfo'] {
  return {
    path: '/x.mp4',
    duration,
    container: 'mov,mp4',
    codec: 'h264',
    ext: 'mp4',
    hasAudio: true,
    keyframes: []
  };
}

test('seedTrimRange seeds {0, duration} when the range is still pristine (end === 0)', () => {
  const s = baseState({ trimRange: { start: 0, end: 0 } }); // duration 120
  expect(seedTrimRange(s)).toEqual({ start: 0, end: 120 });
});

test('seedTrimRange returns null when the probe duration is zero (no degenerate {0,0} seed)', () => {
  const s = baseState({ mediaInfo: infoWithDuration(0), trimRange: { start: 0, end: 0 } });
  expect(seedTrimRange(s)).toBeNull();
});

test('seedTrimRange returns null when the probe duration is negative', () => {
  const s = baseState({ mediaInfo: infoWithDuration(-5), trimRange: { start: 0, end: 0 } });
  expect(seedTrimRange(s)).toBeNull();
});

test('seedTrimRange returns null for a non-finite probe duration (NaN / Infinity)', () => {
  const nan = baseState({
    mediaInfo: infoWithDuration(Number.NaN),
    trimRange: { start: 0, end: 0 }
  });
  expect(seedTrimRange(nan)).toBeNull();
  const inf = baseState({
    mediaInfo: infoWithDuration(Number.POSITIVE_INFINITY),
    trimRange: { start: 0, end: 0 }
  });
  expect(seedTrimRange(inf)).toBeNull();
});

test('seedTrimRange returns null when a range is already set (preserves return-from-Save)', () => {
  const s = baseState({ trimRange: { start: 10, end: 100 } });
  expect(seedTrimRange(s)).toBeNull();
});

test('seedTrimRange returns null when mediaInfo is absent', () => {
  const s = baseState({ mediaInfo: null, trimRange: { start: 0, end: 0 } });
  expect(seedTrimRange(s)).toBeNull();
});
