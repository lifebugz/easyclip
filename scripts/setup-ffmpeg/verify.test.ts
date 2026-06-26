import { test, expect } from 'bun:test';
import { verifySha256 } from './verify.ts';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('verifySha256 returns true on matching hash', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'easyclip-verify-test-'));
  const path = join(dir, 'sample.bin');
  writeFileSync(path, 'hello world');
  // sha256("hello world") = b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9
  const expected = 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9';
  const result = await verifySha256(path, expected);
  expect(result).toBe(true);
});

test('verifySha256 throws on mismatch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'easyclip-verify-test-'));
  const path = join(dir, 'sample.bin');
  writeFileSync(path, 'hello world');
  let thrown = false;
  let message = '';
  try {
    await verifySha256(path, '0'.repeat(64));
  } catch (err) {
    thrown = true;
    message = err instanceof Error ? err.message : String(err);
  }
  expect(thrown).toBe(true);
  expect(message).toMatch(/checksum mismatch/i);
});
