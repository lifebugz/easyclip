// Pure navigation rules per 2026-05-07 amendment §4.1.
//
// Two functions: nextStep returns the destination (or null for illegal),
// requiresConfirm returns true only for the two destructive Start Over
// transitions from non-terminal steps. Every other transition (Back, Retry,
// Cancel, terminal Start Over, forward navigation) flows without a confirm
// gate.
//
// Bundle quirk noted: app.jsx:95 maps err → save via goNext, but the footer
// is hidden on err and ErrStep's onRetry wires directly to setStep('proc').
// The amendment §4.1 names this as unreachable code — we implement
// error/retry → processing as canonical and do NOT implement error/goNext → save.

import type { WizardStep } from './state.svelte';

export type WizardAction =
  | 'continue'
  | 'back'
  | 'startOver'
  | 'startProcessing'
  | 'cancel'
  | 'retry'
  | 'success'
  | 'failure';

export function nextStep(current: WizardStep, action: WizardAction): WizardStep | null {
  switch (current) {
    case 'file-pick':
      if (action === 'continue') return 'timeline-edit';
      return null;

    case 'timeline-edit':
      if (action === 'continue') return 'save';
      if (action === 'back') return 'file-pick';
      if (action === 'startOver') return 'file-pick';
      return null;

    case 'save':
      if (action === 'startProcessing') return 'processing';
      if (action === 'back') return 'timeline-edit';
      if (action === 'startOver') return 'file-pick';
      return null;

    case 'processing':
      if (action === 'success') return 'done';
      if (action === 'failure') return 'error';
      if (action === 'cancel') return 'timeline-edit';
      return null;

    case 'done':
      if (action === 'startOver') return 'file-pick';
      return null;

    case 'error':
      if (action === 'retry') return 'processing';
      if (action === 'back') return 'save';
      if (action === 'startOver') return 'file-pick';
      return null;
  }
}

export function requiresConfirm(current: WizardStep, action: WizardAction): boolean {
  // Only destructive Start Over from non-terminal steps gates. Everything
  // else — including terminal Start Overs from done/error — flows.
  if (action !== 'startOver') return false;
  return current === 'timeline-edit' || current === 'save';
}
