<script lang="ts">
  import { tick } from 'svelte';
  import { t } from '$lib/i18n/index.svelte';
  import { wizardState, setStep, resetForStartOver, getOutputPath } from '$lib/wizard/state.svelte';
  import { nextStep, requiresConfirm, type WizardAction } from '$lib/wizard/navigate';
  import { playbackTransition } from '$lib/timeline/playback';
  import { reset as resetPlayback, pause as pausePlayback } from '$lib/timeline/playback.svelte';
  import { deriveKeptRanges } from '$lib/timeline/derive-kept-ranges';
  import { appErrorToKey, isAppError } from '$lib/util/app-error';
  import { startProcessing } from '$lib/wizard/processing.svelte';
  import StepIndicator from './StepIndicator.svelte';
  import ConfirmModal from './ConfirmModal.svelte';
  import FilePickStep from './steps/FilePickStep.svelte';
  import TimelineEditStep from './steps/TimelineEditStep.svelte';
  import SaveStep from './steps/SaveStep.svelte';
  import ProcessingStep from './steps/ProcessingStep.svelte';
  import DoneStep from './steps/DoneStep.svelte';
  import ErrorStep from './steps/ErrorStep.svelte';

  // The container that receives focus on step change. Each step renders its
  // own <section data-step="..."> with an <h1> inside; this wrapper exists
  // so the focus target is stable across step swaps.
  let stepEl: HTMLDivElement | null = $state<HTMLDivElement | null>(null);

  // Pending action awaiting confirm. When non-null, ConfirmModal is open and
  // the user is being asked whether to commit. null = no pending confirm.
  let pendingAction: { action: WizardAction; from: typeof wizardState.currentStep } | null =
    $state<{ action: WizardAction; from: typeof wizardState.currentStep } | null>(null);

  // Drive every nav request through the same path. Pure-fn lookup → destination
  // (or null = illegal, ignored). If the transition requires confirm, stash
  // and open modal. Otherwise commit and (for Start Over) reset state.
  function navigate(action: WizardAction): void {
    const from = wizardState.currentStep;
    const dest = nextStep(from, action);
    if (dest === null) return; // illegal pair — silent no-op

    if (requiresConfirm(from, action)) {
      pendingAction = { action, from };
      return;
    }

    commit(action, dest);
  }

  function commit(action: WizardAction, dest: typeof wizardState.currentStep): void {
    if (action === 'startOver') {
      resetForStartOver(); // zeroes playhead/playing too (resetAll)
      return;
    }
    // Apply the playback reset table (amendment §6.2) BEFORE the step swaps, so
    // the destination step mounts with the correct playhead/playing. `from` is the
    // current step (not yet changed). reset() reads trimRange.start.
    const move = playbackTransition(wizardState.currentStep, dest);
    if (move === 'reset') resetPlayback();
    else if (move === 'pause') pausePlayback();
    setStep(dest);
  }

  function confirmPending(): void {
    if (pendingAction === null) return;
    const { action, from } = pendingAction;
    const dest = nextStep(from, action);
    pendingAction = null;
    if (dest !== null) commit(action, dest);
  }

  function cancelPending(): void {
    pendingAction = null;
  }

  // Single processing launch path for startProcessing AND retry (spec §5.4).
  // navigate() commits synchronously BEFORE any result microtask can run, so
  // an instantly-rejecting invoke still finds currentStep === 'processing'
  // — this sequencing is a binding assumption (Q2); don't reorder.
  async function launchProcessing(action: 'startProcessing' | 'retry'): Promise<void> {
    const info = wizardState.mediaInfo;
    const output = getOutputPath();
    const keptRanges = deriveKeptRanges(wizardState.trimRange, wizardState.cuts);
    // Unreachable through the UI (SaveStep's canStart guards) — defensive.
    if (info === null || output === null || keptRanges.length === 0) return;

    navigate(action);
    try {
      await startProcessing({ input: info.path, output, keptRanges });
      navigate('success');
    } catch (err: unknown) {
      if (isAppError(err) && err.kind === 'OperationCancelled') {
        // PROC-05: editing state preserved; playback reset comes from the
        // existing playbackTransition table on the step swap.
        navigate('cancel');
        return;
      }
      // errorKey is freshly assigned on EVERY failure transition (N19).
      wizardState.errorKey = isAppError(err) ? appErrorToKey(err) : 'errors.unknown';
      wizardState.errorDetails = isAppError(err) ? err.details : String(err);
      // Diagnostic only — never rendered (PROC-04).
      console.error('process_media failed:', err);
      navigate('failure');
    }
  }

  // Focus the step container on every currentStep change. The browser's
  // default behavior would leave focus on the last-clicked button (which
  // may no longer exist after the step swap); explicitly focusing the
  // wrapping section ensures screen readers and keyboard users land
  // somewhere predictable. A11Y-02.
  $effect(() => {
    // Track currentStep so the effect re-runs on transitions.
    void wizardState.currentStep;
    // tick() resolves after Svelte commits the new step's DOM — the canonical
    // "focus after DOM update" idiom (replaces an incidental queueMicrotask).
    void tick().then(() => stepEl?.focus());
  });
</script>

<div class="mx-auto max-w-3xl px-6 py-8">
  <StepIndicator currentStep={wizardState.currentStep} />

  <div bind:this={stepEl} tabindex="-1" class="mt-8 focus:outline-none">
    {#if wizardState.currentStep === 'file-pick'}
      <FilePickStep
        onContinue={() => {
          navigate('continue');
        }}
      />
    {:else if wizardState.currentStep === 'timeline-edit'}
      <TimelineEditStep
        onBack={() => {
          navigate('back');
        }}
        onContinue={() => {
          navigate('continue');
        }}
      />
    {:else if wizardState.currentStep === 'save'}
      <SaveStep
        onBack={() => {
          navigate('back');
        }}
        onStartProcessing={() => {
          void launchProcessing('startProcessing');
        }}
      />
    {:else if wizardState.currentStep === 'processing'}
      <ProcessingStep />
    {:else if wizardState.currentStep === 'done'}
      <DoneStep
        onStartOver={() => {
          navigate('startOver');
        }}
      />
    {:else if wizardState.currentStep === 'error'}
      <ErrorStep
        onBack={() => {
          navigate('back');
        }}
        onRetry={() => {
          void launchProcessing('retry');
        }}
        onStartOver={() => {
          navigate('startOver');
        }}
      />
    {/if}
  </div>

  <!-- Start Over button: visible on non-terminal steps where it's allowed.
       (Per amendment §4.1: timeline-edit + save gate; done + error skip
       gate but route to a terminal Start Over that's handled inline by
       the step's own button — done/error don't show this top-level
       Start Over because the step's primary action already covers it.) -->
  {#if wizardState.currentStep === 'timeline-edit' || wizardState.currentStep === 'save'}
    <div class="mt-4 text-end">
      <button
        type="button"
        class="text-sm text-gray-500 underline"
        onclick={() => {
          navigate('startOver');
        }}
      >
        {t('wizard.actions.startOver')}
      </button>
    </div>
  {/if}
</div>

<ConfirmModal
  open={pendingAction !== null}
  titleKey="wizard.confirm.startOver.title"
  bodyKey="wizard.confirm.startOver.body"
  confirmKey="wizard.confirm.startOver.confirm"
  cancelKey="wizard.confirm.startOver.cancel"
  danger
  onConfirm={confirmPending}
  onCancel={cancelPending}
/>
