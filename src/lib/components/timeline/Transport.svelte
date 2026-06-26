<script lang="ts">
  // Persistent playback control bar: play/pause + the playhead/duration time
  // display (amendment §6.2). Prev/next-keyframe stepping is deferred (Phase 10
  // a11y) — see the Phase 8 plan Scope notes.
  import { t } from '$lib/i18n/index.svelte';
  import { wizardState } from '$lib/wizard/state.svelte';
  import { togglePlay } from '$lib/timeline/playback.svelte';
  import { formatTimecodePrecise } from '$lib/timeline/format';
  import PlayPauseIcon from './PlayPauseIcon.svelte';

  const duration = $derived(wizardState.mediaInfo?.duration ?? 0);
</script>

<div class="transport">
  <div class="ctl-group">
    <button
      type="button"
      class="ctl-btn primary"
      aria-label={wizardState.playing ? t('transport.pause') : t('transport.play')}
      onclick={togglePlay}
    >
      <PlayPauseIcon playing={wizardState.playing} size={14} />
    </button>
    <span class="time-display">
      <span class="big">{formatTimecodePrecise(wizardState.playhead)}</span>
      <span class="sep" aria-hidden="true">/</span>
      <span class="muted">{formatTimecodePrecise(duration)}</span>
    </span>
  </div>
</div>

<style>
  /* Ported from the design bundle app.css (.transport, .ctl-group, .ctl-btn(.primary),
     .time-display). The bundle mirrors .ctl-btn under RTL (scaleX(-1)) so the play
     triangle points correctly; kept verbatim. */
  .transport {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 4px 2px;
    margin-top: 2px;
  }
  .ctl-group {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .ctl-btn {
    width: 38px;
    height: 38px;
    border-radius: 50%;
    border: 1px solid var(--color-border-strong);
    background: white;
    display: grid;
    place-items: center;
    cursor: pointer;
    color: var(--color-text-body);
    transition: all 0.15s ease;
  }
  .ctl-btn:hover {
    background: var(--color-bg);
    border-color: var(--color-text-muted);
  }
  .ctl-btn.primary {
    background: var(--color-brand-600);
    color: white;
    border-color: var(--color-brand-600);
    width: 46px;
    height: 46px;
  }
  .ctl-btn.primary:hover {
    background: var(--color-brand-700);
    border-color: var(--color-brand-700);
  }
  :global([dir='rtl']) .ctl-btn {
    transform: scaleX(-1);
  }
  .time-display {
    display: inline-flex;
    align-items: baseline;
    gap: 6px;
    font: 600 var(--text-base) var(--font-mono);
    color: var(--color-text);
    font-variant-numeric: tabular-nums;
    /* Keep the timecode LTR so the inline-flex segments (playhead / sep / duration)
       don't reverse under RTL — the readout always reads playhead-then-duration.
       Consistent with .timeline-track's direction:ltr override. */
    direction: ltr;
  }
  .time-display .big {
    font-size: var(--text-lg);
  }
  .time-display .sep {
    color: var(--color-text-muted);
  }
  .time-display .muted {
    color: var(--color-text-muted);
    font-weight: 500;
  }
</style>
