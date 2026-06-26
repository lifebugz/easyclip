import { test, expect } from 'bun:test';
import { formatTimecodePrecise } from './format';

test('formats whole seconds with .00 centiseconds', () => {
  expect(formatTimecodePrecise(0)).toBe('0:00.00');
  expect(formatTimecodePrecise(7)).toBe('0:07.00');
});

test('floors the seconds and appends centiseconds (does NOT round up like formatDuration)', () => {
  expect(formatTimecodePrecise(0.25)).toBe('0:00.25');
  expect(formatTimecodePrecise(0.6)).toBe('0:00.60'); // formatDuration(0.6) would be 0:01
  expect(formatTimecodePrecise(103.2)).toBe('1:43.20');
});

test('formats durations over an hour as H:MM:SS.cc', () => {
  expect(formatTimecodePrecise(3661.5)).toBe('1:01:01.50');
});

test('carries when centiseconds round to 100', () => {
  // 0.999 -> floor 0, round(99.9)=100 -> carry to 1 second, .00
  expect(formatTimecodePrecise(0.999)).toBe('0:01.00');
});

test('returns the em-dash fallback for negative / NaN / Infinity (delegates to formatDuration)', () => {
  expect(formatTimecodePrecise(-1)).toBe('—');
  expect(formatTimecodePrecise(Number.NaN)).toBe('—');
  expect(formatTimecodePrecise(Number.POSITIVE_INFINITY)).toBe('—');
});
