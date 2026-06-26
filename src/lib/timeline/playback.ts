// Pure per-frame playhead math + navigation-reset decision (amendment §6.2).
// No DOM, no RAF, no runes — the controller in playback.svelte.ts wraps these.
import type { WizardStep } from '../wizard/state.svelte';

/** Move `t` forward out of any cut it lands in, to a fixpoint. Half-open
 *  [start, end): `t === cut.start` is inside (skip); `t === cut.end` is outside.
 *  `epsilon` is added past each crossed boundary (the video-clock seek uses
 *  SEEK_EPSILON to clear the keyframe at cut.end; the wall-clock paths pass 0).
 *
 *  We loop to a fixpoint rather than assume one forward pass suffices: committed
 *  cuts are normally sorted ascending (commitCut/commitMerge sort), but a
 *  cut-handle resize via proposeCutEdit does NOT re-sort, so the array can be out
 *  of order and a single pass could leave `t` inside an earlier-iterated cut.
 *  Re-passing is order-independent and overlap-safe; `t` only ever increases
 *  (each crossing jumps to a strictly larger end), so this terminates.
 *
 *  Returns the resolved time and whether any cut was crossed (callers use the
 *  flag to distinguish "played through clear time" from "skipped a boundary"). */
export function skipForwardOutOfCuts(
  t: number,
  cuts: { start: number; end: number }[],
  epsilon = 0
): { t: number; skipped: boolean } {
  let next = t;
  let skippedAny = false;
  let moved = true;
  while (moved) {
    moved = false;
    for (const c of cuts) {
      if (next >= c.start && next < c.end) {
        next = c.end + epsilon;
        skippedAny = true;
        moved = true;
      }
    }
  }
  return { t: next, skipped: skippedAny };
}

/** Resolve where play() should (re)start the playhead. Two steps:
 *   1. skip forward out of any cut the playhead currently sits in;
 *   2. if that lands at/after trimEnd — either parked at the end, OR walked
 *      there by a cut whose `end === trimEnd` — rewind to trimStart and skip
 *      forward again past any leading cut.
 *
 *  Step 2 is why the clamp must precede the replay-rewind check: the previous
 *  order (rewind only when playhead >= trimEnd, THEN clamp) left a playhead
 *  paused strictly inside an end-of-clip cut clamped exactly onto trimEnd, so
 *  the first RAF tick stopped instantly — a dead play press. Re-skipping after
 *  the rewind keeps the start out of a leading cut. Epsilon 0: play() snaps
 *  exactly to cut.end (the video-clock seek adds its own SEEK_EPSILON). Pure;
 *  the caller writes the result to wizardState.playhead. */
export function resolvePlayStart(
  playhead: number,
  trimStart: number,
  trimEnd: number,
  cuts: { start: number; end: number }[]
): number {
  let next = skipForwardOutOfCuts(playhead, cuts).t;
  if (next >= trimEnd) next = skipForwardOutOfCuts(trimStart, cuts).t;
  return next;
}

/** One RAF tick. `cuts` must be the COMMITTED cuts, never the in-flight
 *  pendingCut — skipping a moving pending range would fight the drag (amendment
 *  §6.2 / §10.4). Cut order is not assumed (see skipForwardOutOfCuts). Returns
 *  the next playhead and whether playback continues. */
export function advancePlayhead(input: {
  playhead: number;
  rawDt: number; // seconds since the last frame, before clamping
  trimStart: number;
  trimEnd: number;
  cuts: { start: number; end: number }[];
}): { playhead: number; playing: boolean } {
  // 100 ms clamp: when the tab/window is hidden RAF pauses, and the first frame
  // back reports a multi-second rawDt that would lurch the playhead forward.
  const dt = Math.min(input.rawDt, 0.1);
  const next = skipForwardOutOfCuts(input.playhead + dt, input.cuts).t;

  if (next >= input.trimEnd) return { playhead: input.trimEnd, playing: false };
  if (next < input.trimStart) return { playhead: input.trimStart, playing: true };
  return { playhead: next, playing: true };
}

export type PlaybackMove = 'reset' | 'pause' | 'none';

/** Maps a wizard navigation (from → to) to a playback side effect, per the
 *  amendment §6.2 reset table. 'reset' → playhead = trimStart, playing = false;
 *  'pause' → playing = false (playhead kept); 'none' → leave as-is. Start Over
 *  is handled by resetAll (zeroes both) and never routes here.
 *
 *  Leaving timeline-edit (the only step with playback) always pauses — both the
 *  Continue→save and Back→file-pick exits — so `playing` is never left stale on a
 *  step that has no RAF loop running. (Re-entry from file-pick/processing resets.) */
export function playbackTransition(from: WizardStep, to: WizardStep): PlaybackMove {
  if (to === 'timeline-edit' && (from === 'file-pick' || from === 'processing')) return 'reset';
  if (from === 'timeline-edit') return 'pause';
  return 'none';
}

export type PreviewMode = 'video' | 'poster' | 'audio' | 'art';

export interface PreviewModeInput {
  hasSource: boolean; // assetUrl(path) !== null
  hasVideo: boolean; // mediaInfo.hasRealVideo (NOT codec !== '' — codec can be '' for a real video)
  decoded: boolean; // <video> fired loadedmetadata with a real frame (videoWidth>0), no prior error
  audioDecoded: boolean; // element fired loadedmetadata with videoWidth===0, no prior error
  errored: boolean; // MediaError fired, OR the classification timeout elapsed
}

/** Resolve the preview mode from the static codec signal plus the element's
 *  runtime decode outcome (§3). `errored` is checked first so a LATE error after
 *  a `video` classification reroutes to `poster`. The pending (no-event) case
 *  stays optimistic (video/audio) so the <video> stays mounted and can load;
 *  the art backdrop shows behind it until a frame decodes. */
export function derivePreviewMode(i: PreviewModeInput): PreviewMode {
  if (!i.hasSource) return 'art';
  if (i.errored) return i.hasVideo ? 'poster' : 'art';
  if (i.decoded) return 'video';
  if (i.audioDecoded) return 'audio';
  return i.hasVideo ? 'video' : 'audio';
}

/** Small fixed nudge past a cut boundary so a boundary seek clears the keyframe
 *  that sits at/just before cut.end (§6 keyframe-snap guard). */
export const SEEK_EPSILON = 0.05;

export interface SyncInput {
  mediaTime: number;
  trimStart: number;
  trimEnd: number;
  cuts: { start: number; end: number }[];
  seekInFlight: boolean;
}
export interface SyncResult {
  playhead: number;
  seekTo: number | null;
  playing: boolean;
  /** True iff the observed mediaTime currently sits inside a cut (a boundary seek
   *  is wanted/in flight). The controller uses this to clear a stuck pendingSeek
   *  latch once it observes clear time, in case the element's `seeked` event was
   *  coalesced/dropped (a documented WKWebView event-delivery hazard). */
  inCut: boolean;
}

/** Read the media clock and decide the next playhead + any boundary seek (§6).
 *  Pure: the controller owns el.currentTime and the pendingSeek latch, and only
 *  passes the observed mediaTime + whether a seek is already in flight. The
 *  cut-skip uses the same order-independent fixpoint loop as advancePlayhead. */
export function syncFromMedia(i: SyncInput): SyncResult {
  // Defensive: an HTMLMediaElement can momentarily report a non-finite
  // currentTime (NaN before metadata is ready, or a failed/not-yet-loaded src).
  // NaN is invisible to every comparison below (`NaN >= x` is always false, and
  // skipForwardOutOfCuts never matches it), so an unguarded NaN would flow
  // straight into wizardState.playhead and poison the timecode readout, the
  // Playhead marker, the Final-duration math, and the poster seek time — and,
  // since `NaN >= trimEnd` is false, the loop could never self-terminate. Treat a
  // non-finite clock as trimStart (the safe lower bound the Math.max clamp below
  // already enforces for finite values).
  const mediaTime = Number.isFinite(i.mediaTime) ? i.mediaTime : i.trimStart;

  if (mediaTime >= i.trimEnd)
    return { playhead: i.trimEnd, seekTo: null, playing: false, inCut: false };

  const skip = skipForwardOutOfCuts(Math.max(mediaTime, i.trimStart), i.cuts, SEEK_EPSILON);
  const target = skip.t;
  const inCut = skip.skipped;

  if (target >= i.trimEnd) return { playhead: i.trimEnd, seekTo: null, playing: false, inCut };
  if (!inCut) return { playhead: target, seekTo: null, playing: true, inCut: false };
  // Inside a cut: hold the playhead at the skip target; only issue the seek when
  // one isn't already in flight (§6 async-seek latch — prevents a seek storm).
  return { playhead: target, seekTo: i.seekInFlight ? null : target, playing: true, inCut: true };
}

/** Self-pacing poster cadence: ms to wait before the next extract so refresh is
 *  capped at minSpacingMs (§6). Pure for unit testing; the controller supplies
 *  the clock. */
export function posterDelayMs(nowMs: number, lastStartMs: number, minSpacingMs: number): number {
  return Math.max(0, minSpacingMs - (nowMs - lastStartMs));
}
