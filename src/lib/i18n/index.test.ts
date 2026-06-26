import { test, expect } from 'bun:test';
import enDict from './en.json';
import heDict from './he.json';
import { getLang, setLang, t } from './index.svelte';

test('en.json and he.json have identical key sets (HE symmetric mirror)', () => {
  const enKeys = Object.keys(enDict).sort();
  const heKeys = Object.keys(heDict).sort();
  expect(heKeys).toEqual(enKeys);
});

test('t() returns the EN value when lang is en', () => {
  setLang('en');
  expect(t('app.name')).toBe('EasyClip');
  expect(t('language.toggle')).toBe('Language');
});

test('t() returns the HE value when lang is he', () => {
  setLang('he');
  expect(t('app.name')).toBe('EasyClip');
  expect(t('language.toggle')).toBe('שפה');
});

test('setLang switches getLang reading', () => {
  setLang('en');
  expect(getLang()).toBe('en');
  setLang('he');
  expect(getLang()).toBe('he');
});

test('t() falls back to the key name if (somehow) missing — defensive only', () => {
  // The HE-coverage test above guarantees no real key is missing,
  // but t() must not crash if drift is introduced. Cast through unknown
  // because TranslationKey is otherwise a closed literal union.
  setLang('en');
  expect(t('not.a.real.key' as unknown as keyof typeof enDict)).toBe('not.a.real.key');
});
