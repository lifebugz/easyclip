<script lang="ts">
  import { t, type TranslationKey } from '$lib/i18n/index.svelte';
  import { wizardState } from '$lib/wizard/state.svelte';
  import { pickMediaFile } from '$lib/tauri/dialog';
  import { probeMedia } from '$lib/tauri/probe';
  import { formatDuration } from '$lib/util/format-duration';
  import { pathStem, pathDirname } from '$lib/util/path';
  import { appErrorToKey, isAppError } from '$lib/util/app-error';
  import { isTextEntryTarget } from '$lib/util/dom';
  import type { MediaInfo } from '$lib/types';

  interface Props {
    onContinue: () => void;
  }

  let { onContinue }: Props = $props();

  // Local stage machine — phase-internal state that should not leak to
  // WizardState. Transitions:
  //   empty → probing      (on picker close with a chosen path)
  //   probing → probed     (on probeMedia resolve)
  //   probing → probe-error (on probeMedia reject)
  //   probed | probe-error → probing (on re-pick)
  //   probed → exits to timeline-edit (on user-clicked Continue)
  type Stage = 'empty' | 'probing' | 'probed' | 'probe-error';
  let stage: Stage = $state<Stage>('empty');

  // Local mirror of the resolved MediaInfo. We don't write WizardState
  // until the user confirms with Continue, so this stays local until then.
  let probed: MediaInfo | null = $state<MediaInfo | null>(null);

  // Probe-error i18n key. errorKey is a TranslationKey so typos fail at
  // compile time (P10-008 design lifted into Phase 5).
  let errorKey: TranslationKey | null = $state<TranslationKey | null>(null);

  // Single entry point for picking + probing. Calls the production-shaped
  // dialog + probe wrappers directly; Playwright mocks the underlying
  // `__TAURI_INTERNALS__.invoke` (see tests/e2e/helpers/tauri-mocks.ts)
  // so no test-aware indirection is needed in this component.
  async function pickAndProbe(): Promise<void> {
    // Reset error state on every fresh pick attempt.
    errorKey = null;

    const path = await pickMediaFile();
    if (path === null) {
      // User cancelled the picker — stay in the current stage. If the user
      // was already in `probed` or `probe-error`, the previous state is
      // preserved. Only `empty` stays `empty`.
      return;
    }

    stage = 'probing';
    try {
      const info = await probeMedia(path);
      probed = info;
      stage = 'probed';
    } catch (err: unknown) {
      probed = null;
      if (isAppError(err)) {
        errorKey = appErrorToKey(err);
      } else {
        errorKey = 'errors.unknown';
      }
      stage = 'probe-error';
    }
  }

  function confirmAndAdvance(): void {
    // Guard: only callable from `probed`. If somehow called otherwise,
    // silently no-op (defensive — should never happen).
    if (stage !== 'probed' || probed === null) return;

    // Write the MediaInfo and seed saveName/saveDir defaults per the
    // user-instruction scope. Phase 6's SaveStep $effect "apply defaults
    // when empty" will not fire because we've set non-empty defaults here.
    wizardState.mediaInfo = probed;
    wizardState.saveName = `${pathStem(probed.path)}-trimmed`;
    wizardState.saveDir = pathDirname(probed.path);

    // F2 guard (spec §2.0): a (re-)picked file must never inherit the
    // previous file's coordinates — Phase 9 turned stale trim/cuts from
    // cosmetic into a silently-wrong lossless cut. trimRange {0,0} re-arms
    // the editor's seedTrimRange; Back→Continue without re-picking skips
    // this function entirely, preserving "Back preserves trim work".
    wizardState.trimRange = { start: 0, end: 0 };
    wizardState.cuts = [];
    wizardState.playhead = 0;

    onContinue();
  }

  // Keyboard shortcut: Cmd+O on macOS, Ctrl+O elsewhere. Listening on the
  // step container so the shortcut only fires when the user is inside the
  // file-pick step (the wrapper element receives focus on step transitions).
  function handleKeydown(e: KeyboardEvent): void {
    // Avoid hijacking shortcuts when an input/textarea is focused.
    if (isTextEntryTarget(e.target)) return;

    const isCmdOrCtrl = e.metaKey || e.ctrlKey;
    if (isCmdOrCtrl && e.key.toLowerCase() === 'o') {
      e.preventDefault();
      void pickAndProbe();
    }
  }

  // Platform-aware shortcut copy. The string fields stay in the dictionary
  // so they can be localised. We pick one at render time.
  const shortcutLabel = $derived(
    typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac')
      ? t('pick.shortcut')
      : t('pick.shortcutWin')
  );
</script>

<svelte:window onkeydown={handleKeydown} />

<section class="step" data-step="file-pick">
  <h1 class="text-2xl font-semibold">{t('wizard.steps.file-pick.title')}</h1>
  <p class="mt-2 text-gray-600">{t('pick.hint')}</p>

  {#if stage === 'empty'}
    <div
      class="mt-6 flex flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed border-gray-300 bg-gray-50 px-8 py-12 text-center"
      data-stage="empty"
    >
      <!-- Decorative video-clip icon — drop target is visual only (real
           drag-and-drop is v2 per spec §14). -->
      <svg width="56" height="56" viewBox="0 0 56 56" fill="none" aria-hidden="true">
        <rect
          x="6"
          y="11"
          width="44"
          height="34"
          rx="4"
          class="fill-brand-50 stroke-brand-300"
          stroke-width="1.6"
        />
        <path d="M22 23 L34 30 L22 37 Z" class="fill-brand-600" />
        <line x1="6" y1="20" x2="50" y2="20" class="stroke-brand-200" stroke-width="1.4" />
      </svg>
      <button
        type="button"
        class="rounded bg-brand-700 px-6 py-3 text-base font-semibold text-white"
        onclick={() => {
          void pickAndProbe();
        }}
      >
        {t('pick.choose')}
      </button>
      <span class="text-sm text-gray-500">{t('pick.dropCue')}</span>
      <kbd class="mt-2 rounded border border-gray-300 bg-white px-2 py-1 text-xs text-gray-600"
        >{shortcutLabel}</kbd
      >
    </div>
  {:else if stage === 'probing'}
    <div
      class="mt-6 flex flex-col items-center justify-center gap-3 rounded-lg border border-gray-200 bg-gray-50 px-8 py-12 text-center"
      data-stage="probing"
      aria-live="polite"
    >
      <!-- A simple animated dot row — pure CSS, no JS animation budget. -->
      <span class="flex items-center gap-1" aria-hidden="true">
        <span class="h-2 w-2 animate-pulse rounded-full bg-brand-700"></span>
        <span class="h-2 w-2 animate-pulse rounded-full bg-brand-700 [animation-delay:150ms]"
        ></span>
        <span class="h-2 w-2 animate-pulse rounded-full bg-brand-700 [animation-delay:300ms]"
        ></span>
      </span>
      <span class="text-base text-gray-700">{t('pick.probing')}</span>
    </div>
  {:else if stage === 'probed' && probed !== null}
    <div class="mt-6 rounded-lg border border-gray-200 bg-white px-6 py-4" data-stage="probed">
      <h2 class="text-base font-semibold">{t('pick.info.heading')}</h2>
      <dl class="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
        <dt class="text-gray-500">{t('pick.info.duration')}</dt>
        <dd class="font-medium" data-field="duration">{formatDuration(probed.duration)}</dd>

        <dt class="text-gray-500">{t('pick.info.format')}</dt>
        <dd class="font-medium" data-field="container">{probed.container}</dd>

        {#if probed.codec}
          <dt class="text-gray-500">{t('pick.info.codec')}</dt>
          <dd class="font-medium" data-field="codec">{probed.codec}</dd>
        {/if}

        <dt class="text-gray-500">{t('pick.info.ext')}</dt>
        <dd class="font-medium" data-field="ext">{probed.ext}</dd>

        <dt class="text-gray-500">{t('pick.info.audio')}</dt>
        <dd class="font-medium" data-field="audio">
          {probed.hasAudio ? t('pick.info.audio.yes') : t('pick.info.audio.no')}
        </dd>
      </dl>
    </div>

    <div class="mt-6 flex items-center gap-4">
      <button
        type="button"
        class="rounded bg-brand-700 px-4 py-2 text-white"
        onclick={() => {
          confirmAndAdvance();
        }}
      >
        {t('wizard.actions.continue')}
      </button>
      <button
        type="button"
        class="text-sm text-gray-500 underline"
        onclick={() => {
          void pickAndProbe();
        }}
      >
        {t('pick.changeFile')}
      </button>
    </div>
  {:else if stage === 'probe-error'}
    <div
      class="mt-6 rounded-lg border border-red-200 bg-red-50 px-6 py-4"
      data-stage="probe-error"
      role="alert"
      aria-live="assertive"
    >
      <h2 class="text-base font-semibold text-red-800">{t('pick.error.heading')}</h2>
      {#if errorKey !== null}
        <p class="mt-2 text-sm text-red-800">{t(errorKey)}</p>
      {/if}
    </div>

    <div class="mt-6">
      <button
        type="button"
        class="rounded bg-brand-700 px-4 py-2 text-white"
        onclick={() => {
          void pickAndProbe();
        }}
      >
        {t('pick.changeFile')}
      </button>
    </div>
  {/if}
</section>
