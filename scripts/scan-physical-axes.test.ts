import { test, expect } from 'bun:test';
import { findPhysicalAxisViolations } from './scan-physical-axes.ts';

test('reports zero violations on empty input', () => {
  expect(findPhysicalAxisViolations('')).toEqual([]);
});

test('flags ml-* class usage', () => {
  const input = '<div class="ml-4">x</div>';
  expect(findPhysicalAxisViolations(input)).toEqual([{ kind: 'class', match: 'ml-4' }]);
});

test('flags mr-, pl-, pr- class usage', () => {
  const input = '<div class="mr-2 pl-3 pr-1">x</div>';
  const violations = findPhysicalAxisViolations(input);
  expect(violations.map((v) => v.match).sort()).toEqual(['mr-2', 'pl-3', 'pr-1']);
});

test('flags raw left:/right: CSS in style blocks', () => {
  const input = `<style>div { left: 0; right: 4px; }</style>`;
  const violations = findPhysicalAxisViolations(input);
  expect(violations.map((v) => v.kind).sort()).toEqual(['css', 'css']);
});

test('does not flag inset-inline-start / -end', () => {
  const input = `<style>div { inset-inline-start: 0; }</style>`;
  expect(findPhysicalAxisViolations(input)).toEqual([]);
});

test('does not flag ms-/me-/ps-/pe- (logical Tailwind)', () => {
  expect(findPhysicalAxisViolations('<div class="ms-4 me-2 ps-3 pe-1">x</div>')).toEqual([]);
});
