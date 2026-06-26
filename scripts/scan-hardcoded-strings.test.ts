import { test, expect } from 'bun:test';
import { findHardcodedStrings } from './scan-hardcoded-strings.ts';

test('reports zero violations on empty input', () => {
  expect(findHardcodedStrings('')).toEqual([]);
});

test('reports zero violations on a $t-driven component', () => {
  const input = `
    <script lang="ts">
      import { t } from '$lib/i18n';
    </script>
    <h1>{$t('wizard.title')}</h1>
  `;
  expect(findHardcodedStrings(input)).toEqual([]);
});

test('flags a literal string in element text', () => {
  const input = `<h1>Pick a file</h1>`;
  expect(findHardcodedStrings(input)).toContainEqual({ literal: 'Pick a file' });
});

test('does not flag literals inside <script> blocks', () => {
  const input = `<script>const FOO = 'literal';</script>`;
  expect(findHardcodedStrings(input)).toEqual([]);
});
