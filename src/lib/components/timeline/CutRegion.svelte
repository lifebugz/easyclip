<script lang="ts">
  import { t } from '$lib/i18n/index.svelte';
  import { formatTimecodePrecise } from '$lib/timeline/format';
  import CutHandle from './CutHandle.svelte';
  import type { Cut } from '$lib/wizard/state.svelte';

  interface Props {
    cut: Cut;
    leftPct: number;
    widthPct: number;
    pending?: boolean;
    onResizeStart?: (edge: 'start' | 'end', e: PointerEvent) => void;
    onDelete?: () => void;
  }

  let { cut, leftPct, widthPct, pending = false, onResizeStart, onDelete }: Props = $props();

  function handleResizeStart(e: PointerEvent) {
    onResizeStart?.('start', e);
  }
  function handleResizeEnd(e: PointerEvent) {
    onResizeStart?.('end', e);
  }
  function handleDelete(e: MouseEvent) {
    e.stopPropagation();
    onDelete?.();
  }
</script>

<!-- The pending preview carries no data-cut-id: it has no focusable children and
     must never be a keyboard-delete target, so the 'pending' sentinel id stays
     out of the DOM (no collision with a real keyed cut). -->
<div
  class="cut-region"
  class:pending
  data-cut-id={pending ? undefined : cut.id}
  style="inset-inline-start: {leftPct}%; width: {widthPct}%"
>
  <span class="cut-label">
    <span class="cut-scissors" aria-hidden="true">✂</span>
    <span>{t('edit.cut')}</span>
    <span class="cut-dur">{'−' + formatTimecodePrecise(cut.end - cut.start)}</span>
  </span>
  {#if !pending}
    <CutHandle
      edge="start"
      ariaLabel={t('edit.aria.cutResizeStart')}
      onpointerdown={handleResizeStart}
    />
    <CutHandle edge="end" ariaLabel={t('edit.aria.cutResizeEnd')} onpointerdown={handleResizeEnd} />
    <button type="button" class="cut-x" aria-label={t('edit.aria.deleteCut')} onclick={handleDelete}
      >×</button
    >
  {/if}
</div>

<style>
  /* Port .cut-region (+ .pending), .cut-label, .cut-scissors, .cut-dur, .cut-x
     (+ :hover, + .cut-region:hover .cut-x reveal) from app.css. Already logical
     (inset-inline-start/end, margin-inline-start) — port verbatim. */
  .cut-region {
    position: absolute;
    top: 0;
    bottom: 0;
    background-color: rgba(220, 38, 38, 0.36);
    background-image: repeating-linear-gradient(
      135deg,
      rgba(255, 255, 255, 0.12) 0,
      rgba(255, 255, 255, 0.12) 2px,
      transparent 2px,
      transparent 9px
    );
    box-shadow:
      inset 3px 0 0 var(--color-danger-700),
      inset -3px 0 0 var(--color-danger-700);
    z-index: 3;
  }
  .cut-region.pending {
    background-color: rgba(220, 38, 38, 0.22);
    box-shadow: none;
    outline: 2px dashed var(--color-danger-700);
    outline-offset: -2px;
    z-index: 4;
  }
  .cut-label {
    position: absolute;
    top: -23px;
    inset-inline-start: 50%;
    transform: translateX(-50%);
    padding: 2px 8px;
    font: 500 var(--text-xs) var(--font-mono);
    background: var(--color-danger-700);
    color: white;
    border-radius: var(--radius-sm);
    white-space: nowrap;
    pointer-events: none;
    font-variant-numeric: tabular-nums;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    letter-spacing: 0.01em;
  }
  .cut-scissors {
    font-size: 11px;
    line-height: 1;
    opacity: 0.95;
  }
  .cut-dur {
    font-weight: 600;
    background: rgba(255, 255, 255, 0.18);
    border-radius: 3px;
    padding: 0 4px;
    margin-inline-start: 2px;
  }
  .cut-x {
    position: absolute;
    top: 4px;
    inset-inline-end: 4px;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: rgba(0, 0, 0, 0.5);
    color: white;
    border: none;
    font-size: 13px;
    font-weight: 700;
    line-height: 1;
    cursor: pointer;
    display: grid;
    place-items: center;
    z-index: 5;
    opacity: 0;
    transition: opacity 0.15s ease;
  }
  /* Reveal the delete button on hover AND on keyboard focus: tabbing onto any
     focusable descendant (the resize handles or the × itself) lands inside the
     region, so :focus-within makes the otherwise hover-only control visible to
     keyboard users (WCAG 2.1 SC 1.4.13 content-on-hover-or-focus). */
  .cut-region:hover .cut-x,
  .cut-region:focus-within .cut-x {
    opacity: 1;
  }
  .cut-x:hover {
    background: var(--color-danger-700);
  }
</style>
