// Singleton WizardState — the wizard's single source of truth.
//
// Shape pinned by 2026-05-07 amendment §3.6. Mutated via setters where the
// transition has navigation meaning (setStep), and directly via property
// writes where the slot is a plain editable value (saveName, saveDir, etc.).
// outputPath is derived (NOT stored) per amendment §3.6.
//
// The .svelte.ts extension is required by Svelte 5 for module-scope $state.

// Relative imports (not $lib aliases) — Bun's test runtime doesn't resolve
// the SvelteKit path alias defined in .svelte-kit/tsconfig.json (Bun ignores
// `extends` arrays per oven-sh/bun#4774). Relative paths work in both runtimes.
import type { MediaInfo } from '../types';
import type { TranslationKey } from '../i18n/index.svelte';
import { composeOutputPath } from '../util/path';

export type WizardStep = 'file-pick' | 'timeline-edit' | 'save' | 'processing' | 'done' | 'error';

// Locked at decisions/2026-05-01-unified-editor-no-modes.md:44-47 + amendment §3.1.
// The step name 'save' is permitted; mode-flavoured step names are rejected by
// scripts/scan-no-edit-modes.ts (see that file for the forbidden list).

export interface Cut {
  id: string;
  start: number;
  end: number;
}

export interface WizardStateShape {
  currentStep: WizardStep;
  mediaInfo: MediaInfo | null;
  saveName: string;
  saveDir: string;
  trimRange: { start: number; end: number };
  cuts: Cut[];
  playhead: number;
  playing: boolean;
  errorKey: TranslationKey | null;
  errorDetails: string | null;
}

function initialState(): WizardStateShape {
  return {
    currentStep: 'file-pick',
    mediaInfo: null,
    saveName: '',
    saveDir: '',
    trimRange: { start: 0, end: 0 },
    cuts: [],
    playhead: 0,
    playing: false,
    errorKey: null,
    errorDetails: null
  };
}

export const wizardState = $state<WizardStateShape>(initialState());

export function setStep(next: WizardStep): void {
  wizardState.currentStep = next;
}

export function resetAll(): void {
  const fresh = initialState();
  wizardState.currentStep = fresh.currentStep;
  wizardState.mediaInfo = fresh.mediaInfo;
  wizardState.saveName = fresh.saveName;
  wizardState.saveDir = fresh.saveDir;
  wizardState.trimRange = fresh.trimRange;
  wizardState.cuts = fresh.cuts;
  wizardState.playhead = fresh.playhead;
  wizardState.playing = fresh.playing;
  wizardState.errorKey = fresh.errorKey;
  wizardState.errorDetails = fresh.errorDetails;
}

// Alias for clarity at call sites — "Start Over" is the user-facing label.
export function resetForStartOver(): void {
  resetAll();
}

// outputPath derivation (amendment §3.6). Returns null when mediaInfo is null
// or when composition fails (empty inputs).
//
// Normalisation (trailing PATH_SEP from saveDir, trailing .ext from saveName)
// is delegated to composeOutputPath in src/lib/util/path.ts. Phase 6's SaveStep
// reads outputPath through `$derived(getOutputPath())`; Phase 9's process_media
// callsite will read it the same way. Single source of truth for the composition
// logic lives in path.ts.
export function getOutputPath(): string | null {
  const { mediaInfo, saveName, saveDir } = wizardState;
  if (mediaInfo === null) return null;
  return composeOutputPath(saveName, saveDir, mediaInfo.ext);
}
