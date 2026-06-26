import { test, expect } from 'bun:test';
import { findEditModeViolations } from './scan-no-edit-modes.ts';

test('reports zero violations on empty input', () => {
  expect(findEditModeViolations('')).toEqual([]);
});

test('flags editMode identifier', () => {
  const input = `let editMode = $state('trim');`;
  expect(findEditModeViolations(input)).toEqual([{ kind: 'identifier', match: 'editMode' }]);
});

test('flags editMode, trimMode, cutMode, editingMode, trimmingMode, cuttingMode identifiers', () => {
  const input = `
    let editMode = false;
    let trimMode = false;
    const cutMode: boolean = true;
    function setEditingMode() {}
    type TrimmingMode = 'on' | 'off';
    interface CuttingMode {}
  `;
  const matches = findEditModeViolations(input)
    .map((v) => v.match)
    .sort();
  expect(matches).toEqual([
    'cutMode',
    'cuttingMode',
    'editMode',
    'editingMode',
    'trimMode',
    'trimmingMode'
  ]);
});

test('flags two-step wizard step-name literals', () => {
  const input = `
    type WizardStep = 'file-pick' | 'trim-sides' | 'remove-sections' | 'done';
    if (step === 'cut-middle') {}
    if (step === 'edit-trim') {}
    if (step === 'edit-cuts') {}
    if (step === 'trim-step') {}
    if (step === 'cut-step') {}
  `;
  const violations = findEditModeViolations(input);
  const kinds = violations.map((v) => v.kind).sort();
  const matches = violations.map((v) => v.match).sort();
  expect(kinds.every((k) => k === 'step-name')).toBe(true);
  expect(matches).toEqual([
    "'cut-middle'",
    "'cut-step'",
    "'edit-cuts'",
    "'edit-trim'",
    "'remove-sections'",
    "'trim-sides'",
    "'trim-step'"
  ]);
});

test('does not flag legitimate uses of the word "mode" in unrelated identifiers', () => {
  const input = `
    let darkMode = false;
    const importMode = 'esm';
    if (import.meta.main) {}
    // mode of operation comment
  `;
  expect(findEditModeViolations(input)).toEqual([]);
});

test('does not flag identifiers that contain the forbidden tokens as substrings', () => {
  const input = `
    let xeditMode = false;
    const editModeMore = true;
    let superEditModeFlag = 'on';
    function preTrimModeCheck() {}
  `;
  expect(findEditModeViolations(input)).toEqual([]);
});

test('does not flag the locked WizardStep set', () => {
  const input = `type WizardStep = 'file-pick' | 'timeline-edit' | 'processing' | 'done' | 'error';`;
  expect(findEditModeViolations(input)).toEqual([]);
});

test('does not flag the word "mode" in a comment or string body', () => {
  const input = `
    // We chose this approach in mode-choice ADR.
    const note = 'discoverability mode is implicit';
  `;
  expect(findEditModeViolations(input)).toEqual([]);
});
