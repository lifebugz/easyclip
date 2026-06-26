// Native file picker wrapper.
//
// Hides `@tauri-apps/plugin-dialog::open`'s union return type
// (`string | string[] | null`) behind a `Promise<string | null>` so
// callers don't need to narrow it themselves at every call site.
//
// No test-hook seam — Playwright e2e tests intercept the underlying
// `@tauri-apps/api/core::invoke('plugin:dialog|open', ...)` call by
// installing a mock `window.__TAURI_INTERNALS__` via page.addInitScript
// (canonical Tauri 2 pattern; see docs/develop/Tests/mocking.md and
// tests/e2e/helpers/tauri-mocks.ts). Production code paths read
// __TAURI_INTERNALS__ exactly as they would under real Tauri.

import { open as tauriOpen } from '@tauri-apps/plugin-dialog';

export interface MediaFileFilter {
  name: string;
  extensions: string[];
}

// UX hint — the picker is restrictive about which files it lists, but
// this is NOT a security boundary (the user can paste any path; defense
// lives in Rust's validate_media_path). FILE-01 from v1 spec §10.
const VIDEO_EXTENSIONS = [
  'mp4',
  'mov',
  'm4v',
  'mkv',
  'webm',
  'avi',
  'wmv',
  'flv',
  'mpg',
  'mpeg',
  'ts',
  '3gp',
  '3g2',
  'mts',
  'm2ts'
];
const AUDIO_EXTENSIONS = ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus'];

const MEDIA_FILTERS: MediaFileFilter[] = [
  { name: 'Media', extensions: [...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS] },
  { name: 'Video', extensions: VIDEO_EXTENSIONS },
  { name: 'Audio', extensions: AUDIO_EXTENSIONS }
];

/**
 * Open the native file picker scoped to media files. Resolves with the
 * absolute path on selection, `null` on cancel. Never resolves to a
 * string array because we pin `multiple: false`.
 */
export async function pickMediaFile(): Promise<string | null> {
  const result = await tauriOpen({
    multiple: false,
    directory: false,
    filters: MEDIA_FILTERS
  });

  // Defensive narrowing: with multiple:false + directory:false the runtime
  // contract is string | null, but the TS union from @tauri-apps/plugin-dialog
  // includes string[] too. Coerce anything non-string to null.
  if (typeof result === 'string') return result;
  return null;
}

/**
 * Open the native folder picker. Resolves with the absolute directory path
 * on selection, `null` on cancel. Never resolves to a string array because
 * we pin `multiple: false`.
 *
 * Phase 6 SaveStep "Choose…" button uses this to populate `wizardState.saveDir`
 * without disturbing `wizardState.saveName` (preserving any custom name the
 * user typed before clicking Choose).
 */
export async function pickFolder(): Promise<string | null> {
  const result = await tauriOpen({
    multiple: false,
    directory: true
  });

  if (typeof result === 'string') return result;
  return null;
}
