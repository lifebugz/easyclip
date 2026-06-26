<script lang="ts">
  import { t } from '$lib/i18n/index.svelte';
  import { formatTimecodePrecise } from '$lib/timeline/format';

  interface Props {
    count: number;
    removedSeconds: number;
  }

  let { count, removedSeconds }: Props = $props();
</script>

<div class="cuts-summary" class:empty={count === 0}>
  {#if count > 0}<span class="dot"></span>{/if}
  {#if count === 0}
    {t('edit.cutsSummary.empty')}
  {:else if count === 1}
    {t('edit.cutsSummary.one')}<strong>{formatTimecodePrecise(removedSeconds)}</strong>
  {:else}
    <strong>{count}</strong>{t('edit.cutsSummary.many')}<strong
      >{formatTimecodePrecise(removedSeconds)}</strong
    >
  {/if}
</div>

<style>
  /* Port .cuts-summary (+ .empty) and .dot from app.css. Already logical
     (uses border-inline-start) — port verbatim. */
  .cuts-summary {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    font-size: var(--text-sm);
    color: var(--color-text);
    background: var(--color-brand-50);
    border-inline-start: 3px solid var(--color-brand-600);
    border-radius: var(--radius-sm);
  }
  .cuts-summary.empty {
    background: var(--color-bg);
    border-color: var(--color-border-strong);
  }
  .dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--color-danger-700);
    flex-shrink: 0;
  }
</style>
