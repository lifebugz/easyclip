import { describe, expect, test } from 'bun:test';
import { deriveKeptRanges } from './derive-kept-ranges';

const trim = { start: 0, end: 10 };
const cut = (start: number, end: number, id = 'x') => ({ id, start, end });

describe('deriveKeptRanges', () => {
  test('no cuts → the whole trim window', () => {
    expect(deriveKeptRanges(trim, [])).toEqual([{ start: 0, end: 10 }]);
  });

  test('one middle cut → two kept ranges', () => {
    expect(deriveKeptRanges(trim, [cut(3, 5)])).toEqual([
      { start: 0, end: 3 },
      { start: 5, end: 10 }
    ]);
  });

  test('touching cuts merge into one removed span', () => {
    expect(deriveKeptRanges(trim, [cut(2, 4, 'a'), cut(4, 6, 'b')])).toEqual([
      { start: 0, end: 2 },
      { start: 6, end: 10 }
    ]);
  });

  test('overlapping cuts merge', () => {
    expect(deriveKeptRanges(trim, [cut(2, 5, 'a'), cut(4, 7, 'b')])).toEqual([
      { start: 0, end: 2 },
      { start: 7, end: 10 }
    ]);
  });

  test('unsorted cut input is handled', () => {
    expect(deriveKeptRanges(trim, [cut(6, 8, 'b'), cut(1, 2, 'a')])).toEqual([
      { start: 0, end: 1 },
      { start: 2, end: 6 },
      { start: 8, end: 10 }
    ]);
  });

  test('cuts tiling the whole window → empty', () => {
    expect(deriveKeptRanges(trim, [cut(0, 6, 'a'), cut(6, 10, 'b')])).toEqual([]);
  });

  test('cut at the window head/tail drops the zero-length remainder', () => {
    expect(deriveKeptRanges(trim, [cut(0, 4)])).toEqual([{ start: 4, end: 10 }]);
    expect(deriveKeptRanges(trim, [cut(7, 10)])).toEqual([{ start: 0, end: 7 }]);
  });

  test('cuts outside the trim window are clamped away', () => {
    expect(deriveKeptRanges({ start: 2, end: 8 }, [cut(0, 1, 'a'), cut(9, 12, 'b')])).toEqual([
      { start: 2, end: 8 }
    ]);
  });

  test('degenerate window → empty', () => {
    expect(deriveKeptRanges({ start: 5, end: 5 }, [])).toEqual([]);
  });
});
