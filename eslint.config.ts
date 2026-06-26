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
