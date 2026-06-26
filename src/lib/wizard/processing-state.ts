// Pure helpers under the processing controller (house split: Bun-testable
// logic here, runes wrapper in processing.svelte.ts).
import type { ProcessingEvent, ProcessingResult, ProcessingStage } from '../types';

export interface ProcessingUiState {
  stage: ProcessingStage;
  segmentIndex: number;
  segmentCount: number;
  fraction: number;
  etaSeconds: number | null;
  cancelRequested: boolean;
  result: ProcessingResult | null;
}

export function baselineProcessingState(): ProcessingUiState {
  return {
    stage: 'single',
    segmentIndex: 1,
    segmentCount: 1,
    fraction: 0,
    etaSeconds: null,
    cancelRequested: false,
    result: null
  };
}

export function applyProcessingEvent(s: ProcessingUiState, e: ProcessingEvent): void {
  s.stage = e.stage;
  s.segmentIndex = e.segmentIndex;
  s.segmentCount = e.segmentCount;
  s.fraction = Math.max(s.fraction, e.fraction); // ring never regresses
  s.etaSeconds = e.etaSeconds;
}
