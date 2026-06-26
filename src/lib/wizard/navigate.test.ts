import { test, expect } from 'bun:test';
import { nextStep, requiresConfirm, type WizardAction } from './navigate';
import type { WizardStep } from './state.svelte';

// Table mirrors amendment §4.1. Each row: [current, action, expectedNext, expectedConfirm]
type Row = [WizardStep, WizardAction, WizardStep | null, boolean];

const TABLE: Row[] = [
  // Forward transitions
  ['file-pick', 'continue', 'timeline-edit', false],
  ['timeline-edit', 'continue', 'save', false],
  ['save', 'startProcessing', 'processing', false],
  ['processing', 'success', 'done', false],
  ['processing', 'failure', 'error', false],

  // Back transitions (never gate per §4.1)
  ['timeline-edit', 'back', 'file-pick', false],
  ['save', 'back', 'timeline-edit', false],
  ['error', 'back', 'save', false],

  // Start Over from non-terminal — gates
  ['timeline-edit', 'startOver', 'file-pick', true],
  ['save', 'startOver', 'file-pick', true],

  // Start Over from terminal — never gates
  ['done', 'startOver', 'file-pick', false],
  ['error', 'startOver', 'file-pick', false],

  // Retry (never gates; goes processing — NOT 'save' despite the bundle's dead goNext)
  ['error', 'retry', 'processing', false],

  // Cancel during processing (never gates per PROC-05)
  ['processing', 'cancel', 'timeline-edit', false]
];

test.each(TABLE)(
  'from %s with action %s → next=%s, confirm=%s',
  (current, action, expectedNext, expectedConfirm) => {
    expect(nextStep(current, action)).toBe(expectedNext);
    expect(requiresConfirm(current, action)).toBe(expectedConfirm);
  }
);

test('illegal transitions return null from nextStep (no-op signal for WizardShell)', () => {
  expect(nextStep('file-pick', 'back')).toBeNull(); // no Back from file-pick
  expect(nextStep('file-pick', 'startOver')).toBeNull(); // no Start Over before any state exists
  expect(nextStep('done', 'back')).toBeNull(); // terminal, no Back
  expect(nextStep('processing', 'startOver')).toBeNull(); // can't Start Over mid-processing
  expect(nextStep('timeline-edit', 'retry')).toBeNull(); // Retry is error-only
});

test('illegal transitions return false from requiresConfirm (irrelevant by definition)', () => {
  expect(requiresConfirm('file-pick', 'back')).toBe(false);
  expect(requiresConfirm('done', 'back')).toBe(false);
  expect(requiresConfirm('processing', 'startOver')).toBe(false);
});
