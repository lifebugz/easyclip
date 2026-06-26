<script lang="ts">
  import { t } from '$lib/i18n/index.svelte';
  import { formatDuration } from '$lib/util/format-duration';

  interface Props {
    original: number;
    final: number;
    /** DF-1: dim the FINAL value while the exact keyframe-snapped plan is recomputing. */
    computing?: boolean;
  }

  let { original, final, computing = false }: Props = $props();
</script>

<div class="readout-row">
  <span class="readout-piece">
    <span class="readout-key">{t('edit.original')}</span>
    <span class="readout-val">{formatDuration(original)}</span>
  </span>
  <span class="readout-piece small muted readout-arrow" aria-hidden="true">→</span>
  <span class="readout-piece" class:is-computing={computing}>
    <span class="readout-key">{t('edit.final')}</span>
    <span class="readout-val">{formatDuration(final)}</span>
  </span>
</div>

<style>
  /* Port .readout-row, .readout-piece (+ .small/.muted), .readout-arrow
     (+ its [dir=rtl] scaleX flip), .readout-key, .readout-val from app.css.
     Already logical (margin-inline-start) — port verbatim. */
  .readout-row {
    display: flex;
    align-items: center;
    gap: 18px;
    padding: 6px 4px 0;
    flex-wrap: wrap;
  }
  .readout-piece {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .readout-piece.muted {
    color: var(--color-text-muted);
  }
  .readout-piece.small {
    font-size: var(--text-xs);
  }
  .readout-arrow {
    display: inline-block;
  }
  :global([dir='rtl']) .readout-arrow {
    transform: scaleX(-1);
  }
  .readout-key {
    font: 600 10px var(--font-sans);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--color-text-muted);
  }
  .readout-val {
    font: 600 var(--text-sm) var(--font-mono);
    color: var(--color-text);
    font-variant-numeric: tabular-nums;
  }
  /* DF-1: dim the FINAL value while the exact plan is being computed, so a
     transient value is never presented as final (sparse-GOP files can shift by
     seconds). No layout change. */
  .readout-piece.is-computing .readout-val {
    opacity: 0.45;
    transition: opacity 0.15s ease;
  }
</style>
