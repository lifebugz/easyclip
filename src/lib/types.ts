// Frontend mirror of the Rust serde shapes from src-tauri/src/ffmpeg/mod.rs
// and src-tauri/src/error.rs. Keep these in lockstep — when adding a Rust
// field, add the TS field in the same PR.

export interface MediaInfo {
  path: string;
  duration: number; // seconds
  container: string;
  codec: string;
  ext: string; // canonical extension, lowercased, no leading dot
  hasAudio: boolean;
  keyframes: number[]; // ascending seconds; empty when over MAX_KF (snap disabled)
}

export type AppErrorKind =
  | 'InputPathInvalid'
  | 'OutputPathInvalid'
  | 'MediaUnsupported'
  | 'MediaCorrupted'
  | 'ProcessingFailed'
  | 'SidecarUnusable'
  | 'OperationCancelled'
  | 'DiskFull'
  | 'SelectionTooNarrow'
  | 'OutputSameAsInput'
  | 'Unknown';

export interface AppError {
  kind: AppErrorKind;
  i18nKey: string | null; // null only for OperationCancelled
  details: string | null;
}

export interface KeptRange {
  start: number;
  end: number;
}

export interface PlanDurationResult {
  plannedDuration: number;
  wouldBeTooNarrow: boolean;
}

export type ProcessingStage = 'single' | 'segment' | 'concat' | 'finalizing';

export interface ProcessingEvent {
  stage: ProcessingStage;
  segmentIndex: number;
  segmentCount: number;
  fraction: number;
  etaSeconds: number | null;
}

export interface ProcessingResult {
  outputPath: string;
  finalDuration: number;
  removedDuration: number;
  segmentCount: number;
}
