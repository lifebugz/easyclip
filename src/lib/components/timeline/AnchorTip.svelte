<script lang="ts">
  import { formatTimecodePrecise } from '$lib/timeline/format';

  interface Props {
    pct: number;
    seconds: number;
  }

  let { pct, seconds }: Props = $props();
</script>

<!-- Numeric-only, aria-hidden (the timeline is not a slider; position needs no
     AT announcement in Phase 7). Occupies the same slot as the Phase 8 SnapBadge
     (top:-28px, translateX(-50%)) so Phase 8 can merge them into one pill. -->
<div class="anchor-tip" aria-hidden="true" style="inset-inline-start: {pct}%">
  {formatTimecodePrecise(seconds)}
</div>

<style>
  .anchor-tip {
    position: absolute;
    top: -28px;
    transform: translateX(-50%);
    padding: 3px 8px;
    background: var(--color-text);
    color: white;
    font: 500 var(--text-xs) var(--font-mono);
    border-radius: var(--radius-sm);
    pointer-events: none;
    z-index: 8;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  /* Timeline track is locally LTR; no flip. (Phase 8 SnapBadge shares this slot.) */
</style>
