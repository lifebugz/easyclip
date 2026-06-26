<script lang="ts">
  import { formatDuration } from '$lib/util/format-duration';

  interface Props {
    duration: number;
  }

  let { duration }: Props = $props();
</script>

<div class="time-ruler" aria-hidden="true">
  <span>{formatDuration(0)}</span>
  <span>{formatDuration(duration * 0.25)}</span>
  <span>{formatDuration(duration * 0.5)}</span>
  <span>{formatDuration(duration * 0.75)}</span>
  <span>{formatDuration(duration)}</span>
</div>

<style>
  /* Port .time-ruler from app.css verbatim (already logical; keep direction: ltr). */
  .time-ruler {
    display: flex;
    justify-content: space-between;
    padding: 0 6px;
    font: 500 var(--text-xs) var(--font-mono);
    color: var(--color-text-muted);
    font-variant-numeric: tabular-nums;
    direction: ltr;
  }
</style>
