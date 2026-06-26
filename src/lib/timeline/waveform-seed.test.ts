import { test, expect } from 'bun:test';
import { seedToWaveBars } from './waveform-seed';

test('deterministic: same path + same bins → identical output', () => {
  expect(seedToWaveBars('/movies/a.mp4', 64)).toEqual(seedToWaveBars('/movies/a.mp4', 64));
});

test('varies: different paths → different output', () => {
  expect(seedToWaveBars('/movies/a.mp4', 64)).not.toEqual(seedToWaveBars('/movies/b.mp4', 64));
});

test('bins = 0 → empty array', () => {
  expect(seedToWaveBars('/movies/a.mp4', 0)).toEqual([]);
});

test('negative bins → empty array', () => {
  expect(seedToWaveBars('/movies/a.mp4', -3)).toEqual([]);
});

test('bins = 1 → single value within [0, 1]', () => {
  const bars = seedToWaveBars('/movies/a.mp4', 1);
  expect(bars).toHaveLength(1);
  expect(bars[0]).toBeGreaterThanOrEqual(0);
  expect(bars[0]).toBeLessThanOrEqual(1);
});

test('all bars are within [0, 1]', () => {
  const bars = seedToWaveBars('/movies/a.mp4', 64);
  expect(bars).toHaveLength(64);
  for (const h of bars) {
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(1);
  }
});
