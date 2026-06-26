// Visual playback controller (amendment §6.2). wizardState.playhead/playing are
// the single source of truth (§3.6); this module mutates them and owns the RAF
// loop. The .svelte.ts extension is required for the $effect rune.
//
// The loop is $effect-driven on `playing`: ANY write that sets playing = false
// (pause button, the end-of-range stop condition, resetAll, a navigation reset)
// tears the loop down through the effect's cleanup. There is no imperative
// start/stop to keep in sync.
import { wizardState } from '$lib/wizard/state.svelte';
import { advancePlayhead } from '$lib/timeline/playback';

export function play(): void {
  // Replay-from-end: if parked at (or past) the trim end, rewind to the start so
  // the play button always produces motion (§6.2 "cycles through the trim range").
  if (wizardState.playhead >= wizardState.trimRange.end) {
    wizardState.playhead = wizardState.trimRange.start;
  }
  wizardState.playing = true;
}

export function pause(): void {
  wizardState.playing = false;
}

export function togglePlay(): void {
  if (wizardState.playing) pause();
  else play();
}

export function reset(): void {
  wizardState.playing = false;
  wizardState.playhead = wizardState.trimRange.start;
}

// Registers the RAF loop. MUST be called during a component's initialisation
// (it uses $effect) — call it once from TimelineEditStep's <script>. The effect
// re-runs only when `playing` toggles; the RAF self-schedules while playing and
// reads playhead/trim/cuts fresh each frame, so cut/trim edits during playback
// take effect on the next frame without restarting the loop.
export function installPlaybackEffect(): void {
  $effect(() => {
    if (!wizardState.playing) return;
    let last = performance.now(); // monotonic; immune to clock adjustments
    let raf = requestAnimationFrame(function tick(now: number): void {
      const rawDt = (now - last) / 1000;
      last = now;
      const r = advancePlayhead({
        playhead: wizardState.playhead,
        rawDt,
        trimStart: wizardState.trimRange.start,
        trimEnd: wizardState.trimRange.end,
        cuts: wizardState.cuts
      });
      wizardState.playhead = r.playhead;
      if (!r.playing) {
        wizardState.playing = false; // triggers effect cleanup → no reschedule
        return;
      }
      raf = requestAnimationFrame(tick);
    });
    return () => {
      cancelAnimationFrame(raf);
    };
  });
}
