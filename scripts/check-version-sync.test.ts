import { describe, expect, test } from 'bun:test';
import { findVersionMismatches, readManifestVersions } from './check-version-sync.ts';

describe('findVersionMismatches', () => {
  test('returns no errors when all three versions match', () => {
    expect(
      findVersionMismatches({ packageJson: '0.1.0', tauriConf: '0.1.0', cargoToml: '0.1.0' })
    ).toEqual([]);
  });

  test('flags a mismatch when one manifest drifts', () => {
    const errors = findVersionMismatches({
      packageJson: '0.2.0',
      tauriConf: '0.1.0',
      cargoToml: '0.1.0'
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toContain('0.2.0');
  });
});

describe('the live repo manifests', () => {
  test('are currently in sync', async () => {
    const versions = await readManifestVersions();
    expect(findVersionMismatches(versions)).toEqual([]);
  });
});
