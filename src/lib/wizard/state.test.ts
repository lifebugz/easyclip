import { test, expect, beforeEach } from 'bun:test';
import { wizardState, resetAll, resetForStartOver, setStep, getOutputPath } from './state.svelte';

beforeEach(() => {
  resetAll();
});

test('initial state: currentStep is file-pick, everything else empty/null', () => {
  expect(wizardState.currentStep).toBe('file-pick');
  expect(wizardState.mediaInfo).toBeNull();
  expect(wizardState.saveName).toBe('');
  expect(wizardState.saveDir).toBe('');
  expect(wizardState.trimRange).toEqual({ start: 0, end: 0 });
  expect(wizardState.cuts).toEqual([]);
  expect(wizardState.playhead).toBe(0);
  expect(wizardState.playing).toBe(false);
  expect(wizardState.errorKey).toBeNull();
  expect(wizardState.errorDetails).toBeNull();
});

test('setStep mutates currentStep', () => {
  setStep('timeline-edit');
  expect(wizardState.currentStep).toBe('timeline-edit');
  setStep('save');
  expect(wizardState.currentStep).toBe('save');
});

test('resetAll clears everything back to initial', () => {
  setStep('save');
  wizardState.saveName = 'custom-name';
  wizardState.saveDir = '/Users/me/Movies';
  wizardState.cuts = [{ id: 'c1', start: 1, end: 2 }];
  wizardState.playhead = 5;
  wizardState.playing = true;
  wizardState.errorKey = 'errors.unknown';
  wizardState.errorDetails = 'some detail';

  resetAll();

  expect(wizardState.currentStep).toBe('file-pick');
  expect(wizardState.saveName).toBe('');
  expect(wizardState.saveDir).toBe('');
  expect(wizardState.cuts).toEqual([]);
  expect(wizardState.playhead).toBe(0);
  expect(wizardState.playing).toBe(false);
  expect(wizardState.errorKey).toBeNull();
  expect(wizardState.errorDetails).toBeNull();
});

test('resetForStartOver behaves the same as resetAll (alias for clarity)', () => {
  setStep('done');
  wizardState.saveName = 'x';
  resetForStartOver();
  expect(wizardState.currentStep).toBe('file-pick');
  expect(wizardState.saveName).toBe('');
});

test('getOutputPath returns null when mediaInfo is null', () => {
  expect(getOutputPath()).toBeNull();
});

test('getOutputPath returns null when saveName is empty', () => {
  wizardState.mediaInfo = {
    path: '/Users/me/Movies/x.mp4',
    duration: 10,
    container: 'mov,mp4',
    codec: 'h264',
    ext: 'mp4',
    hasAudio: true,
    keyframes: []
  };
  wizardState.saveDir = '/Users/me/Movies';
  // saveName intentionally left empty
  expect(getOutputPath()).toBeNull();
});

test('getOutputPath returns null when saveDir is empty', () => {
  wizardState.mediaInfo = {
    path: '/Users/me/Movies/x.mp4',
    duration: 10,
    container: 'mov,mp4',
    codec: 'h264',
    ext: 'mp4',
    hasAudio: true,
    keyframes: []
  };
  wizardState.saveName = 'x-trimmed';
  // saveDir intentionally left empty
  expect(getOutputPath()).toBeNull();
});

test('getOutputPath composes saveDir + sep + saveName + . + ext when everything is present', () => {
  wizardState.mediaInfo = {
    path: '/Users/me/Movies/x.mp4',
    duration: 10,
    container: 'mov,mp4',
    codec: 'h264',
    ext: 'mp4',
    hasAudio: true,
    keyframes: []
  };
  wizardState.saveName = 'x-trimmed';
  wizardState.saveDir = '/Users/me/Movies';
  // In Bun tests pathSep() returns '/' (its fallback) — see src/lib/util/path.ts.
  expect(getOutputPath()).toBe('/Users/me/Movies/x-trimmed.mp4');
});

test('getOutputPath normalises trailing PATH_SEP from saveDir', () => {
  setStep('save');
  wizardState.mediaInfo = {
    path: '/Users/me/Movies/x.mp4',
    duration: 10,
    container: 'mov,mp4',
    codec: 'h264',
    ext: 'mp4',
    hasAudio: true,
    keyframes: []
  };
  wizardState.saveName = 'x-trimmed';
  wizardState.saveDir = '/Users/me/Movies/'; // trailing sep
  expect(getOutputPath()).toBe('/Users/me/Movies/x-trimmed.mp4');
});

test('getOutputPath normalises trailing .ext from saveName (case-insensitive)', () => {
  setStep('save');
  wizardState.mediaInfo = {
    path: '/Users/me/Movies/x.mp4',
    duration: 10,
    container: 'mov,mp4',
    codec: 'h264',
    ext: 'mp4',
    hasAudio: true,
    keyframes: []
  };
  wizardState.saveDir = '/Users/me/Movies';
  wizardState.saveName = 'x-trimmed.MP4'; // user typed the ext with mixed case
  expect(getOutputPath()).toBe('/Users/me/Movies/x-trimmed.mp4');
});
