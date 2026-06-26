<script lang="ts">
  // Visual playback marker (amendment §6.2). Positioned in full-clip coordinates
  // (timeToPct over duration), rendered only while the playhead is within the
  // trim window. Reads wizardState directly so it tracks the RAF loop's mutations.
  import { wizardState } from '$lib/wizard/state.svelte';
  import { timeToPct } from '$lib/timeline/coord';

  let { duration }: { duration: number } = $props();

  const inRange = $derived(
    wizardState.playhead >= wizardState.trimRange.start &&
      wizardState.playhead <= wizardState.trimRange.end
  );
</script>

{#if inRange}
  <div class="playhead" style="inset-inline-start: {timeToPct(wizardState.playhead, duration)}%">
    <span class="playhead-knob"></span>
  </div>
{/if}

<style>
  /* Ported from the design bundle app.css (.playhead + .playhead-knob). The
     timeline is locally LTR, so the bundle's empty [dir=rtl] overrides are
     intentionally omitted. top/bottom are block-axis; position is logical. */
  .playhead {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 2px;
    background: white;
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.45);
    z-index: 6;
    pointer-events: none;
    transform: translateX(-1px);
  }
  .playhead-knob {
    position: absolute;
    top: -5px;
    inset-inline-start: 50%;
    transform: translateX(-50%);
    width: 11px;
    height: 11px;
    background: white;
    border: 1px solid rgba(0, 0, 0, 0.45);
    border-radius: 50%;
  }
</style>
