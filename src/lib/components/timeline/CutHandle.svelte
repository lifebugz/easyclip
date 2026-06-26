<script lang="ts">
  interface Props {
    edge: 'start' | 'end';
    ariaLabel: string;
    onpointerdown: (e: PointerEvent) => void;
  }

  let { edge, ariaLabel, onpointerdown }: Props = $props();
</script>

<button
  type="button"
  class="cut-handle"
  class:start={edge === 'start'}
  class:end={edge === 'end'}
  aria-label={ariaLabel}
  {onpointerdown}
></button>

<style>
  /* Port .cut-handle (+ ::before/::after grip lines, .start/.end positioning,
     :hover) from app.css. Already logical (inset-inline-start/end) — port verbatim. */
  .cut-handle {
    position: absolute;
    top: -3px;
    bottom: -3px;
    width: 12px;
    background: var(--color-danger-700);
    border: 1px solid white;
    border-radius: 2px;
    cursor: ew-resize;
    z-index: 4;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 3px;
    padding: 0;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
  }
  .cut-handle::before,
  .cut-handle::after {
    content: '';
    width: 6px;
    height: 1.5px;
    background: white;
    border-radius: 1px;
  }
  .cut-handle.start {
    inset-inline-start: -6px;
  }
  .cut-handle.end {
    inset-inline-end: -6px;
  }
  .cut-handle:hover {
    background: #7f1d1d;
  }
</style>
