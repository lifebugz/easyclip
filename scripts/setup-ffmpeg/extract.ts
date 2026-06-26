// scripts/setup-ffmpeg/extract.ts — extracts zip and tar.xz archives.
// Shells out to system `unzip` and `tar` (both available on macOS, Linux, and
// Windows git-bash/CI). For Windows-native PowerShell, the BtbN releases ship as zip
// which `unzip` from MSYS2 / git-bash handles fine.
import { spawnSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';

export async function extractArchive(archivePath: string, outDir: string): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const lower = archivePath.toLowerCase();
  if (lower.endsWith('.zip')) {
    const r = spawnSync('unzip', ['-o', '-q', archivePath, '-d', outDir], { stdio: 'inherit' });
    if (r.status !== 0)
      throw new Error(`unzip failed: exit ${String(r.status)} for ${archivePath}`);
    return;
  }
  if (lower.endsWith('.tar.xz') || lower.endsWith('.txz')) {
    const r = spawnSync('tar', ['-xJf', archivePath, '-C', outDir], { stdio: 'inherit' });
    if (r.status !== 0)
      throw new Error(`tar -xJf failed: exit ${String(r.status)} for ${archivePath}`);
    return;
  }
  throw new Error(`unsupported archive type: ${archivePath}`);
}
