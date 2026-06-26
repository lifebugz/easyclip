import { describe, expect, test } from 'bun:test';
import { appErrorToKey, isAppError, isTranslationKey } from './app-error';

describe('isTranslationKey', () => {
  test('accepts real keys and rejects unknown/typo keys', () => {
    expect(isTranslationKey('errors.unknown')).toBe(true);
    expect(isTranslationKey('errors.disk.full')).toBe(true);
    expect(isTranslationKey('errors.unkown')).toBe(false); // typo
    expect(isTranslationKey(null)).toBe(false);
  });
});

describe('isAppError', () => {
  test('shape-checks the IPC payload', () => {
    expect(isAppError({ kind: 'DiskFull', i18nKey: 'errors.disk.full', details: null })).toBe(true);
    expect(isAppError(new Error('x'))).toBe(false);
    expect(isAppError(null)).toBe(false);
  });
});

describe('appErrorToKey', () => {
  test('passes known keys through and falls back on unknown/null', () => {
    expect(appErrorToKey({ kind: 'DiskFull', i18nKey: 'errors.disk.full', details: null })).toBe(
      'errors.disk.full'
    );
    // A future/typo'd backend key must never render as a raw dotted string (N15):
    expect(appErrorToKey({ kind: 'Unknown', i18nKey: 'errors.not.a.key', details: null })).toBe(
      'errors.unknown'
    );
    expect(appErrorToKey({ kind: 'OperationCancelled', i18nKey: null, details: null })).toBe(
      'errors.unknown'
    );
  });
});
