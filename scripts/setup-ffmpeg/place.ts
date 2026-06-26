// scripts/setup-ffmpeg/place.ts — compose sidecar filenames and copy extracted binaries into src-tauri/binaries/
import { copyFileSync, chmodSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

/** Parse the Rust host triple from `rustc -vV`'s `host:` line. */
function detectTargetTriple(): string {
  const r = spawnSync('rustc', ['-vV'], { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error('rustc not found on PATH; install via rustup before running setup:ffmpeg');
  }
  const hostLine = r.stdout.split('\n').find((line) => line.startsWith('host:'));
  if (!hostLine) throw new Error('could not parse rustc -vV output for host triple');
  return hostLine.replace('host:', '').trim();
}

/**
 * Resolve the Tauri target triple: prefer the explicit `EASYCLIP_TARGET_TRIPLE`
 * env var (CI passes the matrix triple) so neither setup:ffmpeg nor the smoke
 * gate depends on `rustc -vV` being present + parseable — the windows-latest
 * image stopped emitting a parseable `host:` line. Falls back to detection
 * locally. Single source so the two scripts can never drift on this rule.
 */
export function resolveTargetTriple(): string {
  return process.env['EASYCLIP_TARGET_TRIPLE'] ?? detectTargetTriple();
}

/** Compose the Tauri sidecar filename: `<base>-<triple>(.exe)?`. */
export function sidecarFilename(triple: string, base: 'ffmpeg' | 'ffprobe' = 'ffmpeg'): string {
  return triple.endsWith('-msvc') ? `${base}-${triple}.exe` : `${base}-${triple}`;
}

export function placeSidecar(
  sourceBinary: string,
  destDir: string,
  triple: string,
  base: 'ffmpeg' | 'ffprobe' = 'ffmpeg'
): void {
  mkdirSync(destDir, { recursive: true });
  const finalPath = `${destDir}/${sidecarFilename(triple, base)}`;
  copyFileSync(sourceBinary, finalPath);
  if (!triple.endsWith('-msvc')) {
    chmodSync(finalPath, 0o755);
  }
}
