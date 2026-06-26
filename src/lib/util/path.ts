// Synchronous path-separator accessor for SaveStep's $derived(outputPath).
//
// Backed by @tauri-apps/api/path.sep — sync in Tauri 2 (the amendment §5.3
// import path of @tauri-apps/plugin-os does not export sep in v2; the API
// moved to the core api package). Cached on first read so derived chains
// never pay an indirection.
//
// bootstrapPathSep() is called from +layout.ts:load so the cache is primed
// before the first SaveStep render. The cache + bootstrap pair survives any
// future move of sep back to an async API: only this file changes.

import { sep as tauriSep } from '@tauri-apps/api/path';

let _cache: string | null = null;

export function pathSep(): string {
  if (_cache === null) {
    return '/';
  }
  return _cache;
}

export async function bootstrapPathSep(): Promise<void> {
  if (_cache !== null) return;
  // Only prime from Tauri when the path plugin's sep is actually reachable.
  // Mere presence of __TAURI_INTERNALS__ is NOT enough: Playwright's
  // installTauriMocks injects a partial internals object (invoke only, no
  // .plugins), and tauriSep() dereferences __TAURI_INTERNALS__.plugins.path.sep.
  // Probing the real value keeps the '/' fallback for both Bun units and the
  // vite-only Playwright server, with no caller try/catch.
  if (typeof window === 'undefined') return;
  const internals = (
    window as unknown as {
      __TAURI_INTERNALS__?: { plugins?: { path?: { sep?: unknown } } };
    }
  ).__TAURI_INTERNALS__;
  if (internals?.plugins?.path?.sep === undefined) return;
  _cache = tauriSep();
  // Keep this async (signature + +layout.ts:load await it, and the file is
  // designed to survive sep() moving back to an async API): the explicit
  // resolve satisfies @typescript-eslint/require-await without a real await.
  return Promise.resolve();
}

// Test-only: reset the cache between cases. NOT exported through any other
// boundary. The mangled name keeps it out of autocomplete.
export function __resetForTests(): void {
  _cache = null;
}

// Pure path-string helpers — platform-aware via pathSep(). The Bun tests
// rely on the fallback `'/'` separator; in the Tauri runtime they pick up
// the real platform separator transparently because `pathSep()` reads
// from the cache primed by bootstrapPathSep() at +layout.ts:load.

/**
 * Extract the filename stem from a path: drop the directory prefix and
 * the final `.ext`. Multiple dots in the basename keep all but the last
 * extension (e.g. `archive.tar.gz` → `archive.tar`). Returns the whole
 * basename when no `.` is present (e.g. `README` → `README`). Empty
 * input → empty output.
 *
 * Phase 5 FilePickStep uses this to seed `saveName`. Phase 6 SaveStep's
 * input-normalisation `$effect` may reuse it.
 */
export function pathStem(path: string): string {
  if (path === '') return '';
  const sep = pathSep();
  const lastSepIdx = path.lastIndexOf(sep);
  const basename = lastSepIdx === -1 ? path : path.slice(lastSepIdx + 1);
  const lastDotIdx = basename.lastIndexOf('.');
  if (lastDotIdx <= 0) {
    // Either no dot, or the dot is at position 0 (a dotfile like `.gitignore`
    // — preserve as-is; lossy stripping would surprise users).
    return lastDotIdx === 0 ? basename : basename;
  }
  return basename.slice(0, lastDotIdx);
}

/**
 * Return the parent directory of a path: everything up to (but not
 * including) the last separator. Trailing separators are dropped first
 * so `/foo/bar/` and `/foo/bar` both yield `/foo`. A bare basename
 * (no separator) yields `''`.
 *
 * Phase 5 FilePickStep uses this to seed `saveDir`.
 */
export function pathDirname(path: string): string {
  if (path === '') return '';
  const sep = pathSep();
  // Drop a trailing separator so dirname("/a/b/") behaves like POSIX dirname(1).
  const trimmed = path.endsWith(sep) ? path.slice(0, -sep.length) : path;
  const lastSepIdx = trimmed.lastIndexOf(sep);
  if (lastSepIdx === -1) return '';
  return trimmed.slice(0, lastSepIdx);
}

/**
 * Compose an output file path from a filename (without extension), a
 * directory, and a canonical extension. Returns `null` when any input is
 * empty after normalisation — refusing to compose half-paths is more useful
 * than emitting `<dir>/.<ext>` or `/<name>.<ext>`.
 *
 * Normalisation rules (amendment §5.3 / v1 spec §11 Phase 6):
 * 1. Trim a trailing `pathSep()` from `saveDir` (so the user can type
 *    `/Users/me/Movies` OR `/Users/me/Movies/` and get the same result).
 * 2. Strip a trailing `.${ext}` (case-insensitive) from `saveName` (so the
 *    user can type `clip` OR `clip.mp4` and get the same result). The
 *    canonical extension wins — the user's casing on the typed extension is
 *    normalised away.
 *
 * After normalisation, recompose as `saveDir + pathSep() + saveName + . + ext`.
 *
 * Phase 6 SaveStep wraps this in `$derived` for live composition; Phase 9
 * `process_media` callsite will read it the same way. Single source of truth.
 */
export function composeOutputPath(saveName: string, saveDir: string, ext: string): string | null {
  if (ext === '') return null;

  const sep = pathSep();
  const dotExt = `.${ext}`;
  const dotExtLower = dotExt.toLowerCase();

  // Strip trailing sep from saveDir.
  const normDir = saveDir.endsWith(sep) ? saveDir.slice(0, -sep.length) : saveDir;
  if (normDir === '') return null;

  // Strip trailing .ext (case-insensitive) from saveName.
  const lowerName = saveName.toLowerCase();
  const normName = lowerName.endsWith(dotExtLower) ? saveName.slice(0, -dotExt.length) : saveName;
  if (normName === '') return null;

  return `${normDir}${sep}${normName}${dotExt}`;
}
