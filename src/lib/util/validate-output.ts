// Frontend validation mirror of src-tauri/src/validation.rs::validate_output_path.
//
// Returns the i18n key of the relevant `save.error.*` message on rejection;
// `null` on accept. Two exports for the two fields so the consumer can render
// each field's error in its own slot without re-running both checks at every
// keystroke.
//
// Rust runs the same checks at the IPC boundary as defense-in-depth; the
// frontend's job is to give the user immediate inline feedback before they
// click Start processing.
//
// Pure — no module-scope state, no side effects. Bun-testable.

import type { TranslationKey } from '$lib/i18n/index.svelte';

// Shell metacharacters from validation.rs::validate_no_shell_metachars.
// Conservative deny list: any of these in user input indicates either an
// injection attempt or a path the FFmpeg sidecar cannot safely process.
const SHELL_METACHARS = [';', '|', '&', '$', '`', '\n', '\r', '\0'];

// Path separators denied inside a filename. POSIX and Windows both, regardless
// of host — the model is portable: a user typing "foo/bar" intends a subdirectory,
// which is a UX bug rather than a save target, so we reject inline before the
// Rust validator complains.
const PATH_SEPARATORS_IN_NAME = ['/', '\\'];

// Windows reserved device names from validation.rs::validate_not_reserved_windows_name.
// Match is on the file_stem() (i.e., the basename minus the last extension),
// case-insensitive. COM and LPT have only 1-9 reserved; COM10 / LPT10 / etc.
// are allowed.
const WINDOWS_RESERVED_STEMS = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9'
]);

function containsAny(input: string, needles: readonly string[]): boolean {
  for (const n of needles) {
    if (input.includes(n)) return true;
  }
  return false;
}

function stem(name: string): string {
  // Mirrors Rust's Path::file_stem(): the basename with the last `.ext` removed.
  // Phase 6 calls this only after path-separator rejection, so `name` is a bare
  // basename — no need to split on '/' or '\\' here.
  const lastDot = name.lastIndexOf('.');
  if (lastDot <= 0) return name; // no dot, or leading dot (e.g. ".gitignore" — stem stays as-is)
  return name.slice(0, lastDot);
}

/**
 * Validate a filename for the save destination. Returns `null` on accept;
 * otherwise the i18n key of the relevant `save.error.*` message.
 *
 * Mirrors src-tauri/src/validation.rs::validate_output_path's filename rules:
 * shell metacharacters and Windows-reserved stems are rejected. Additionally
 * rejects path separators (POSIX `/` and Windows `\`) — a filename is never
 * supposed to contain those, and accepting them would silently create a
 * subdirectory or split the path.
 */
export function validateSaveName(name: string): TranslationKey | null {
  if (name.trim() === '') return 'save.error.empty';
  if (containsAny(name, SHELL_METACHARS)) return 'save.error.invalid_chars';
  if (containsAny(name, PATH_SEPARATORS_IN_NAME)) return 'save.error.invalid_chars';
  const upperStem = stem(name).toUpperCase();
  if (WINDOWS_RESERVED_STEMS.has(upperStem)) return 'save.error.invalid_chars';
  return null;
}

/**
 * Validate the save directory. Returns `null` on accept; otherwise the i18n
 * key of the relevant `save.error.*` message.
 *
 * Mirrors src-tauri/src/validation.rs::validate_output_path's path-string rules
 * minus the existence check (which only runs in Rust at the IPC boundary;
 * the frontend cannot stat the filesystem). Path separators are allowed —
 * a directory path is supposed to contain them.
 */
export function validateSaveDir(dir: string): TranslationKey | null {
  if (dir.trim() === '') return 'save.error.empty';
  if (containsAny(dir, SHELL_METACHARS)) return 'save.error.invalid_chars';
  return null;
}
