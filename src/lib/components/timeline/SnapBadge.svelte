<script lang="ts">
  // Floating "◆ keyframe" pill shown while a snap-eligible drag locks onto a
  // keyframe (amendment §6.1). Dedupe is the caller's job: Timeline tracks the
  // snapped-keyframe index and only toggles this node on an index/on-off change,
  // never per pointermove tick. The polite live region announces when the badge
  // mounts (each time snapping re-engages from a not-snapped state); with
  // normally-spaced keyframes the pointer crosses a non-snapped gap between them,
  // so that lands at roughly once per keyframe.
  let { pct, label }: { pct: number; label: string } = $props();
</script>

<div class="snap-badge" style="inset-inline-start: {pct}%" aria-live="polite">
  <span aria-hidden="true">◆</span>
  {label}
</div>

<style>
  /* Ported from the design bundle app.css (.snap-badge + @keyframes snapPop).
     top is block-axis (allowed); positioning is logical (inset-inline-start). */
  .snap-badge {
    position: absolute;
    top: -28px;
    transform: translateX(-50%);
    padding: 3px 8px;
    background: var(--color-text);
    color: white;
    font: 500 var(--text-xs) var(--font-sans);
    border-radius: var(--radius-sm);
    pointer-events: none;
    z-index: 8;
    white-space: nowrap;
    animation: snapPop 0.25s ease-out;
  }
  @keyframes snapPop {
    from {
      opacity: 0;
      transform: translateX(-50%) translateY(4px);
    }
    to {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
    }
  }
</style>
