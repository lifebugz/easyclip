#!/usr/bin/env bun
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchToFile } from './setup-ffmpeg/fetch.ts';
import { verifySha256 } from './setup-ffmpeg/verify.ts';
import { extractArchive } from './setup-ffmpeg/extract.ts';
import { placeSidecar, sidecarFilename, resolveTargetTriple } from './setup-ffmpeg/place.ts';

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

async function fetchOnePackagedBinary(
  base: 'ffmpeg' | 'ffprobe',
  spec: BinarySpec,
  archiveExt: 'zip' | 'tar.xz',
  workDir: string,
  destDir: string,
  triple: string,
  alreadyFetchedArchives: Map<string, string>
): Promise<void> {
  const finalPath = join(destDir, sidecarFilename(triple, base));
  if (existsSync(finalPath)) {
    console.log(`✓ ${base} sidecar already in place at ${finalPath}; skipping fetch.`);
    return;
  }

  // Reuse the archive if a sibling binary already downloaded it.
  let archivePath = alreadyFetchedArchives.get(spec.url);
  if (!archivePath) {
    archivePath = join(workDir, `${base}.${archiveExt}`);
    console.log(`→ Fetching ${base} archive from ${spec.url}…`);
    await fetchToFile(spec.url, archivePath);
    console.log(`→ Verifying SHA256 for ${base} archive…`);
    await verifySha256(archivePath, spec.sha256);
    alreadyFetchedArchives.set(spec.url, archivePath);
  } else {
    console.log(`→ Reusing archive at ${archivePath} for ${base}.`);
  }

  const extractDir = join(workDir, `extracted-${base}`);
  console.log(`→ Extracting ${base}…`);
  await extractArchive(archivePath, extractDir);

  const sourceBinary = join(extractDir, spec.pathInArchive);
  if (!existsSync(sourceBinary)) {
    throw new Error(`extracted archive did not contain ${spec.pathInArchive} for ${base}`);
  }

  console.log(`→ Placing ${base} sidecar at ${finalPath}…`);
  placeSidecar(sourceBinary, destDir, triple, base);
  console.log(`✓ ${base} sidecar ready at ${finalPath}`);
}

async function main(): Promise<void> {
  const checksumPath = join(import.meta.dir, 'ffmpeg-checksums.json');
  const checksums = JSON.parse(readFileSync(checksumPath, 'utf8')) as ChecksumFile;

  const triple = resolveTargetTriple();
  const spec = checksums.targets[triple];
  if (!spec) {
    throw new Error(
      `no FFmpeg sidecar pinned for target triple "${triple}". Update ffmpeg-checksums.json.`
    );
  }

  const destDir = join(import.meta.dir, '..', 'src-tauri', 'binaries');
  const work = mkdtempSync(join(tmpdir(), 'easyclip-setup-ffmpeg-'));
  const archiveCache = new Map<string, string>();

  for (const base of ['ffmpeg', 'ffprobe'] as const) {
    await fetchOnePackagedBinary(
      base,
      spec.binaries[base],
      spec.archive,
      work,
      destDir,
      triple,
      archiveCache
    );
  }
}

if (import.meta.main) {
  await main();
}
