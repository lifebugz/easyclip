<script lang="ts">
  import { onMount } from 'svelte';
  import { t } from '$lib/i18n/index.svelte';

  interface Props {
    midPct: number;
    onConfirm: () => void;
    onCancel: () => void;
  }

  let { midPct, onConfirm, onCancel }: Props = $props();

  let confirmEl: HTMLButtonElement | null = $state<HTMLButtonElement | null>(null);
  // Move keyboard focus to the primary action when the prompt appears. onMount
  // (not $effect) so it fires exactly ONCE after the bind commits — an $effect
  // would re-run on any future reactive change and re-steal focus to this
  // destructive button mid-interaction. DF-2/D6: the cut-create merge path
  // relies on this instead of focusing the new cut.
  onMount(() => {
    confirmEl?.focus();
  });
</script>

<div
  class="merge-prompt"
  style="inset-inline-start: {midPct}%"
  role="dialog"
  aria-labelledby="merge-prompt-title"
>
  <div class="prompt-title" id="merge-prompt-title">{t('edit.merge.title')}</div>
  <div class="prompt-text">{t('edit.merge.body')}</div>
  <div class="prompt-buttons">
    <button type="button" class="prompt-btn" onclick={onCancel}>{t('edit.merge.cancel')}</button>
    <button type="button" class="prompt-btn confirm" bind:this={confirmEl} onclick={onConfirm}
      >{t('edit.merge.confirm')}</button
    >
  </div>
  <div class="prompt-arrow"></div>
</div>

<style>
  /* Port .merge-prompt, .prompt-title, .prompt-text, .prompt-buttons,
     .prompt-btn (+ .confirm, + :hover), .prompt-arrow (+ @keyframes popIn)
     from app.css. Already logical (inset-inline-start) — port verbatim. */
  .merge-prompt {
    position: absolute;
    bottom: calc(100% + 14px);
    transform: translateX(-50%);
    background: white;
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-lg);
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-width: 240px;
    max-width: 300px;
    z-index: 20;
    animation: popIn 0.18s ease-out;
  }
  .prompt-title {
    font: 700 var(--text-sm) var(--font-sans);
    color: var(--color-text);
  }
  .prompt-text {
    font-size: var(--text-sm);
    color: var(--color-text-body);
    line-height: 1.45;
  }
  .prompt-buttons {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  }
  /* The prompt lives inside the force-LTR .timeline-track, so its
     inset-inline-start positioning stays measured from the track's visual left.
     Flip only the CONTENT direction in RTL locales so Hebrew prose and its
     trailing punctuation render correctly (e.g. the "?" lands at the logical
     end of the sentence) without mirroring the container's horizontal position. */
  :global([dir='rtl']) .prompt-title,
  :global([dir='rtl']) .prompt-text,
  :global([dir='rtl']) .prompt-buttons {
    direction: rtl;
  }
  .prompt-btn {
    padding: 6px 14px;
    font: 500 var(--text-sm) var(--font-sans);
    border-radius: var(--radius-sm);
    cursor: pointer;
    border: 1px solid var(--color-border-strong);
    background: white;
    color: var(--color-text-body);
    min-height: 32px;
    transition: all 0.15s ease;
  }
  .prompt-btn:hover {
    background: var(--color-bg);
  }
  .prompt-btn.confirm {
    background: var(--color-danger-700);
    color: white;
    border-color: var(--color-danger-700);
    font-weight: 600;
  }
  .prompt-btn.confirm:hover {
    background: #7f1d1d;
    border-color: #7f1d1d;
  }
  .prompt-arrow {
    position: absolute;
    bottom: -7px;
    inset-inline-start: 50%;
    transform: translateX(-50%) rotate(45deg);
    width: 12px;
    height: 12px;
    background: white;
    border-inline-end: 1px solid var(--color-border-strong);
    border-bottom: 1px solid var(--color-border-strong);
  }
  @keyframes popIn {
    from {
      opacity: 0;
      transform: translateX(-50%) scale(0.94);
    }
    to {
      opacity: 1;
      transform: translateX(-50%) scale(1);
    }
  }
</style>
