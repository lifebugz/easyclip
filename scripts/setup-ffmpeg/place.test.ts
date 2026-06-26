import { test, expect } from 'bun:test';
import { placeSidecar, sidecarFilename } from './place.ts';
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('sidecarFilename returns the right shape per OS', () => {
  expect(sidecarFilename('aarch64-apple-darwin')).toBe('ffmpeg-aarch64-apple-darwin');
  expect(sidecarFilename('x86_64-apple-darwin')).toBe('ffmpeg-x86_64-apple-darwin');
  expect(sidecarFilename('x86_64-pc-windows-msvc')).toBe('ffmpeg-x86_64-pc-windows-msvc.exe');
  expect(sidecarFilename('aarch64-pc-windows-msvc')).toBe('ffmpeg-aarch64-pc-windows-msvc.exe');
  expect(sidecarFilename('x86_64-unknown-linux-gnu')).toBe('ffmpeg-x86_64-unknown-linux-gnu');
});

test('sidecarFilename accepts an explicit base for ffprobe', () => {
  expect(sidecarFilename('aarch64-apple-darwin', 'ffprobe')).toBe('ffprobe-aarch64-apple-darwin');
  expect(sidecarFilename('x86_64-pc-windows-msvc', 'ffprobe')).toBe(
    'ffprobe-x86_64-pc-windows-msvc.exe'
  );
});

test('placeSidecar copies the binary to the Tauri-conventional location', () => {
  const dir = mkdtempSync(join(tmpdir(), 'easyclip-place-'));
  mkdirSync(join(dir, 'extracted'), { recursive: true });
  const src = join(dir, 'extracted', 'ffmpeg');
  writeFileSync(src, 'fake-binary');
  const destDir = join(dir, 'src-tauri', 'binaries');

  placeSidecar(src, destDir, 'aarch64-apple-darwin');
  const placed = join(destDir, 'ffmpeg-aarch64-apple-darwin');
  expect(existsSync(placed)).toBe(true);
});
