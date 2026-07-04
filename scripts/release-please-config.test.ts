import { expect, test } from 'bun:test';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');

test('release-please-config wires all three manifests as typed extra-files', async () => {
  const config = (await Bun.file(join(ROOT, 'release-please-config.json')).json()) as {
    packages: Record<
      string,
      {
        'release-type': string;
        'bump-minor-pre-major': boolean;
        draft: boolean;
        'extra-files': Array<{ type: string; path: string; jsonpath: string }>;
      }
    >;
  };
  const pkg = config.packages['.'];
  expect(pkg['release-type']).toBe('simple');
  // Without this, a feat!/BREAKING commit at 0.x jumps straight to 1.0.0.
  expect(pkg['bump-minor-pre-major']).toBe(true);
  expect(pkg.draft).toBe(true);

  const byPath = Object.fromEntries(pkg['extra-files'].map((e) => [e.path, e]));
  expect(byPath['package.json']).toMatchObject({ type: 'json', jsonpath: '$.version' });
  expect(byPath['src-tauri/tauri.conf.json']).toMatchObject({
    type: 'json',
    jsonpath: '$.version'
  });
  // jsonpath is MANDATORY for Cargo.toml: default TOML only bumps a top-level version,
  // not [package].version.
  expect(byPath['src-tauri/Cargo.toml']).toMatchObject({
    type: 'toml',
    jsonpath: '$.package.version'
  });
});

test('manifest seeds the current released version and matches package.json', async () => {
  const manifest = (await Bun.file(join(ROOT, '.release-please-manifest.json')).json()) as Record<
    string,
    string
  >;
  const pkg = (await Bun.file(join(ROOT, 'package.json')).json()) as { version: string };
  expect(manifest['.']).toBe(pkg.version);
});
