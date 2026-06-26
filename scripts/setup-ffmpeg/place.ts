// scripts/setup-ffmpeg/place.ts — compose sidecar filenames and copy extracted binaries into src-tauri/binaries/
import { copyFileSync, chmodSync, mkdirSync } from 'node:fs';

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
