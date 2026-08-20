import { test, expect, mock, beforeEach, afterEach } from 'bun:test';

// Mock @tauri-apps/api/path before importing the SUT — the SUT's import binding
// captures whatever module factory is registered at module-evaluation time.
const tauriSepMock = mock(() => '/');
void mock.module('@tauri-apps/api/path', () => ({ sep: tauriSepMock }));

// SUT — imported AFTER the mock so it picks up the mocked binding.
const { pathSep, bootstrapPathSep, __resetForTests, pathStem, pathDirname, composeOutputPath } =
  await import('./path');

beforeEach(() => {
  tauriSepMock.mockReset();
  tauriSepMock.mockReturnValue('/');
  __resetForTests();
});

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

test('pathSep() returns the safe fallback "/" before bootstrap runs', () => {
  expect(pathSep()).toBe('/');
});

test('bootstrapPathSep() primes the cache from @tauri-apps/api/path.sep', async () => {
  (globalThis as unknown as { window: unknown }).window = {
    __TAURI_INTERNALS__: { plugins: { path: { sep: '/' } } }
  };
  tauriSepMock.mockReturnValue('\\');
  await bootstrapPathSep();
  expect(pathSep()).toBe('\\');
  // sep() must be called exactly once during bootstrap — subsequent pathSep()
  // reads come from the cache (no extra Tauri lookups in tight derived chains).
  expect(tauriSepMock).toHaveBeenCalledTimes(1);
});

test('pathSep() reads from cache after bootstrap, never re-calls sep()', async () => {
  (globalThis as unknown as { window: unknown }).window = {
    __TAURI_INTERNALS__: { plugins: { path: { sep: '/' } } }
  };
  tauriSepMock.mockReturnValue('\\');
  await bootstrapPathSep();
  tauriSepMock.mockClear();
  expect(pathSep()).toBe('\\');
  expect(pathSep()).toBe('\\');
  expect(pathSep()).toBe('\\');
  expect(tauriSepMock).not.toHaveBeenCalled();
});

test('bootstrapPathSep() is idempotent — calling it twice does not double-prime', async () => {
  (globalThis as unknown as { window: unknown }).window = {
    __TAURI_INTERNALS__: { plugins: { path: { sep: '/' } } }
  };
  tauriSepMock.mockReturnValue('/');
  await bootstrapPathSep();
  tauriSepMock.mockReturnValue('\\'); // simulate something weird
  await bootstrapPathSep();
  // The first bootstrap won; second is a no-op once the cache is populated.
  expect(pathSep()).toBe('/');
  expect(tauriSepMock).toHaveBeenCalledTimes(1);
});

test('bootstrapPathSep() is a no-op when window is undefined (Bun / non-Tauri)', async () => {
  // window is already undefined in the Bun env; bootstrap must not call sep().
  await bootstrapPathSep();
  expect(pathSep()).toBe('/');
  expect(tauriSepMock).not.toHaveBeenCalled();
});

test('bootstrapPathSep() is a no-op when __TAURI_INTERNALS__ is absent (Playwright web)', async () => {
  (globalThis as unknown as { window?: unknown }).window = {}; // present, but no Tauri internals
  // afterEach deletes window — no per-test teardown needed (matches the sibling tests).
  await bootstrapPathSep();
  expect(pathSep()).toBe('/');
  expect(tauriSepMock).not.toHaveBeenCalled();
});

test('pathStem returns the filename without extension, given a POSIX path', () => {
  // pathSep() returns "/" in Bun tests (fallback); pathStem implicitly uses it.
  expect(pathStem('/Users/me/Movies/team-standup.mov')).toBe('team-standup');
  expect(pathStem('/var/tmp/clip.mp4')).toBe('clip');
});

test('pathStem handles files with multiple dots — only the LAST extension is stripped', () => {
  expect(pathStem('/Users/me/archive.tar.gz')).toBe('archive.tar');
  expect(pathStem('/Users/me/my.file.name.mkv')).toBe('my.file.name');
});

test('pathStem returns the whole basename when there is no extension', () => {
  expect(pathStem('/Users/me/Movies/README')).toBe('README');
  expect(pathStem('README')).toBe('README');
});

test('pathStem handles a path that ends in a dot (no extension after dot)', () => {
  expect(pathStem('/Users/me/Movies/odd.')).toBe('odd');
});

test('pathStem returns empty string for an empty input', () => {
  expect(pathStem('')).toBe('');
});

test('pathStem with a path that is just a basename works', () => {
  expect(pathStem('video.mp4')).toBe('video');
});

test('pathDirname returns the parent directory for a POSIX path', () => {
  expect(pathDirname('/Users/me/Movies/clip.mp4')).toBe('/Users/me/Movies');
  expect(pathDirname('/var/tmp/x.txt')).toBe('/var/tmp');
});

test('pathDirname returns empty string when the path is just a basename', () => {
  expect(pathDirname('clip.mp4')).toBe('');
  expect(pathDirname('README')).toBe('');
});

test('pathDirname returns empty string for an empty input', () => {
  expect(pathDirname('')).toBe('');
});

test('pathDirname handles trailing separators by dropping them first', () => {
  // A trailing separator means "this is a directory path" — dirname of
  // /foo/bar/ is /foo (the parent of /foo/bar). This matches POSIX dirname(1).
  expect(pathDirname('/Users/me/Movies/')).toBe('/Users/me');
});

test('composeOutputPath returns null when saveName is empty', () => {
  expect(composeOutputPath('', '/Users/me', 'mp4')).toBeNull();
});

test('composeOutputPath returns null when saveDir is empty', () => {
  expect(composeOutputPath('clip', '', 'mp4')).toBeNull();
});

test('composeOutputPath returns null when ext is empty', () => {
  expect(composeOutputPath('clip', '/Users/me', '')).toBeNull();
});

test('composeOutputPath composes saveDir + sep + saveName + . + ext for clean inputs', () => {
  expect(composeOutputPath('clip', '/Users/me/Movies', 'mp4')).toBe('/Users/me/Movies/clip.mp4');
});

test('composeOutputPath strips trailing pathSep() from saveDir', () => {
  expect(composeOutputPath('clip', '/Users/me/Movies/', 'mp4')).toBe('/Users/me/Movies/clip.mp4');
});

test('composeOutputPath strips trailing .${ext} from saveName (case-insensitive)', () => {
  expect(composeOutputPath('clip.mp4', '/Users/me', 'mp4')).toBe('/Users/me/clip.mp4');
  expect(composeOutputPath('clip.MP4', '/Users/me', 'mp4')).toBe('/Users/me/clip.mp4');
  expect(composeOutputPath('CLIP.Mp4', '/Users/me', 'mp4')).toBe('/Users/me/CLIP.mp4');
});

test('composeOutputPath does NOT strip a different extension from saveName', () => {
  expect(composeOutputPath('clip.mov', '/Users/me', 'mp4')).toBe('/Users/me/clip.mov.mp4');
});

test('composeOutputPath returns null when stripping leaves saveName empty', () => {
  expect(composeOutputPath('.mp4', '/Users/me', 'mp4')).toBeNull();
});

test('composeOutputPath returns null when stripping leaves saveDir empty', () => {
  expect(composeOutputPath('clip', '/', 'mp4')).toBeNull();
});

test('composeOutputPath preserves embedded dots in saveName when ext matches the LAST one only', () => {
  expect(composeOutputPath('archive.tar.gz', '/Users/me', 'gz')).toBe('/Users/me/archive.tar.gz');
  expect(composeOutputPath('archive.tar.gz', '/Users/me', 'tar')).toBe(
    '/Users/me/archive.tar.gz.tar'
  );
});
