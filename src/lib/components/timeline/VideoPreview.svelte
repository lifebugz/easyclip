<script lang="ts">
  // Layered preview box (§8). Decorative art stays aria-hidden; a real <video>
  // (video/audio mode) or <img> poster (poster mode) renders on top. The mode is
  // resolved from mediaInfo.hasRealVideo plus the element's runtime decode events.
  // art is the no-regression safety net (today's exact behavior).
  import { t } from '$lib/i18n/index.svelte';
  import { wizardState } from '$lib/wizard/state.svelte';
  import { togglePlay, bindPreviewMedia } from '$lib/timeline/playback.svelte';
  import { derivePreviewMode, posterDelayMs } from '$lib/timeline/playback';
  import { assetUrl, posterFrame } from '$lib/tauri/preview';
  import {
    POSTER_MIN_SPACING_MS,
    POSTER_SCRUB_DEBOUNCE_MS,
    DECODE_TIMEOUT_MS
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

  // Observational decode state. Reset whenever the source path changes.
  let videoEl = $state<HTMLVideoElement | null>(null);
  let decodedAsVideo = $state(false);
  let decodedAsAudio = $state(false);
  let errored = $state(false);
  // The last extracted poster frame (poster mode). Reset on source change too, so
  // a new poster-mode file never shows the previous file's frame (see reset below).
  let posterSrc = $state<string | null>(null);

  const previewMode = $derived(
    derivePreviewMode({
      hasSource: url !== null,
      hasVideo,
      decoded: decodedAsVideo,
      audioDecoded: decodedAsAudio,
      errored
    })
  );

  // Reset observational state on a new source (new file / Edit re-entry). Also
  // clear the previous file's poster: without this, switching A→B when both route
  // to poster mode keeps `previewMode === 'poster' && posterSrc !== null` true, so
  // A's last extracted frame shows in B's box until B's first extract resolves.
  // Bumping posterGen here is load-bearing: nulling posterSrc alone is not enough,
  // because an in-flight extractPosterNow() for A (captured A's path before its
  // await) would re-satisfy `myGen === posterGen` on resolve and repaint A's frame
  // into B's box. Invalidating the generation drops that stale resolve.
  $effect(() => {
    void url;
    decodedAsVideo = false;
    decodedAsAudio = false;
    errored = false;
    posterSrc = null;
    posterGen++;
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
    void url;
    if (url === null || !hasVideo || decodedAsVideo || errored) return;
    const timer = setTimeout(failToPoster, DECODE_TIMEOUT_MS);
    return () => {
      clearTimeout(timer);
    };
  });

  function onLoadedMetadata(): void {
    if (errored) return;
    // codec !== '' AND a real frame (videoWidth>0) ⇒ video; else audio-only.
    if (isRealVideoFrame()) decodedAsVideo = true;
    else decodedAsAudio = true;
  }

  function onLoadedData(): void {
    if (errored) return;
    // Recovery for WebKit codecs that report videoWidth 0 at `loadedmetadata`
    // (above → provisional audio-only, rendered invisible) and only populate the
    // intrinsic size a tick later. By `loadeddata` the first frame has decoded so
    // videoWidth is reliable; promoting here flips a misclassified real video back
    // to video mode. derivePreviewMode prioritises `decoded` over `audioDecoded`,
    // so this wins even when decodedAsAudio was already latched. A true audio-only
    // file keeps videoWidth 0 here, so the guard leaves it in audio mode.
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

  async function extractPosterNow(): Promise<void> {
    if (previewMode !== 'poster' || path === '') return;
    posterInFlight = true;
    lastPosterStart = performance.now();
    const myGen = ++posterGen;
    try {
      const src = await posterFrame(path, wizardState.playhead);
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

  {#if url !== null && (previewMode === 'video' || previewMode === 'audio')}
    <!-- svelte-ignore a11y_media_has_caption -->
    <video
      bind:this={videoEl}
      class="preview-video"
      class:audio-only={previewMode === 'audio'}
      src={url}
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

  {#if previewMode === 'poster' || previewMode === 'art'}
    <p class="preview-note">
      {previewMode === 'poster' ? t('preview.note.poster') : t('preview.note.unavailable')}
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
