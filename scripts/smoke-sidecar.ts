#!/usr/bin/env bun
// scripts/smoke-sidecar.ts — proves the sidecar fetch + spawn pipeline works end-to-end.
// Runs as part of `bun run check` AND as a Phase 1 acceptance gate.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { sidecarFilename } from './setup-ffmpeg/place.ts';

function detectTargetTriple(): string {
  const r = spawnSync('rustc', ['-vV'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('rustc not found');
  const hostLine = r.stdout.split('\n').find((line) => line.startsWith('host:'));
  if (!hostLine) throw new Error('cannot parse rustc -vV');
  return hostLine.replace('host:', '').trim();
}

function smokeOne(triple: string, base: 'ffmpeg' | 'ffprobe', expectedSubstring: string): void {
  const path = join(import.meta.dir, '..', 'src-tauri', 'binaries', sidecarFilename(triple, base));
  if (!existsSync(path)) {
    console.error(`✗ ${base} sidecar not present at ${path}`);
    console.error('  Run `bun run setup:ffmpeg` first.');
    process.exit(1);
  }
  const r = spawnSync(path, ['-version'], { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(`✗ ${base} failed to run: exit ${String(r.status)}`);
    console.error(r.stderr);
    process.exit(1);
  }
  if (!r.stdout.includes(expectedSubstring)) {
    console.error(`✗ ${base} output does not contain "${expectedSubstring}"`);
    console.error(r.stdout);
    process.exit(1);
  }
  const firstLine = r.stdout.split('\n')[0] ?? '';
  if (base === 'ffmpeg') {
    const versionLine = firstLine;
    // BtbN Windows builds prefix the version token with "n" ("n8.1.1-12-g…");
    // martin-riedl macOS/Linux builds don't ("8.1.1-https://…"). Strip leading
    // non-digits before parsing the major or Number() yields NaN on Windows.
    const major = Number(versionLine.split(' ')[2]?.replace(/^\D*/, '').split(/[.-]/)[0] ?? '0');
    if (!(major >= 4)) {
      throw new Error(`sidecar ffmpeg too old for input-side -to (need >= 4): ${versionLine}`);
    }
  }
  console.log(`✓ ${base} smoke OK: ${firstLine}`);
}

function main(): void {
  const triple = detectTargetTriple();
  smokeOne(triple, 'ffmpeg', 'ffmpeg version');
  smokeOne(triple, 'ffprobe', 'ffprobe version');
}

if (import.meta.main) {
  main();
}
