// Shared AppError handling for IPC rejections. The i18nKey crosses the wire
// as an untyped string; isTranslationKey narrows it against the real EN
// dictionary so a typo'd/future backend key falls back to errors.unknown
// instead of rendering a raw dotted string (P10-008 contract).
import enDict from '../i18n/en.json';
import type { TranslationKey } from '../i18n/index.svelte';
import type { AppError } from '../types';

const KEY_SET: ReadonlySet<string> = new Set(Object.keys(enDict));

export function isTranslationKey(k: string | null | undefined): k is TranslationKey {
  return typeof k === 'string' && KEY_SET.has(k);
}

export function isAppError(e: unknown): e is AppError {
  if (typeof e !== 'object' || e === null || !('kind' in e)) return false;
  return typeof (e as Record<string, unknown>)['kind'] === 'string';
}

export function appErrorToKey(e: AppError): TranslationKey {
  return isTranslationKey(e.i18nKey) ? e.i18nKey : 'errors.unknown';
}
