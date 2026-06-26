<script lang="ts">
  // Decorative waveform row inside the kept-content band (amendment §6.3).
  // Renders only when the media has audio (the caller gates on hasAudio). Bars
  // come from seedToWaveBars — NOT real audio peaks (§6.3 honesty rule).
  let { bars }: { bars: number[] } = $props();
</script>

<div class="wave-overlay" aria-hidden="true">
  {#each bars as h, i (i)}
    <span class="wave-bar" style="height: {h * 100}%"></span>
  {/each}
</div>

<style>
  /* Ported from the design bundle app.css (.track-dynamic .wave-overlay + .wave-bar).
     The overlay positions itself inside the parent .track-dynamic. inset is the
     logical shorthand (block 8 / inline 4), consistent with Phase 7 usage. */
  .wave-overlay {
    position: absolute;
    inset: 8px 4px;
    display: flex;
    align-items: center;
    gap: 1.5px;
  }
  .wave-bar {
    flex: 1;
    background: linear-gradient(180deg, rgba(40, 73, 214, 0.55), rgba(31, 58, 174, 0.42));
    border-radius: 1px;
    min-width: 2px;
  }
</style>
