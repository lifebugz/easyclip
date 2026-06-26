<script lang="ts">
  import { t, type TranslationKey } from '$lib/i18n/index.svelte';
  import { openOutput, revealOutput } from '$lib/tauri/processing';
  import { formatDuration } from '$lib/util/format-duration';
  import { processingState } from '$lib/wizard/processing.svelte';

  interface Props {
    onStartOver: () => void;
  }

  let { onStartOver }: Props = $props();

  const result = $derived(processingState.result);
  const revealKey = $derived<TranslationKey>(
    typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac')
      ? 'done.reveal'
      : 'done.reveal.win'
  );

  function reveal(): void {
    if (result !== null) void revealOutput(result.outputPath);
  }
  function open(): void {
    if (result !== null) void openOutput(result.outputPath);
  }
</script>

<section class="step" data-step="done">
  <div
    class="flex h-12 w-12 items-center justify-center rounded-full bg-green-100 text-2xl text-green-700"
    aria-hidden="true"
  >
    ✓
  </div>
  <h1 class="mt-4 text-2xl font-semibold">{t('done.h1')}</h1>

  {#if result !== null}
    <p class="mt-2 text-gray-600">
      <span>{t('done.saved')}</span>
      <!-- Paths render LTR under RTL (Phase 8 F1 ruling; bundle ships dir="ltr"). -->
      <code class="rounded bg-gray-100 px-1" dir="ltr" data-testid="done-path"
        >{result.outputPath}</code
      >
    </p>

    <div class="mt-6 flex gap-4" data-testid="done-numbers">
      <div class="rounded border px-4 py-3">
        <span class="block text-sm text-gray-500">{t('done.final')}</span>
        <!-- Timecode pinned LTR (S14): an unpinned −12:30 reorders under RTL.
             The minus lives INSIDE the LTR span; formatDuration only ever
             receives a positive value (it returns an em-dash for negatives). -->
        <span class="text-lg font-semibold tabular-nums" dir="ltr" data-testid="done-final"
          >{formatDuration(result.finalDuration)}</span
        >
      </div>
      <div class="rounded border px-4 py-3">
        <span class="block text-sm text-gray-500">{t('done.removed')}</span>
        <span class="text-lg font-semibold tabular-nums" dir="ltr" data-testid="done-removed"
          >{'−'}{formatDuration(result.removedDuration)}</span
        >
      </div>
    </div>
  {/if}

  <div class="mt-8 flex gap-2">
    <button type="button" class="rounded border px-4 py-2" data-action="reveal" onclick={reveal}>
      {t(revealKey)}
    </button>
    <button type="button" class="rounded border px-4 py-2" data-action="open" onclick={open}>
      {t('done.open')}
    </button>
    <button
      type="button"
      class="rounded bg-brand-700 px-4 py-2 text-white"
      data-action="trim-another"
      onclick={onStartOver}
    >
      {t('done.again')}
    </button>
  </div>
</section>
