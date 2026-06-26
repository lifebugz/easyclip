// Visual playback controller (amendment §6.2 + preview-playback §6). In
// `video`/`audio` mode the bound <video> element is the time source ("video as
// clock"): the RAF READS el.currentTime and only WRITES it on cut-boundary
// seeks. With no element bound (poster/art/tests) the controller degrades to
// the original wall-clock advancePlayhead RAF. wizardState.playhead/playing
// stay the single source of truth. The .svelte.ts extension is required for $effect.
import { wizardState } from '$lib/wizard/state.svelte';
import { advancePlayhead, syncFromMedia, resolvePlayStart } from '$lib/timeline/playback';

// Module-level element ref, set by VideoPreview's own $effect on mount and
// CLEARED on its teardown (§6) — so a stale element ref never outlives the
// component across an Edit-step re-entry. `null` ⇒ virtual-RAF behavior.
let previewEl: HTMLVideoElement | null = null;

// Boundary-seek latch: set when the controller writes el.currentTime to skip a
// cut, cleared on the element's `seeked` event. While set, the RAF neither
// re-writes currentTime nor re-maps mediaTime into the cut (prevents a seek
// storm + a boundary stall while the async seek settles — §6).
let pendingSeek = false;

export function bindPreviewMedia(el: HTMLVideoElement | null): void {
  previewEl = el;
  if (el === null) {
    pendingSeek = false;
    return;
  }
  // Seed a freshly-mounted element to the current (seeded/scrubbed) playhead so it
  // shows that frame immediately. The seek-on-scrub $effect reads `previewEl` (a
  // plain, non-reactive module ref) and only re-runs on playhead/playing changes,
  // so when the <video> mounts AFTER that effect last ran it would otherwise sit at
  // currentTime 0 until the next playhead write. Paused-only: while playing, play()
  // already seeks before the RAF takes over, so leave that path untouched.
  if (!wizardState.playing) el.currentTime = wizardState.playhead;
}

export function play(): void {
  // Land on a playable instant: skip out of any cut, and rewind to the trim
  // start when we're parked at — or an end-of-clip cut walks us to — the trim
  // end. The clamp/rewind order (and its cut edges) is unit-tested in
  // playback.ts::resolvePlayStart.
  wizardState.playhead = resolvePlayStart(
    wizardState.playhead,
    wizardState.trimRange.start,
    wizardState.trimRange.end,
    wizardState.cuts
  );

  const el = previewEl;
  if (el !== null) {
    el.currentTime = wizardState.playhead;
    // Autoplay policy is satisfied — this runs in the play-button gesture.
    void el.play().catch((err: unknown) => {
      // Two distinct rejection causes need opposite handling:
      //  • undecodable source (NotSupportedError) — the element ALSO fires its
      //    `error` event, which drives VideoPreview to poster mode and stops
      //    playback. Handling it here too would double-fire, so swallow it.
      //  • interrupted play (AbortError — a pause()/load() raced the play promise)
      //    fires NO `error` event, so `wizardState.playing` would stay true with a
      //    frozen clock (transport stuck on Pause until a manual pause). Reset it.
      //    AbortError never coincides with a MediaError, so this can't double-fire.
      if (err instanceof DOMException && err.name === 'AbortError') {
        wizardState.playing = false;
      }
    });
  }
  wizardState.playing = true;
}

export function pause(): void {
  wizardState.playing = false;
  previewEl?.pause();
}

export function togglePlay(): void {
  if (wizardState.playing) pause();
  else play();
}

export function reset(): void {
  wizardState.playing = false;
  wizardState.playhead = wizardState.trimRange.start;
  previewEl?.pause();
}

// Registers the playback RAF loop AND the native seek-on-scrub effect. MUST be
// called once during a component's init (uses $effect) — from TimelineEditStep.
export function installPlaybackEffect(): void {
  // ── Playback RAF ──
  $effect(() => {
    if (!wizardState.playing) return;
    const el = previewEl;

    if (el === null) {
      // Virtual RAF (poster/art/tests) — today's exact wall-clock behavior.
      let last = performance.now();
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
          wizardState.playing = false; // triggers cleanup → no reschedule
          return;
        }
        raf = requestAnimationFrame(tick);
      });
      return () => {
        cancelAnimationFrame(raf);
      };
    }

    // Video-as-clock: read el.currentTime, write only on boundary seeks.
    // Latch a still-in-flight play()-issued seek: play() writes el.currentTime to
    // wizardState.playhead (a post-resolvePlayStart instant that is OUT of every
    // cut) and only THEN sets playing=true, so this effect runs while that seek
    // may not have landed. If currentTime hasn't reached the target yet, mark the
    // seek pending so the first tick reads the stale (possibly in-cut) mediaTime
    // as "seek in flight" and holds the resolved playhead instead of re-issuing a
    // redundant boundary seek + nudging the playhead by SEEK_EPSILON. The `seeked`
    // event (or the watchdog) clears it once the element lands.
    pendingSeek = el.currentTime !== wizardState.playhead;
    const onSeeked = (): void => {
      pendingSeek = false;
    };
    el.addEventListener('seeked', onSeeked);

    let raf = requestAnimationFrame(function tick(): void {
      const r = syncFromMedia({
        mediaTime: el.currentTime,
        trimStart: wizardState.trimRange.start,
        trimEnd: wizardState.trimRange.end,
        cuts: wizardState.cuts,
        seekInFlight: pendingSeek
      });
      wizardState.playhead = r.playhead;
      if (r.seekTo !== null) {
        pendingSeek = true;
        el.currentTime = r.seekTo;
      } else if (pendingSeek && !r.inCut) {
        // The element has reached clear time, so the boundary seek effectively
        // landed even if its `seeked` event was coalesced/dropped (a WKWebView
        // hazard). Clear the latch here as a watchdog so a missed event can't
        // strand it true and silently disable the skip at the NEXT cut.
        pendingSeek = false;
      }
      if (!r.playing) {
        wizardState.playing = false; // triggers cleanup → pauses the element
        return;
      }
      raf = requestAnimationFrame(tick);
    });

    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener('seeked', onSeeked);
      el.pause(); // pause on stop / navigate / end-of-range (§6 invariant)
      pendingSeek = false; // reset latch so a paused scrub right after a boundary-stop isn't ignored
    };
  });

  // ── Native seek-on-scrub (video/audio only) ──
  // While paused, mirror the scrubbed playhead into the element. Guarded by
  // !playing so the RAF owns playhead writes during playback (no seek war), and
  // by !pendingSeek so it ignores the benign post-stop re-fire (§6). Poster-mode
  // scrub (debounced re-extract) lives in VideoPreview.
  $effect(() => {
    const ph = wizardState.playhead; // track
    if (wizardState.playing) return;
    const el = previewEl;
    if (el !== null && !pendingSeek) {
      el.currentTime = ph;
    }
  });
}
