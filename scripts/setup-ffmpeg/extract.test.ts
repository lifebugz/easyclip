import { test, expect } from 'bun:test';
import { extractArchive } from './extract.ts';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// The `zip` CLI (archive CREATION) isn't present on the Windows CI runner — only
// `unzip` and `tar` are. This fixture builds a .zip with `zip`, so skip it where
// `zip` is unavailable. The zip-EXTRACTION path it targets (extractArchive →
// `unzip`) is still covered on Windows end-to-end by the real "Fetch FFmpeg
// sidecar" CI step, which unzips a BtbN .zip.
const zipAvailable = spawnSync('zip', ['-h'], { stdio: 'ignore' }).error === undefined;

test.skipIf(!zipAvailable)('extractArchive extracts a zip archive', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'easyclip-extract-zip-'));
  const archivePath = join(dir, 'test.zip');
  mkdirSync(join(dir, 'src'), { recursive: true });
  const innerFile = join(dir, 'src', 'inner.txt');
  writeFileSync(innerFile, 'hello');
  spawnSync('zip', ['-j', archivePath, innerFile], { stdio: 'ignore' });

  const outDir = join(dir, 'out');
  await extractArchive(archivePath, outDir);
  expect(existsSync(join(outDir, 'inner.txt'))).toBe(true);
  expect(readFileSync(join(outDir, 'inner.txt'), 'utf8')).toBe('hello');
});

test('extractArchive extracts a tar.xz archive', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'easyclip-extract-tar-'));
  const archivePath = join(dir, 'test.tar.xz');
  mkdirSync(join(dir, 'src'), { recursive: true });
  const innerFile = join(dir, 'src', 'inner.txt');
  writeFileSync(innerFile, 'hi');
  spawnSync('tar', ['-cJf', archivePath, '-C', join(dir, 'src'), 'inner.txt'], { stdio: 'ignore' });

  const outDir = join(dir, 'out');
  await extractArchive(archivePath, outDir);
  expect(existsSync(join(outDir, 'inner.txt'))).toBe(true);
});

test('extractArchive rejects unknown extensions', async () => {
  let thrown = false;
  let message = '';
  try {
    await extractArchive('/tmp/x.rar', '/tmp/out');
  } catch (err) {
    thrown = true;
    message = err instanceof Error ? err.message : String(err);
  }
  expect(thrown).toBe(true);
  expect(message).toMatch(/unsupported archive/i);
});
