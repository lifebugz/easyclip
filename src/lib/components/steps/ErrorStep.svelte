<script lang="ts">
  import { t } from '$lib/i18n/index.svelte';
  import { wizardState } from '$lib/wizard/state.svelte';

  interface Props {
    onBack: () => void;
    onRetry: () => void;
    onStartOver: () => void;
  }

  let { onBack, onRetry, onStartOver }: Props = $props();

  // errorKey is TranslationKey | null and freshly assigned on every failure
  // transition (spec §5.4/N19); the fallback guards future entry paths.
  const messageKey = $derived(wizardState.errorKey ?? 'errors.unknown');
</script>

<section class="step" data-step="error" role="status" aria-live="assertive">
  <div
    class="flex h-12 w-12 items-center justify-center rounded-full bg-red-100 text-2xl text-red-700"
    aria-hidden="true"
  >
    {/* i18n-exempt */ '!'}
  </div>
  <h1 class="mt-4 text-2xl font-semibold">{t('err.h1')}</h1>
  <p class="mt-2 text-gray-600" data-testid="error-message">{t(messageKey)}</p>

  <div class="mt-6 flex gap-2">
    <button type="button" class="rounded border px-4 py-2" data-action="back" onclick={onBack}>
      {t('wizard.actions.back')}
    </button>
    <button
      type="button"
      class="rounded border px-4 py-2"
      data-action="start-over"
      onclick={onStartOver}
    >
      {t('wizard.actions.startOver')}
    </button>
    <button
      type="button"
      class="rounded bg-brand-700 px-4 py-2 text-white"
      data-action="retry"
      onclick={onRetry}
    >
      {t('wizard.actions.retry')}
    </button>
  </div>
</section>
