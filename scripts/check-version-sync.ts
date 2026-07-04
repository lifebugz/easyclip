#!/usr/bin/env bun
// scripts/check-version-sync.ts - guards that all three version manifests carry the
// SAME version string. A silent desync makes the git tag and the built artifact
// disagree (risk M3). release-please keeps them in sync via typed extra-files; this
// catches a hand-edit that missed one. Runs in `bun run check` and is asserted again
// in release.yml against the release tag.
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');

export interface ManifestVersions {
  packageJson: string;
  tauriConf: string;
  cargoToml: string;
}

export async function readManifestVersions(root = ROOT): Promise<ManifestVersions> {
  const pkg = (await Bun.file(join(root, 'package.json')).json()) as { version: string };
  const tauri = (await Bun.file(join(root, 'src-tauri', 'tauri.conf.json')).json()) as {
    version: string;
  };
  // Bun parses TOML natively (docs: runtime/toml). The generic default-TOML `version`
  // is top-level; ours lives under [package], so read cargo.package.version explicitly.
  const cargo = Bun.TOML.parse(
    await Bun.file(join(root, 'src-tauri', 'Cargo.toml')).text(),
  ) as { package: { version: string } };
  return { packageJson: pkg.version, tauriConf: tauri.version, cargoToml: cargo.package.version };
}

// Empty result === in sync. Otherwise every manifest is listed with its value so the
// odd one out is obvious regardless of which one drifted.
export function findVersionMismatches(v: ManifestVersions): string[] {
  const distinct = new Set(Object.values(v));
  if (distinct.size <= 1) return [];
  return Object.entries(v).map(([name, value]) => `${name} = "${value}"`);
}

async function main(): Promise<void> {
  const versions = await readManifestVersions();
  const errors = findVersionMismatches(versions);
  if (errors.length > 0) {
    console.error('✗ version manifests are out of sync:');
    for (const e of errors) console.error(`  ${e}`);
    console.error('  All three must match. release-please syncs them via extra-files;');
    console.error('  a manual edit likely missed one.');
    process.exit(1);
  }
  console.log(`✓ version manifests in sync: ${versions.packageJson}`);
}

if (import.meta.main) {
  await main();
}
