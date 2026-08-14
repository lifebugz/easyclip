<script lang="ts">
  // Layered preview box (§8). Decorative art stays aria-hidden; a real <video>
  // (video/audio mode) or <img> poster (poster mode) renders on top. The mode is
  // resolved from mediaInfo.hasRealVideo plus the element's runtime decode events.
  // art is the no-regression safety net (today's exact behavior).
  import { untrack } from 'svelte';
  import { t } from '$lib/i18n/index.svelte';
  import { wizardState } from '$lib/wizard/state.svelte';
  import { togglePlay, bindPreviewMedia } from '$lib/timeline/playback.svelte';
  import {
    containerNeedsEagerProxy,
    derivePreviewMode,
    derivePreviewNote,
    posterDelayMs
  } from '$lib/timeline/playback';
  import type { ProxyPhase } from '$lib/timeline/playback';
  import { assetUrl, posterFrame, buildPreviewProxy, cancelPreviewProxy } from '$lib/tauri/preview';
  import {
    POSTER_MIN_SPACING_MS,
    POSTER_SCRUB_DEBOUNCE_MS,
    DECODE_TIMEOUT_MS,
    AUDIO_DECODE_TIMEOUT_MS
  } from '$lib/timeline/constants';
  import { formatTimecodePrecise } from '$lib/timeline/format';
  import { pathStem } from '$lib/util/path';
  import PlayPauseIcon from './PlayPauseIcon.svelte';

  const duration = $derived(wizardState.mediaInfo?.duration ?? 0);
  const path = $derived(wizardState.mediaInfo?.path ?? '');
  const url = $derived(assetUrl(path));
  // Route on hasRealVideo, NOT codec !== '': a real video whose stream omits
  // codec_name yields codec === '' yet must still render as video (the backend
  // already distinguishes the two via probe's has_real_video). null mediaInfo
  // (no file picked yet) ⇒ false.
  const hasVideo = $derived(wizardState.mediaInfo?.hasRealVideo ?? false);
  // ffprobe's format_name - drives the eager-proxy kick for silent-hang
  // containers (see containerNeedsEagerProxy).
  const container = $derived(wizardState.mediaInfo?.container ?? '');

  // Observational decode state. Reset whenever the ACTIVE source changes (the
  // original file OR a proxy swap - classification re-runs against the proxy).
  let videoEl = $state<HTMLVideoElement | null>(null);
  let decodedAsVideo = $state(false);
  let decodedAsAudio = $state(false);
  let errored = $state(false);
  // The last extracted poster frame (poster mode). Reset on source change too, so
  // a new poster-mode file never shows the previous file's frame (see reset below).
  let posterSrc = $state<string | null>(null);

  // ── Preview-proxy ladder state (§B) ──
  // When runtime decode fails, the Rust side builds a WebKit-playable proxy
  // (remux or transcode) and the <video> src swaps to it. Preview-only: poster
  // extraction and trim/export always use the ORIGINAL path.
  let proxyPath = $state<string | null>(null);
  let proxyPhase = $state<ProxyPhase>('idle');
  let proxyFraction = $state<number | null>(null);
  let audioFailed = $state(false);
  // Method of the last RESOLVED proxy - decides whether a decode-failure of the
  // proxy itself retries with forceTranscode (remux → transcode) or exhausts.
  let lastProxyMethod: 'remux' | 'transcode' | null = null;
  let proxyGen = 0; // stale-async guard, à la posterGen

  // The URL the <video> element actually plays: the proxy once built, else the
  // original. Decode-observation effects key on THIS, the full-reset effect
  // keys on `url` (original path) - a proxy swap must not wipe proxy state.
  const activeUrl = $derived(proxyPath !== null ? assetUrl(proxyPath) : url);

  const previewMode = $derived(
    derivePreviewMode({
      hasSource: url !== null,
      hasVideo,
      decoded: decodedAsVideo,
      audioDecoded: decodedAsAudio,
      errored,
      audioFailed,
      proxyExhausted: proxyPhase === 'exhausted'
    })
  );

  const previewNote = $derived(derivePreviewNote({ mode: previewMode, proxyPhase }));

  // Reset observational state on any ACTIVE source change (new file OR proxy
  // swap - the proxy must be re-classified from scratch). Also clear the
  // previous source's poster: without this, switching A→B when both route
  // to poster mode keeps `previewMode === 'poster' && posterSrc !== null` true, so
  // A's last extracted frame shows in B's box until B's first extract resolves.
  // Bumping posterGen here is load-bearing: nulling posterSrc alone is not enough,
  // because an in-flight extractPosterNow() for A (captured A's path before its
  // await) would re-satisfy `myGen === posterGen` on resolve and repaint A's frame
  // into B's box. Invalidating the generation drops that stale resolve.
  $effect(() => {
    void activeUrl;
    decodedAsVideo = false;
    decodedAsAudio = false;
    errored = false;
    posterSrc = null;
    posterGen++;
  });

  // Full reset on a NEW ORIGINAL source only (new file / Edit re-entry): tear
  // down the whole proxy ladder and cancel any in-flight build. Deliberately
  // does NOT read proxy state (it writes it) - `url` is the only dependency.
  $effect(() => {
    void url;
    proxyGen++; // drop stale build resolves/progress
    proxyPath = null;
    proxyPhase = 'idle';
    proxyFraction = null;
    audioFailed = false;
    lastProxyMethod = null;
    void cancelPreviewProxy().catch(() => {
      /* outside Tauri (vite dev / e2e without the mock) there is nothing to cancel */
    });

    // Eager kick for containers that fail SILENTLY (mpegts). Every other
    // unplayable container fires a MediaError and enters the ladder through
    // failToPoster; mpegts reports valid dimensions at `loadedmetadata`,
    // disarming the decode timeout, and then simply never decodes - so waiting
    // for a runtime signal would wait forever (a permanently black box).
    //
    // This lives INSIDE the reset effect, not in a sibling one, on purpose: a
    // separate $effect would race this one, and if it kicked FIRST the reset
    // below would bump proxyGen and silently drop the in-flight build's
    // resolve. Same-effect ordering is guaranteed.
    //
    // untrack is load-bearing: failToPoster/kickProxy READ state this very
    // effect WRITES (proxyPhase, proxyPath, wizardState.playing). Tracked, those
    // reads make the effect retrigger itself - measured as 1001 build requests
    // in one page load before this guard. `url` stays the sole trigger.
    untrack(() => {
      if (hasVideo && containerNeedsEagerProxy(container)) {
        failToPoster(); // poster shows extracted frames while the proxy builds
      }
    });
  });

  // Route to poster and stop playback (Task 8 invariant: every video→poster
  // transition co-occurs with a play-stop so the controller's RAF re-runs and
  // switches off the now-detached element clock). Shared by the decode-timeout and
  // the <video> error path so the invariant lives in exactly one place.
  //
  // hasVideo-gated: only a file that HAS a video stream has a poster to fall to.
  // For an audio-only file (codec === '') setting `errored` would route
  // derivePreviewMode to 'art' (errored && !hasVideo → art), unmounting the
  // <video> and SILENCING a perfectly playable file with no recovery — the exact
  // outcome the decode-timeout effect is `!hasVideo`-gated to avoid. A spurious
  // MediaError on the invisible audio <video> (asset:// transient, embedded
  // cover-art quirk) must therefore NOT demote it to art; leave it in 'audio' so
  // it keeps playing behind the art backdrop. This keeps the error path symmetric
  // with the timeout path.
  function failToPoster(): void {
    if (!hasVideo) return;
    errored = true;
    if (wizardState.playing) wizardState.playing = false;
    // Ladder (§B): poster shows immediately; a playable proxy builds behind it.
    kickProxy(false);
  }

  // ── Preview-proxy ladder ──
  // kickProxy(fromBuildFailure): decide the next rung and launch it.
  //  attempt 1  - original failed decode → build with forceTranscode:false
  //               (Rust re-probes and picks remux vs transcode);
  //  attempt 2  - a REMUX proxy failed decode → forceTranscode:true (the
  //               copied codecs were the problem after all);
  //  exhausted  - a transcode proxy failed decode, a second build failed, or
  //               a forced build failed: video stays poster (today's bottom
  //               rung), audio demotes to art + unavailable note.
  // Bottom rung. The play-stop here is `!hasVideo`-ONLY, and that asymmetry is
  // load-bearing:
  //  • audio-only - exhaustion flips the mode to 'art', which UNMOUNTS the
  //    <video>. Task 8 invariant: an unmount must co-occur with a play-stop, or
  //    the controller's RAF keeps reading the detached element's frozen clock.
  //  • video - the element is ALREADY gone (failToPoster unmounted it and
  //    stopped playback at that moment) and poster mode runs on the virtual
  //    wall-clock RAF with nothing bound. Stopping here would yank the transport
  //    away from a user who pressed Play while the ladder was still building -
  //    it made the timeline-edit play/pause specs flake ~8% of runs.
  function exhaustLadder(): void {
    proxyPhase = 'exhausted';
    if (!hasVideo && wizardState.playing) wizardState.playing = false;
  }

  function kickProxy(fromBuildFailure: boolean): void {
    if (proxyPhase === 'building' || proxyPhase === 'exhausted') return;
    // Which rung is this?
    let force = false;
    if (fromBuildFailure) {
      force = true; // a default build failed - one forced retry, then exhausted
    } else if (proxyPath !== null) {
      // The PROXY itself failed decode. A transcode proxy failing means the
      // ladder is out of moves; a remux proxy retries as transcode.
      if (lastProxyMethod !== 'remux') {
        exhaustLadder();
        return;
      }
      force = true;
    }
    proxyPhase = 'building';
    proxyFraction = null;
    const myGen = ++proxyGen;
    const wasForced = force;
    buildPreviewProxy(path, force, (e) => {
      if (myGen === proxyGen) proxyFraction = e.fraction;
    })
      .then((r) => {
        if (myGen !== proxyGen) return; // stale: source changed since launch
        lastProxyMethod = r.method;
        proxyPath = r.proxyPath; // activeUrl flips → decode state resets
        proxyPhase = 'done';
        audioFailed = false; // the proxy gets a fresh audio-decode budget
        // Task 8 invariant: every src swap co-occurs with a play-stop so the
        // controller re-binds cleanly to the remounted element.
        if (wizardState.playing) wizardState.playing = false;
      })
      .catch(() => {
        if (myGen !== proxyGen) return;
        if (!wasForced) {
          // A remux build can fail where a transcode succeeds - one retry.
          proxyPhase = 'idle';
          kickProxy(true);
        } else {
          exhaustLadder();
        }
      });
  }

  // True once the element has decoded a real frame (codec present AND videoWidth>0).
  // Shared by both loaded handlers so the "what counts as a real video frame" rule
  // is defined once.
  function isRealVideoFrame(): boolean {
    return hasVideo && videoEl !== null && videoEl.videoWidth > 0;
  }

  // Timeout guard (§3): if neither a real decoded frame nor an error arrives
  // within DECODE_TIMEOUT_MS, treat as undecodable and fall to poster — no hung box.
  // Deliberately one-way: a slow-but-valid video whose first frame arrives after the
  // timeout stays in poster mode (the <video> has already unmounted at poster, so no
  // late decode event can fire). Recovering would mean keeping the element mounted
  // past the timeout, which conflicts with the unmount-on-poster invariant the
  // controller depends on — out of scope here; poster is a correct, non-broken
  // fallback for such files.
  // Disarmed ONLY by decodedAsVideo or errored — deliberately NOT by decodedAsAudio.
  // A hasVideo file that reports videoWidth 0 at BOTH loadedmetadata and loadeddata
  // latches decodedAsAudio (provisional invisible-audio); keeping the timer armed
  // through that latch lets it fall to a visible poster instead of stranding a real
  // video in invisible-audio mode forever. A genuinely real video promotes to
  // decodedAsVideo at loadeddata — within ~a frame of loadedmetadata, far inside the
  // 4s budget — and disarms before the timer fires, so no correct video is demoted.
  // ONLY armed for hasVideo files: for an audio-only file the timeout would demote
  // it to 'art' (errored && !hasVideo → art), unmounting the element and SILENCING
  // a perfectly playable file with no recovery. Audio-only has no video to "fail to
  // poster" and its art backdrop already shows behind the invisible <video>, so the
  // "no hung box" rationale doesn't apply — leave it in 'audio' to load + play.
  $effect(() => {
    void activeUrl;
    if (activeUrl === null || !hasVideo || decodedAsVideo || errored) return;
    const timer = setTimeout(failToPoster, DECODE_TIMEOUT_MS);
    return () => {
      clearTimeout(timer);
    };
  });

  // Audio-only decode watchdog (§B): an undecodable audio file fires NO error
  // (onError is a deliberate no-op for !hasVideo) and never loads - before the
  // proxy ladder it was silent forever with zero feedback. If the element is
  // still at readyState 0 (HAVE_NOTHING) after AUDIO_DECODE_TIMEOUT_MS, treat
  // it as undecodable and kick the proxy. The readyState re-check AT FIRE TIME
  // is the disarm: playable audio reaches ≥1 within the budget (latching
  // decodedAsAudio via loadedmetadata on the way), so the spurious-error
  // protection for playable audio cannot regress. A slow-loading but playable
  // file that trips this merely triggers a harmless remux - the proxy swap
  // re-classifies and plays (documented trade-off).
  $effect(() => {
    void activeUrl;
    if (activeUrl === null || hasVideo || audioFailed) return;
    const timer = setTimeout(() => {
      if (videoEl !== null && videoEl.readyState === 0) {
        audioFailed = true;
        kickProxy(false);
      }
    }, AUDIO_DECODE_TIMEOUT_MS);
    return () => {
      clearTimeout(timer);
    };
  });

  function onLoadedMetadata(): void {
    if (errored) return;
    // codec !== '' AND a real frame (videoWidth>0) ⇒ video; else audio-only.
    //
    // The latch MUST happen HERE, not at `loadeddata`. Measured in the real
    // build: under preload="metadata" WKWebView stops at readyState 1 and a
    // perfectly healthy h264 mp4 emits only progress → suspend →
    // loadedmetadata(rs 1, videoWidth 640) - `loadeddata` NEVER fires. Latching
    // at `loadeddata` therefore left EVERY video unlatched until the 4 s decode
    // timeout demoted it to poster, i.e. no live preview anywhere. (It also
    // could not have distinguished the hung mpegts case it was meant to catch,
    // since that event is absent for good and bad files alike.)
    if (isRealVideoFrame()) decodedAsVideo = true;
    else decodedAsAudio = true;
  }

  function onLoadedData(): void {
    if (errored) return;
    // Recovery for the paths that DO reach readyState ≥ 2 (see the note above:
    // preload="metadata" usually stops before this event). It re-promotes the
    // WebKit codecs that report videoWidth 0 at `loadedmetadata` (above →
    // provisional audio-only, rendered invisible) and only populate the
    // intrinsic size once the first frame lands. derivePreviewMode prioritises
    // `decoded` over `audioDecoded`, so this wins even when decodedAsAudio was
    // already latched. A true audio-only file keeps videoWidth 0 here, so the
    // guard leaves it in audio mode.
    if (isRealVideoFrame()) decodedAsVideo = true;
  }

  function onError(): void {
    // A late MediaError reroutes a video file to poster and pauses. For an
    // audio-only file failToPoster is a no-op (see its hasVideo guard) so a
    // spurious error never silences playable audio.
    failToPoster();
  }

  // Bind the <video> to the controller for video-as-clock (§6). videoEl is a
  // $state ref, so this re-runs when the element mounts/unmounts (mode change);
  // the cleanup clears the ref on this component's own teardown.
  $effect(() => {
    bindPreviewMedia(videoEl);
    return () => {
      bindPreviewMedia(null);
    };
  });

  // ── Poster mode: self-pacing refresh (play) + debounced scrub (paused) ──
  // (posterSrc is declared with the observational state above so the source-change
  // reset clears it.)
  let posterGen = 0;
  let posterInFlight = false;
  let lastPosterStart = 0;

  // untrack: an extract is a snapshot at the instant it is requested, not a
  // reactive computation. `wizardState.playhead` is evaluated as posterFrame's
  // argument BEFORE the first await, so read tracked it becomes a dependency of
  // whichever caller is synchronous - the pump effect below, which calls pump()
  // in its body. In poster mode the virtual RAF writes playhead every frame, so
  // the effect documented as re-running "NOT on every playhead write" got one
  // spurious teardown per playback start (measured 2 effect runs, 1 after this).
  // Self-limiting rather than per-frame, because a backed-off pump() never
  // reaches this read and so drops the dependency again - but the effect should
  // depend on what its comment says it depends on.
  async function extractPosterNow(): Promise<void> {
    const snap = untrack(() => ({ mode: previewMode, src: path, at: wizardState.playhead }));
    if (snap.mode !== 'poster' || snap.src === '') return;
    posterInFlight = true;
    lastPosterStart = performance.now();
    const myGen = ++posterGen;
    try {
      const src = await posterFrame(snap.src, snap.at);
      if (myGen === posterGen) posterSrc = src; // drop stale resolves
    } catch {
      /* keep the previous poster / show the art backdrop — never crash */
    } finally {
      posterInFlight = false;
    }
  }

  // Self-pacing during poster playback: re-extract as fast as the machine allows
  // (capped at POSTER_MIN_SPACING_MS), one in flight at a time so slow hardware
  // backs off naturally. The loop self-perpetuates on completion (NOT on every
  // playhead write) so a fast virtual RAF can't starve it.
  $effect(() => {
    if (previewMode !== 'poster' || !wizardState.playing) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pump = (): void => {
      if (cancelled) return;
      const wait = posterDelayMs(performance.now(), lastPosterStart, POSTER_MIN_SPACING_MS);
      // Back off (not yet at the cadence floor, or an extract is still in flight)
      // — re-check after `wait` (or one spacing tick) without starting work.
      if (wait > 0 || posterInFlight) {
        timer = setTimeout(pump, wait > 0 ? wait : POSTER_MIN_SPACING_MS);
        return;
      }
      void extractPosterNow().then(() => {
        // Reschedule on the next macrotask and let posterDelayMs (which measures
        // from extract START) be the SOLE cadence gate. A fixed POSTER_MIN_SPACING_MS
        // delay here would stack on top of that floor — by the time pump re-ran the
        // floor was already satisfied — yielding ~(extractTime + spacing) per frame,
        // i.e. roughly half the intended ~10fps. The 0-delay reschedule keeps the
        // start-to-start gap at max(extractTime, POSTER_MIN_SPACING_MS).
        if (!cancelled) timer = setTimeout(pump, 0);
      });
    };
    pump();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  });

  // Debounced scrub while paused (poster mode only).
  $effect(() => {
    void wizardState.playhead; // track
    if (previewMode !== 'poster' || wizardState.playing) return;
    const timer = setTimeout(() => {
      void extractPosterNow();
    }, POSTER_SCRUB_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  });
</script>

<div class="preview">
  <div class="preview-art" aria-hidden="true">
    <div class="preview-rays"></div>
    <div class="preview-shape s1"></div>
    <div class="preview-shape s2"></div>
    <div class="preview-grid"></div>
  </div>

  {#if activeUrl !== null && (previewMode === 'video' || previewMode === 'audio')}
    <!-- svelte-ignore a11y_media_has_caption -->
    <video
      bind:this={videoEl}
      class="preview-video"
      class:audio-only={previewMode === 'audio'}
      src={activeUrl}
      playsinline
      preload="metadata"
      aria-label={pathStem(path)}
      onloadedmetadata={onLoadedMetadata}
      onloadeddata={onLoadedData}
      onerror={onError}
    ></video>
  {/if}

  {#if previewMode === 'poster' && posterSrc !== null}
    <img class="preview-poster" src={posterSrc} alt="" />
  {/if}

  <div class="preview-tc" aria-hidden="true">
    {formatTimecodePrecise(wizardState.playhead)} / {formatTimecodePrecise(duration)}
  </div>

  {#if previewNote !== null}
    <p class="preview-note">
      {#if previewNote === 'preparing'}
        <!-- &nbsp; not {' '}: a string-literal mustache trips svelte/no-useless-mustaches,
             and a non-breaking space also keeps the percentage on the label's line. -->
        {t('preview.note.preparing')}{#if proxyFraction !== null}&nbsp;{Math.round(
            proxyFraction * 100
          )}%{/if}
      {:else if previewNote === 'poster'}
        {t('preview.note.poster')}
      {:else}
        {t('preview.note.unavailable')}
      {/if}
    </p>
  {/if}

  <button
    type="button"
    class="play-btn"
    aria-label={wizardState.playing ? t('transport.pause') : t('transport.play')}
    onclick={togglePlay}
  >
    <PlayPauseIcon playing={wizardState.playing} size={wizardState.playing ? 18 : 20} />
  </button>
</div>

<style>
  /* Ported from the design bundle app.css. Physical-axis converted to logical:
     .s1 inline-start 18%; .s2 inline-end 12%; .preview-tc inset-inline-start. */
  .preview {
    background: #0f1421;
    aspect-ratio: 16 / 9;
    border-radius: var(--radius-md);
    display: grid;
    place-items: center;
    position: relative;
    overflow: hidden;
    /* Center the box in the flex column (.step). A DEFINITE sub-line width (min of
       100% and the 16:9 width at max-height 320px) is required: with plain
       `width:100%` flexbox sees zero free space and align/auto-margins can't center,
       and with `width:auto` the box collapses to its only in-flow child (the play
       button — every other layer is absolutely positioned). align-self centers it. */
    width: min(100%, calc(320px * 16 / 9));
    align-self: center;
    max-height: 320px;
  }
  .preview-art {
    position: absolute;
    inset: 0;
  }
  .preview-video,
  .preview-poster {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: contain;
    background: #0f1421;
  }
  /* Audio-only files load into <video> but render no frame (videoWidth 0); keep
     the element present + audible but visually behind the art backdrop. */
  .preview-video.audio-only {
    opacity: 0;
    pointer-events: none;
  }
  .preview-note {
    position: absolute;
    inset-inline: 12px;
    bottom: 10px;
    z-index: 1;
    margin: 0;
    padding: 4px 9px;
    font-size: var(--text-xs);
    text-align: center;
    color: rgba(255, 255, 255, 0.82);
    background: rgba(0, 0, 0, 0.4);
    border-radius: var(--radius-xs);
  }
  .preview-rays {
    position: absolute;
    inset: 0;
    background:
      radial-gradient(ellipse 60% 80% at 25% 30%, rgba(99, 132, 251, 0.22), transparent 60%),
      radial-gradient(ellipse 70% 60% at 80% 70%, rgba(40, 73, 214, 0.28), transparent 55%);
  }
  .preview-shape {
    position: absolute;
    border-radius: 50%;
    filter: blur(40px);
    mix-blend-mode: screen;
  }
  .preview-shape.s1 {
    width: 220px;
    height: 220px;
    inset-inline-start: 18%;
    top: 22%;
    background: rgba(124, 156, 255, 0.5);
  }
  .preview-shape.s2 {
    width: 280px;
    height: 280px;
    inset-inline-end: 12%;
    bottom: 8%;
    background: rgba(40, 73, 214, 0.55);
  }
  .preview-grid {
    position: absolute;
    inset: 0;
    background-image:
      linear-gradient(rgba(255, 255, 255, 0.03) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255, 255, 255, 0.03) 1px, transparent 1px);
    background-size: 32px 32px;
  }
  .preview-tc {
    position: absolute;
    top: 12px;
    inset-inline-start: 14px;
    padding: 4px 9px;
    font: 600 var(--text-xs) var(--font-mono);
    background: rgba(0, 0, 0, 0.45);
    color: white;
    border-radius: var(--radius-xs);
    letter-spacing: 0.04em;
    /* Keep the media timecode LTR so "playhead / duration" never visually
       reverses under RTL (bidi reorders the slash-separated numerals). Consistent
       with .timeline-track's own direction:ltr override. */
    direction: ltr;
  }
  /* No [dir='rtl'] scaleX(-1) here — matches the design bundle, which mirrors the
     .ctl-btn transport row under RTL but leaves this center overlay play button
     un-flipped (like the other timeline visuals it sits over, which are locally
     LTR). Intentional divergence from Transport's .ctl-btn, kept verbatim. */
  .play-btn {
    position: relative;
    z-index: 1;
    width: 64px;
    height: 64px;
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.94);
    color: #111;
    border: none;
    display: grid;
    place-items: center;
    cursor: pointer;
    transition: all 0.15s ease;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
  }
  .play-btn:hover {
    transform: scale(1.06);
    background: white;
  }
</style>
