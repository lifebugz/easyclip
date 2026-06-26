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

test('validateSaveName: control characters are rejected', () => {
  for (const bad of ['a\nb', 'a\rb', 'a\0b']) {
    expect(validateSaveName(bad)).toBe('save.error.invalid_chars');
  }
});

test('validateSaveName: shell punctuation is accepted (argv spawn, not a shell)', () => {
  // & $ ; ` are valid filename chars on Windows and Unix; ffmpeg runs via argv,
  // so they are never shell-interpreted. A name like "Mom & Dad" must pass.
  for (const ok of ['Mom & Dad', 'a$b', 'a;b', 'back`tick', '100% done']) {
    expect(validateSaveName(ok)).toBeNull();
  }
});

test('validateSaveName: Windows-illegal filename chars are rejected (< > : " | ? *)', () => {
  // These are shell-safe (argv spawn) but illegal in a Windows filename, so a
  // name carrying one would fail the final rename with an opaque OS error.
  // Mirrors validation.rs::validate_no_windows_illegal_name_chars.
  for (const bad of ['a|b', 'a?b', 'a*b', 'a<b', 'a>b', 'a"b', 'a:b']) {
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

test('validateSaveDir: control characters are rejected', () => {
  for (const bad of ['/a\nb', '/a\rb', '/a\0b']) {
    expect(validateSaveDir(bad)).toBe('save.error.invalid_chars');
  }
});

test('validateSaveDir: shell punctuation in a dir path is accepted', () => {
  // e.g. a real folder "C:\Users\Mom & Dad\Videos" must not be rejected.
  for (const ok of ['/Users/Mom & Dad/Videos', 'C:\\Users\\Mom & Dad\\Movies', '/a$b/c', '/a;b']) {
    expect(validateSaveDir(ok)).toBeNull();
  }
});

test('validateSaveDir: forward slashes are allowed (POSIX separator)', () => {
  expect(validateSaveDir('/a/b/c')).toBeNull();
});

test('validateSaveDir: backslashes are allowed (Windows separator)', () => {
  expect(validateSaveDir('C:\\a\\b\\c')).toBeNull();
});
