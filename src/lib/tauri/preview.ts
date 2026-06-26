import { convertFileSrc, invoke } from '@tauri-apps/api/core';

/**
 * Resolve a dialog-picked file path to a webview-loadable asset URL, or `null`
 * outside Tauri. We feature-detect the SPECIFIC field `__TAURI_INTERNALS__.
 * convertFileSrc` rather than calling `isTauri()`: `isTauri()` reads
 * `globalThis.isTauri`, a boolean the native runtime injects that the Playwright
 * harness does NOT set — so an `isTauri()` guard would return `null` under the
 * mock and route every mocked e2e test to `art` mode. This mirrors the
 * `bootstrapPathSep` precedent (util/path.ts). A `null` URL makes VideoPreview
 * fall back to `art` mode (no decodable source), keeping "art = no regression"
 * real in plain `vite dev`.
 */
export function assetUrl(path: string): string | null {
  if (path === '') return null;
  if (typeof window === 'undefined') return null;
  const internals = (window as unknown as { __TAURI_INTERNALS__?: { convertFileSrc?: unknown } })
    .__TAURI_INTERNALS__;
  if (typeof internals?.convertFileSrc !== 'function') return null;
  return convertFileSrc(path);
}

/**
 * Extract a single poster frame at `timeSeconds` via the Rust `extract_poster_
 * frame` command. Resolves with a ready-to-assign `data:` URL; rejects with the
 * AppError-shaped payload (callers treat any rejection as "keep previous poster
 * / show art").
 */
export async function posterFrame(path: string, timeSeconds: number): Promise<string> {
  const b64 = await invoke<string>('extract_poster_frame', { path, timeSeconds });
  return `data:image/jpeg;base64,${b64}`;
}
