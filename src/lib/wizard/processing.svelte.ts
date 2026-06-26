// Module-scope runes controller for the processing lifecycle (spec §5.3).
// startProcessing resets to baseline BEFORE the IPC call (S12 — the
// singleton otherwise carries a stale ring %, a stuck-disabled Cancel, and
// the prior result into retry) and RETURNS the promise — WizardShell owns
// navigation on settle (S11); this module never navigates.
import { cancelProcessing, processMedia, type ProcessMediaArgs } from '$lib/tauri/processing';
import type { ProcessingResult } from '$lib/types';
import {
  applyProcessingEvent,
  baselineProcessingState,
  type ProcessingUiState
} from './processing-state';

export const processingState = $state<ProcessingUiState>(baselineProcessingState());

export function resetProcessing(): void {
  Object.assign(processingState, baselineProcessingState());
}

export async function startProcessing(args: ProcessMediaArgs): Promise<ProcessingResult> {
  resetProcessing();
  const result = await processMedia(args, (e) => {
    applyProcessingEvent(processingState, e);
  });
  processingState.result = result;
  processingState.fraction = 1; // 100% only on terminal success (spec §5.2)
  return result;
}

export function requestCancel(): void {
  if (processingState.cancelRequested) return;
  processingState.cancelRequested = true;
  // The button never navigates (N1) — the OperationCancelled rejection of
  // the startProcessing promise drives the wizard transition.
  void cancelProcessing();
}
