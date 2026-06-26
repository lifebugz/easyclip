import { test, expect } from 'bun:test';
import { timeToPct, xToTime } from './coord';

test('timeToPct maps time to percent of duration', () => {
  expect(timeToPct(0, 120)).toBe(0);
  expect(timeToPct(30, 120)).toBe(25);
  expect(timeToPct(60, 120)).toBe(50);
  expect(timeToPct(120, 120)).toBe(100);
});

test('timeToPct returns 0 for non-positive or non-finite duration (no division by zero / NaN leak)', () => {
  expect(timeToPct(5, 0)).toBe(0);
  expect(timeToPct(5, -1)).toBe(0);
  expect(timeToPct(5, Number.NaN)).toBe(0);
  expect(timeToPct(5, Number.POSITIVE_INFINITY)).toBe(0);
});

test('xToTime maps a pointer x within the track rect to a time', () => {
  const rect = { x: 100, width: 400 };
  expect(xToTime(100, rect, 120)).toBe(0); // at left edge
  expect(xToTime(300, rect, 120)).toBe(60); // halfway
  expect(xToTime(500, rect, 120)).toBe(120); // at right edge
});

test('xToTime clamps pointer x outside the track to [0, duration]', () => {
  const rect = { x: 100, width: 400 };
  expect(xToTime(50, rect, 120)).toBe(0); // left of track
  expect(xToTime(900, rect, 120)).toBe(120); // right of track
});

test('xToTime returns 0 for a zero-width rect', () => {
  expect(xToTime(100, { x: 0, width: 0 }, 120)).toBe(0);
});

test('xToTime returns 0 for non-finite duration (no NaN leak into writers)', () => {
  expect(xToTime(300, { x: 100, width: 400 }, Number.NaN)).toBe(0);
  expect(xToTime(300, { x: 100, width: 400 }, Number.POSITIVE_INFINITY)).toBe(0);
});
