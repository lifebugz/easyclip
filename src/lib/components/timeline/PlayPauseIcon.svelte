<script lang="ts">
  // Shared play/pause glyph (amendment §6.2). The pause (two bars) and play
  // (triangle) SVGs were duplicated verbatim in VideoPreview and Transport — only
  // the rendered size differed. Extracted here so the markup lives once; each
  // caller keeps its own <button> wrapper, label and scoped styling. `fill` is
  // currentColor, so the glyph inherits the button's text colour.
  let { playing, size }: { playing: boolean; size: number } = $props();
</script>

{#if playing}
  <svg width={size} height={size} viewBox="0 0 18 18" fill="currentColor" aria-hidden="true">
    <rect x="3" y="2" width="4" height="14" rx="1" />
    <rect x="11" y="2" width="4" height="14" rx="1" />
  </svg>
{:else}
  <svg width={size} height={size} viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
    <path d="M5 3.5v13l11-6.5z" />
  </svg>
{/if}
