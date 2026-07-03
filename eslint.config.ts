import { defineConfig } from 'eslint/config';
import js from '@eslint/js';
import ts from 'typescript-eslint';
import svelte from 'eslint-plugin-svelte';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default defineConfig(
  js.configs.recommended,
  ...ts.configs.strictTypeChecked,
  ...ts.configs.stylisticTypeChecked,
  ...svelte.configs['flat/recommended'],
  prettier,
  ...svelte.configs['flat/prettier'],
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node
      },
      parserOptions: {
        projectService: true,
        extraFileExtensions: ['.svelte']
      }
    }
  },
  {
    files: ['**/*.svelte', '**/*.svelte.ts'],
    languageOptions: {
      parserOptions: {
        parser: ts.parser,
        svelteFeatures: { experimentalGenerics: true }
      }
    }
  },
  {
    // eslint-plugin-svelte v3's recommended config turns on `no-useless-mustaches`. Keep it ON -
    // it's the only gate that catches a hardcoded translatable string wrapped in a mustache
    // (e.g. `{'Save'}`), which scan-hardcoded-strings.ts skips (it ignores text starting with `{`).
    // But allow deliberate non-translatable literals - bare punctuation/symbols like `.`/`!`/`−`/` `
    // that stay wrapped so they don't read as hardcoded text - to opt out by including a
    // `/* i18n-exempt */` comment in the mustache (see src/lib/components/steps/*).
    rules: {
      'svelte/no-useless-mustaches': ['error', { ignoreIncludesComment: true }]
    }
  },
  {
    ignores: [
      'build/**',
      '.svelte-kit/**',
      'dist/**',
      'src-tauri/target/**',
      'src-tauri/binaries/**',
      'node_modules/**',
      '**/*.config.js',
      'src-tauri/gen/**',
      'docs/**',
      // Phase 1 L2 spike — wdio test runner config & spec;
      // not part of the daily check pipeline, requires tauri-driver running.
      'wdio.conf.ts',
      'tests/wd-macos-spike.spec.ts'
    ]
  }
);
