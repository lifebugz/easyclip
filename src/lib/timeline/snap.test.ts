import { test, expect } from 'bun:test';
import { snapToKeyframe } from './snap';

test('empty keyframes never snaps', () => {
  expect(snapToKeyframe(5, [], 1)).toEqual({ time: 5, snapped: false, index: -1 });
});

test('time before all keyframes snaps to the first when within radius', () => {
  expect(snapToKeyframe(-2, [0, 10, 20], 5)).toEqual({ time: 0, snapped: true, index: 0 });
});

test('time before all keyframes does not snap when outside radius', () => {
  expect(snapToKeyframe(-10, [0, 10, 20], 5)).toEqual({ time: -10, snapped: false, index: -1 });
});

test('time after all keyframes snaps to the last when within radius', () => {
  expect(snapToKeyframe(122, [0, 10, 120], 5)).toEqual({ time: 120, snapped: true, index: 2 });
});

test('time exactly between two keyframes snaps to the lower index (tie-break)', () => {
  // midpoint 5 is equidistant from 0 and 10; lower index wins
  expect(snapToKeyframe(5, [0, 10], 100)).toEqual({ time: 0, snapped: true, index: 0 });
});

test('closest keyframe wins when several are within radius', () => {
  // 11 is 1 from kf[1]=10 and 9 from kf[2]=20 → snaps to 10
  expect(snapToKeyframe(11, [0, 10, 20], 100)).toEqual({ time: 10, snapped: true, index: 1 });
});

test('zero radius snaps only on an exact keyframe hit', () => {
  expect(snapToKeyframe(10, [0, 10, 20], 0)).toEqual({ time: 10, snapped: true, index: 1 });
  expect(snapToKeyframe(10.01, [0, 10, 20], 0)).toEqual({ time: 10.01, snapped: false, index: -1 });
});

test('single-element keyframes', () => {
  expect(snapToKeyframe(7, [7], 1)).toEqual({ time: 7, snapped: true, index: 0 });
  expect(snapToKeyframe(7, [9], 1)).toEqual({ time: 7, snapped: false, index: -1 });
});

test('handles a keyframe list at the §3.5 cap (50_000) via binary search', () => {
  const kf = Array.from({ length: 50_000 }, (_, i) => i * 0.1); // 0, 0.1, ... 4999.9
  // 2500.04 is closest to index 25000 (=2500.0); within a 0.05 radius
  const r = snapToKeyframe(2500.04, kf, 0.05);
  expect(r.snapped).toBe(true);
  expect(r.index).toBe(25000);
  expect(r.time).toBeCloseTo(2500.0, 6);
});
