// scripts/setup-ffmpeg/fetch.ts — fetches a URL to a file path, throwing on non-2xx.
import { writeFile } from 'node:fs/promises';

export async function fetchToFile(url: string, destPath: string): Promise<void> {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`fetch failed: ${String(response.status)} ${response.statusText} for ${url}`);
  }
  const buf = await response.arrayBuffer();
  await writeFile(destPath, new Uint8Array(buf));
}
