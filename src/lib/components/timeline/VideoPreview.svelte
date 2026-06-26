<script lang="ts">
  // Decorative 16:9 art + the Phase 8 playback affordances (timecode overlay +
  // play/pause button). The art stays aria-hidden; the button is a real labelled
  // control. No <video> element anywhere — the playhead is a DOM marker (§6.2).
  import { t } from '$lib/i18n/index.svelte';
  import { wizardState } from '$lib/wizard/state.svelte';
  import { togglePlay } from '$lib/timeline/playback.svelte';
  import { formatTimecodePrecise } from '$lib/timeline/format';
  import PlayPauseIcon from './PlayPauseIcon.svelte';

  const duration = $derived(wizardState.mediaInfo?.duration ?? 0);
</script>

<div class="preview">
  <div class="preview-art" aria-hidden="true">
    <div class="preview-rays"></div>
    <div class="preview-shape s1"></div>
    <div class="preview-shape s2"></div>
    <div class="preview-grid"></div>
  </div>

  <div class="preview-tc" aria-hidden="true">
    {formatTimecodePrecise(wizardState.playhead)} / {formatTimecodePrecise(duration)}
  </div>

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
    max-height: 320px;
  }
  .preview-art {
    position: absolute;
    inset: 0;
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
