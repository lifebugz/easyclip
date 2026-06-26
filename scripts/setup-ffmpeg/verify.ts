// scripts/setup-ffmpeg/verify.ts — SHA256 a file, throw on mismatch.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

export async function verifySha256(filePath: string, expectedHex: string): Promise<true> {
  const hash = createHash('sha256');
  const stream = createReadStream(filePath);
  await new Promise<void>((resolve, reject) => {
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => {
      resolve();
    });
    stream.on('error', reject);
  });
  const actual = hash.digest('hex');
  if (actual !== expectedHex.toLowerCase()) {
    throw new Error(
      `SHA256 checksum mismatch for ${filePath}: expected ${expectedHex.toLowerCase()}, got ${actual}`
    );
  }
  return true;
}
