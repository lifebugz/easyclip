import { Channel, invoke } from '@tauri-apps/api/core';
import type { KeptRange, PlanDurationResult, ProcessingEvent, ProcessingResult } from '$lib/types';

export interface ProcessMediaArgs {
  input: string;
  output: string;
  keptRanges: KeptRange[];
}

/**
 * Start processing. Progress streams through the Channel (ordered; spec
 * §5.1); the returned promise resolves with the verify-probed result or
 * rejects with the AppError-shaped payload (kind/i18nKey/details).
 */
export async function processMedia(
  args: ProcessMediaArgs,
  onEvent: (e: ProcessingEvent) => void
): Promise<ProcessingResult> {
  const channel = new Channel<ProcessingEvent>();
  channel.onmessage = onEvent;
  return invoke<ProcessingResult>('process_media', { ...args, onEvent: channel });
}

/**
 * Pure preview round-trip: ask the backend for the exact keyframe-snapped
 * planned duration (the engine's real build_plan, no ffmpeg/IO) so the editor's
 * FINAL readout matches the export's forward-snap policy. SelectionTooNarrow is
 * surfaced as `wouldBeTooNarrow`, never a reject.
 */
export async function planDuration(
  keptRanges: KeptRange[],
  keyframes: number[],
  duration: number
): Promise<PlanDurationResult> {
  return invoke<PlanDurationResult>('plan_duration', { keptRanges, keyframes, duration });
}

export async function cancelProcessing(): Promise<void> {
  return invoke('cancel_processing');
}

export async function revealOutput(path: string): Promise<void> {
  return invoke('reveal_output', { path });
}

export async function openOutput(path: string): Promise<void> {
  return invoke('open_output', { path });
}
