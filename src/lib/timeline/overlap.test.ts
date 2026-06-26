import { test, expect } from 'bun:test';
import {
  rangesOverlap,
  findOverlapping,
  clampToTrim,
  mergeRanges,
  removedWithinTrim
} from './overlap';
import type { Cut } from '../wizard/state.svelte';

const cut = (id: string, start: number, end: number): Cut => ({ id, start, end });

test('rangesOverlap is true for strict overlap, false for disjoint', () => {
  expect(rangesOverlap({ start: 0, end: 5 }, { start: 3, end: 8 })).toBe(true);
  expect(rangesOverlap({ start: 0, end: 5 }, { start: 6, end: 8 })).toBe(false);
});

test('findOverlapping returns the first adjacent overlapping-or-touching pair (sorted by start), else null', () => {
  expect(findOverlapping([cut('a', 0, 5), cut('b', 6, 9)])).toBeNull();
  // touching counts (matches bundle b.start <= a.end)
  expect(findOverlapping([cut('a', 0, 5), cut('b', 5, 9)])).toEqual({
    a: cut('a', 0, 5),
    b: cut('b', 5, 9)
  });
  // overlap, returned in start order regardless of input order
  expect(findOverlapping([cut('b', 4, 9), cut('a', 0, 5)])).toEqual({
    a: cut('a', 0, 5),
    b: cut('b', 4, 9)
  });
});

test('clampToTrim clamps a value into [trim.start, trim.end]', () => {
  expect(clampToTrim(3, { start: 1, end: 9 })).toBe(3);
  expect(clampToTrim(0, { start: 1, end: 9 })).toBe(1);
  expect(clampToTrim(99, { start: 1, end: 9 })).toBe(9);
});

test('mergeRanges spans the union of two ranges', () => {
  expect(mergeRanges({ start: 2, end: 5 }, { start: 4, end: 9 })).toEqual({ start: 2, end: 9 });
  expect(mergeRanges({ start: 4, end: 9 }, { start: 2, end: 5 })).toEqual({ start: 2, end: 9 });
});

test('removedWithinTrim sums disjoint cut lengths', () => {
  const trim = { start: 0, end: 120 };
  expect(removedWithinTrim([], trim)).toBe(0);
  expect(removedWithinTrim([cut('a', 10, 20), cut('b', 30, 40)], trim)).toBe(20);
});

test('removedWithinTrim counts overlapping cuts ONCE (union, not sum)', () => {
  const trim = { start: 0, end: 120 };
  // [40,60] ∪ [50,70] = [40,70] = 30s, NOT 20+20=40
  expect(removedWithinTrim([cut('a', 40, 60), cut('b', 50, 70)], trim)).toBe(30);
  // nested: [20,30] inside [10,50] → 40s
  expect(removedWithinTrim([cut('a', 10, 50), cut('b', 20, 30)], trim)).toBe(40);
  // touching: [10,20] + [20,30] → contiguous 20s
  expect(removedWithinTrim([cut('a', 10, 20), cut('b', 20, 30)], trim)).toBe(20);
});

test('removedWithinTrim sorts internally (order-independent)', () => {
  const trim = { start: 0, end: 120 };
  expect(removedWithinTrim([cut('b', 50, 70), cut('a', 40, 60)], trim)).toBe(30);
});

test('removedWithinTrim clamps each cut to the trim window', () => {
  // partially outside: [80,100] clamped to end 90 → 10s
  expect(removedWithinTrim([cut('a', 80, 100)], { start: 0, end: 90 })).toBe(10);
  // fully outside the (shrunk) trim window → contributes 0
  expect(removedWithinTrim([cut('a', 80, 100)], { start: 0, end: 70 })).toBe(0);
  // head clamp
  expect(removedWithinTrim([cut('a', 0, 20)], { start: 5, end: 120 })).toBe(15);
});
