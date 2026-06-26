<script lang="ts">
  import { t, type TranslationKey } from '$lib/i18n/index.svelte';
  import { processingState, requestCancel } from '$lib/wizard/processing.svelte';

  const R = 56;
  const C = 2 * Math.PI * R;

  const pct = $derived<number>(Math.round(processingState.fraction * 100));
  const dash = $derived<number>(C * (1 - processingState.fraction));
  const passKey = $derived<TranslationKey>(
    processingState.stage === 'finalizing'
      ? 'proc.pass.finalizing'
      : processingState.stage === 'concat'
        ? 'proc.pass.concat'
        : processingState.stage === 'segment'
          ? 'proc.pass.segment'
          : 'proc.pass.single'
  );
  const etaWhole = $derived<number | null>(
    processingState.etaSeconds === null ? null : Math.max(0, Math.round(processingState.etaSeconds))
  );
</script>

<section class="step" data-step="processing">
  <h1 class="text-2xl font-semibold">{t('proc.h1')}</h1>
  <p class="mt-2 text-gray-600">{t('proc.hint')}</p>

  <div class="mt-8 flex items-center gap-8">
    <div class="relative h-[140px] w-[140px]" data-testid="proc-ring">
      <svg width="140" height="140" viewBox="0 0 140 140" aria-hidden="true">
        <circle cx="70" cy="70" r={R} fill="none" stroke="#dbe3ff" stroke-width="10" />
        <circle
          cx="70"
          cy="70"
          r={R}
          fill="none"
          stroke="#2849D6"
          stroke-width="10"
          stroke-dasharray={C}
          stroke-dashoffset={dash}
          stroke-linecap="round"
          style="transition: stroke-dashoffset 0.15s linear; transform: rotate(-90deg); transform-origin: 70px 70px;"
        />
      </svg>
      <span
        class="absolute inset-0 flex items-center justify-center text-xl font-semibold"
        data-testid="proc-pct">{pct}%</span
      >
    </div>
    <div>
      <div class="font-medium" data-testid="proc-pass">{t(passKey)}</div>
      <!-- ETA omitted entirely while unknown (spec §5.3/N12): the bundle
           would render "About s remaining" with a hole. -->
      {#if etaWhole !== null}
        <div class="mt-1 text-gray-600" data-testid="proc-eta">
          {t('proc.eta')}{etaWhole}{t('proc.eta.s')}
        </div>
      {/if}
    </div>
  </div>

  <div class="mt-8">
    <!-- Calls requestCancel() ONLY — navigation follows the
         OperationCancelled rejection in WizardShell (spec §5.4/N1). -->
    <button
      type="button"
      class="rounded border px-4 py-2 text-gray-600 disabled:opacity-50"
      data-action="cancel-processing"
      disabled={processingState.cancelRequested}
      onclick={requestCancel}
    >
      {t('proc.cancel')}
    </button>
  </div>
</section>
