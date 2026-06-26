#!/usr/bin/env bun
// scripts/update-ffmpeg-hashes.ts — refreshes ffmpeg-checksums.json after a version bump.
// Run manually; commits the regenerated JSON.
import { readFileSync, writeFileSync, mkdtempSync, createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fetchToFile } from './setup-ffmpeg/fetch.ts';

async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(path);
  await new Promise<void>((resolve, reject) => {
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => {
      resolve();
    });
    stream.on('error', reject);
  });
  return hash.digest('hex');
}

interface BinarySpec {
  url: string;
  sha256: string;
  pathInArchive: string;
}
interface TargetSpec {
  archive: 'zip' | 'tar.xz';
  binaries: Record<'ffmpeg' | 'ffprobe', BinarySpec>;
  source: string;
}
interface ChecksumFile {
  ffmpegVersion: string;
  license: string;
  targets: Record<string, TargetSpec>;
}

async function main(): Promise<void> {
  const path = join(import.meta.dir, 'ffmpeg-checksums.json');
  const file = JSON.parse(readFileSync(path, 'utf8')) as ChecksumFile;
  const work = mkdtempSync(join(tmpdir(), 'easyclip-update-hashes-'));

  // Deduplicate by URL so Windows targets (which ship ffmpeg + ffprobe in one
  // archive) hash that archive only once per pass.
  const urlToHash = new Map<string, string>();
  let archiveCounter = 0;

  for (const [triple, spec] of Object.entries(file.targets)) {
    const ext = spec.archive === 'zip' ? 'zip' : 'tar.xz';
    for (const [base, binSpec] of Object.entries(spec.binaries) as [
      keyof TargetSpec['binaries'],
      BinarySpec
    ][]) {
      let newHash = urlToHash.get(binSpec.url);
      if (newHash === undefined) {
        const archivePath = join(work, `${triple}-${base}-${String(archiveCounter++)}.${ext}`);
        console.log(`→ ${triple}/${base}: fetching ${binSpec.url}`);
        await fetchToFile(binSpec.url, archivePath);
        newHash = await sha256Of(archivePath);
        urlToHash.set(binSpec.url, newHash);
      } else {
        console.log(`→ ${triple}/${base}: reusing hash for ${binSpec.url}`);
      }
      if (binSpec.sha256 === newHash) {
        console.log(`  ✓ unchanged: ${newHash}`);
      } else {
        console.log(`  Δ updated:  ${binSpec.sha256} → ${newHash}`);
        binSpec.sha256 = newHash;
      }
    }
  }

  writeFileSync(path, JSON.stringify(file, null, 2) + '\n');
  console.log(`\n✓ Wrote ${path}`);
  console.log('Now run `bun run setup:ffmpeg` and verify it succeeds, then commit.');
}

if (import.meta.main) {
  await main();
}
