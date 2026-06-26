<script lang="ts">
  import { t } from '$lib/i18n/index.svelte';
  import type { WizardStep } from '$lib/wizard/state.svelte';

  interface Props {
    currentStep: WizardStep;
  }

  let { currentStep }: Props = $props();

  // Five visible dots — error remains an overlay and maps onto file-pick
  // for indicator-highlight purposes (amendment §4.2).
  const STEPS = ['file-pick', 'timeline-edit', 'save', 'processing', 'done'] as const;
  type IndicatorStep = (typeof STEPS)[number];

  function effectiveStep(s: WizardStep): IndicatorStep {
    return s === 'error' ? 'file-pick' : s;
  }

  const activeIndex = $derived(STEPS.indexOf(effectiveStep(currentStep)));

  function stateAt(i: number): 'done' | 'active' | 'future' {
    if (i < activeIndex) return 'done';
    if (i === activeIndex) return 'active';
    return 'future';
  }

  function labelKey(s: IndicatorStep): import('$lib/i18n/index.svelte').TranslationKey {
    return `wizard.indicator.label.${s}` as const;
  }
</script>

<ol class="flex items-center gap-3" role="list" aria-label={t('wizard.indicator.aria')}>
  {#each STEPS as step, i (step)}
    {@const s = stateAt(i)}
    <li class="flex items-center gap-2" aria-current={s === 'active' ? 'step' : undefined}>
      <span
        class={[
          'flex h-7 w-7 items-center justify-center rounded-full border text-sm font-semibold',
          s === 'done' && 'border-brand-700 bg-brand-700 text-white',
          s === 'active' &&
            'border-brand-700 bg-brand-700 text-white shadow-[0_0_0_4px_color-mix(in_oklch,var(--color-brand-700)_16%,transparent)]',
          s === 'future' && 'border-gray-300 text-gray-400'
        ]}
        aria-hidden="true"
      >
        {s === 'done' ? '✓' : i + 1}
      </span>
      <span
        class={[
          'text-sm',
          s === 'done' && 'text-brand-700',
          s === 'active' && 'font-semibold text-brand-700',
          s === 'future' && 'text-gray-400'
        ]}
      >
        {t(labelKey(step))}
      </span>
      {#if i < STEPS.length - 1}
        <span class={['h-px w-6', s === 'done' ? 'bg-brand-700' : 'bg-gray-300']} aria-hidden="true"
        ></span>
      {/if}
    </li>
  {/each}
</ol>
