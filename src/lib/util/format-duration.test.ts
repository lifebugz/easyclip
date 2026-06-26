import { test, expect } from 'bun:test';
import { formatDuration } from './format-duration';

test('formats seconds under one minute as 0:SS', () => {
  expect(formatDuration(0)).toBe('0:00');
  expect(formatDuration(7)).toBe('0:07');
  expect(formatDuration(59)).toBe('0:59');
});

test('formats sub-hour durations as M:SS / MM:SS', () => {
  expect(formatDuration(60)).toBe('1:00');
  expect(formatDuration(75)).toBe('1:15');
  expect(formatDuration(599)).toBe('9:59');
  expect(formatDuration(600)).toBe('10:00');
  expect(formatDuration(3599)).toBe('59:59');
});

test('formats hour-plus durations as H:MM:SS', () => {
  expect(formatDuration(3600)).toBe('1:00:00');
  expect(formatDuration(3661)).toBe('1:01:01');
  expect(formatDuration(7200)).toBe('2:00:00');
  expect(formatDuration(36000)).toBe('10:00:00');
});

test('rounds sub-second fractions to the nearest second', () => {
  expect(formatDuration(0.4)).toBe('0:00');
  expect(formatDuration(0.6)).toBe('0:01');
  expect(formatDuration(59.5)).toBe('1:00');
  expect(formatDuration(3599.6)).toBe('1:00:00');
});

test('returns em-dash fallback for NaN / Infinity / negative inputs', () => {
  expect(formatDuration(Number.NaN)).toBe('—');
  expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('—');
  expect(formatDuration(Number.NEGATIVE_INFINITY)).toBe('—');
  expect(formatDuration(-1)).toBe('—');
  expect(formatDuration(-0.5)).toBe('—');
});
