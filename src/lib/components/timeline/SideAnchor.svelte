<script lang="ts">
  interface Props {
    pct: number;
    ariaLabel: string;
    onpointerdown: (e: PointerEvent) => void;
  }

  let { pct, ariaLabel, onpointerdown }: Props = $props();
</script>

<button
  type="button"
  class="side-anchor"
  aria-label={ariaLabel}
  style="inset-inline-start: calc({pct}% - 6px)"
  {onpointerdown}
>
  <span class="grip vertical"></span>
  <span class="grip vertical"></span>
</button>

<style>
  /* Port .side-anchor (+ :hover) and .grip.vertical (+ :nth-child positioning)
     from app.css. Already logical (inset-inline-start/end on the grips) —
     port verbatim. */
  .side-anchor {
    position: absolute;
    top: -2px;
    bottom: -2px;
    width: 12px;
    background: var(--color-brand-600);
    border: 1px solid var(--color-brand-800);
    border-radius: 3px;
    cursor: ew-resize;
    z-index: 5;
    display: grid;
    place-items: center;
    padding: 0;
    box-shadow: 0 2px 6px rgba(28, 48, 138, 0.32);
    transition: background 0.15s ease;
  }
  .side-anchor:hover {
    background: var(--color-brand-700);
  }
  .grip.vertical {
    position: absolute;
    width: 1.5px;
    height: 22px;
    background: var(--color-anchor-grip);
    border-radius: 1px;
  }
  .side-anchor .grip.vertical:nth-child(1) {
    inset-inline-start: 3px;
  }
  .side-anchor .grip.vertical:nth-child(2) {
    inset-inline-end: 3px;
  }
</style>
