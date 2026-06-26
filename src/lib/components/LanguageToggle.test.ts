import { test, expect } from 'bun:test';
import { getLang, setLang } from '../i18n/index.svelte';

// Note: actual DOM-render testing of .svelte components in Bun requires a Svelte test runner.
// We test the call surface here (setLang/getLang round-trip) and rely on Playwright (Task 13)
// for the rendered component's interaction.

test('LanguageToggle setLang round-trips through getLang', () => {
  setLang('en');
  expect(getLang()).toBe('en');
  setLang('he');
  expect(getLang()).toBe('he');
});
