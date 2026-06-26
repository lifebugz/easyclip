import { test, expect } from 'bun:test';
import { fetchToFile } from './fetch.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';

test('fetchToFile writes the response body to disk', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'easyclip-fetch-test-'));
  const dest = join(dir, 'fixture.txt');

  const server = Bun.serve({
    port: 0,
    fetch: () => new Response('hello, ffmpeg', { status: 200 })
  });
  const url = `http://localhost:${String(server.port)}/`;
  try {
    await fetchToFile(url, dest);
    expect(existsSync(dest)).toBe(true);
    expect(readFileSync(dest, 'utf8')).toBe('hello, ffmpeg');
  } finally {
    await server.stop(true);
  }
});

test('fetchToFile rejects on non-2xx status', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'easyclip-fetch-test-'));
  const dest = join(dir, 'should-not-exist');
  const server = Bun.serve({
    port: 0,
    fetch: () => new Response('not found', { status: 404 })
  });
  try {
    let caughtError: unknown;
    try {
      await fetchToFile(`http://localhost:${String(server.port)}/`, dest);
    } catch (err) {
      caughtError = err;
    }
    expect(caughtError).toBeInstanceOf(Error);
    expect((caughtError as Error).message).toMatch(/404/);
    expect(existsSync(dest)).toBe(false);
  } finally {
    await server.stop(true);
  }
});
