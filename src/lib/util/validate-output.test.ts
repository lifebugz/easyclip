import { test, expect } from 'bun:test';
import { validateSaveName, validateSaveDir } from './validate-output';

// ─── validateSaveName ────────────────────────────────────────────────

test('validateSaveName: empty string is empty', () => {
  expect(validateSaveName('')).toBe('save.error.empty');
});

test('validateSaveName: whitespace-only is empty', () => {
  expect(validateSaveName('   ')).toBe('save.error.empty');
  expect(validateSaveName('\t\n')).toBe('save.error.empty');
});

test('validateSaveName: typical clean name passes', () => {
  expect(validateSaveName('my-clip')).toBeNull();
  expect(validateSaveName('vacation_2026.mov-trimmed')).toBeNull();
  expect(validateSaveName('file with spaces')).toBeNull();
  expect(validateSaveName('שלום-עולם')).toBeNull();
});

test('validateSaveName: shell metacharacters are rejected', () => {
  for (const bad of ['a;b', 'a|b', 'a&b', 'a$b', 'a`b', 'a\nb', 'a\rb', 'a\0b']) {
    expect(validateSaveName(bad)).toBe('save.error.invalid_chars');
  }
});

test('validateSaveName: forward slash is rejected (would split into subdir)', () => {
  expect(validateSaveName('foo/bar')).toBe('save.error.invalid_chars');
});

test('validateSaveName: backslash is rejected (Windows separator; portable model)', () => {
  expect(validateSaveName('foo\\bar')).toBe('save.error.invalid_chars');
});

test('validateSaveName: Windows-reserved stems are rejected (case-insensitive)', () => {
  for (const bad of [
    'CON',
    'PRN',
    'AUX',
    'NUL',
    'COM1',
    'COM9',
    'LPT1',
    'LPT9',
    'con',
    'Nul',
    'lpt5'
  ]) {
    expect(validateSaveName(bad)).toBe('save.error.invalid_chars');
  }
});

test('validateSaveName: reserved name with extension is still rejected (stem matches)', () => {
  expect(validateSaveName('CON.mp4')).toBe('save.error.invalid_chars');
  expect(validateSaveName('nul.txt')).toBe('save.error.invalid_chars');
});

test('validateSaveName: names that contain a reserved word but are not the stem pass', () => {
  expect(validateSaveName('mycon')).toBeNull();
  expect(validateSaveName('coffee')).toBeNull();
  expect(validateSaveName('PRNCESS')).toBeNull();
  expect(validateSaveName('lpt5x')).toBeNull();
});

test('validateSaveName: leading-dot filename keeps stem intact (not reserved)', () => {
  // stem('.gitignore') is '.gitignore' (lastIndexOf('.') === 0 → return whole).
  // Not in WINDOWS_RESERVED_STEMS, so should pass.
  expect(validateSaveName('.gitignore')).toBeNull();
  expect(validateSaveName('.hidden')).toBeNull();
});

test('validateSaveName: multi-dot stem strips only the LAST extension', () => {
  // stem('archive.tar.gz') → 'archive.tar' (uppercase 'ARCHIVE.TAR' — not reserved).
  expect(validateSaveName('archive.tar.gz')).toBeNull();
  // stem('file.a.b') → 'file.a' — not reserved.
  expect(validateSaveName('file.a.b')).toBeNull();
});

test('validateSaveName: COM10 / LPT10 are NOT reserved (only 1-9)', () => {
  expect(validateSaveName('COM10')).toBeNull();
  expect(validateSaveName('LPT10')).toBeNull();
});

// ─── validateSaveDir ─────────────────────────────────────────────────

test('validateSaveDir: empty string is empty', () => {
  expect(validateSaveDir('')).toBe('save.error.empty');
});

test('validateSaveDir: whitespace-only is empty', () => {
  expect(validateSaveDir('   ')).toBe('save.error.empty');
});

test('validateSaveDir: typical POSIX dir passes', () => {
  expect(validateSaveDir('/Users/me/Movies')).toBeNull();
  expect(validateSaveDir('/var/tmp')).toBeNull();
});

test('validateSaveDir: typical Windows dir passes (backslash separators allowed)', () => {
  expect(validateSaveDir('C:\\Users\\me\\Movies')).toBeNull();
});

test('validateSaveDir: shell metacharacters are rejected', () => {
  for (const bad of ['/a;b', '/a|b', '/a&b', '/a$b', '/a`b', '/a\nb', '/a\rb', '/a\0b']) {
    expect(validateSaveDir(bad)).toBe('save.error.invalid_chars');
  }
});

test('validateSaveDir: forward slashes are allowed (POSIX separator)', () => {
  expect(validateSaveDir('/a/b/c')).toBeNull();
});

test('validateSaveDir: backslashes are allowed (Windows separator)', () => {
  expect(validateSaveDir('C:\\a\\b\\c')).toBeNull();
});
