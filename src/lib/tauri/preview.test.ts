import { test, expect } from 'bun:test';
import { assetUrl } from './preview';

test('assetUrl returns null for an empty path', () => {
  expect(assetUrl('')).toBeNull();
});

test('assetUrl returns null when __TAURI_INTERNALS__.convertFileSrc is absent (non-Tauri/dev)', () => {
  // Bun unit env has no Tauri runtime → the feature-detect short-circuits to
  // null, so VideoPreview routes to `art` mode (the no-regression safety net).
  expect(assetUrl('/Users/me/clip.mp4')).toBeNull();
});
