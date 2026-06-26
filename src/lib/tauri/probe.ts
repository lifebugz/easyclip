import { invoke } from '@tauri-apps/api/core';
import type { MediaInfo } from '$lib/types';

/**
 * Probe a media file via the Rust backend. Resolves with MediaInfo on success;
 * rejects with an AppError-shaped payload on failure (see src/lib/types.ts).
 *
 * The frontend's responsibility on rejection is to inspect `kind` and route
 * appropriately (OperationCancelled → transition; everything else → ErrorStep
 * with `t(i18nKey)` rendering).
 */
export async function probeMedia(path: string): Promise<MediaInfo> {
  return invoke<MediaInfo>('probe_media', { path });
}
