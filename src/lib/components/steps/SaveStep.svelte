<script lang="ts">
  import { t, type TranslationKey } from '$lib/i18n/index.svelte';
  import { getOutputPath, wizardState } from '$lib/wizard/state.svelte';
  import { pickFolder } from '$lib/tauri/dialog';
  import { pathStem, pathDirname } from '$lib/util/path';
  import { validateSaveName, validateSaveDir } from '$lib/util/validate-output';
  import { deriveKeptRanges } from '$lib/timeline/derive-kept-ranges';

  interface Props {
    onBack: () => void;
    onStartProcessing: () => void;
  }

  let { onBack, onStartProcessing }: Props = $props();

  // Safety-net default seeder. Phase 5 already seeds saveName + saveDir
  // on user-clicked Continue from FilePickStep, so for the normal entry path
  // this $effect is a no-op (runes are non-empty). It only fires when:
  //   - the user clears a field with backspace and navigates away + back, OR
  //   - some future code path resets a rune to '' without touching mediaInfo, OR
  //   - the Phase 5 seeding logic ever regresses (belt-and-braces).
  // Reads mediaInfo / saveName / saveDir → Svelte tracks them and re-runs the
  // effect on relevant changes. The branch into the write is guarded so the
  // effect never overwrites a user-typed non-empty value.
  $effect(() => {
    const info = wizardState.mediaInfo;
    if (info === null) return;
    if (wizardState.saveName === '') {
      wizardState.saveName = `${pathStem(info.path)}-trimmed`;
    }
    if (wizardState.saveDir === '') {
      wizardState.saveDir = pathDirname(info.path);
    }
  });

  // Inline validation. Both helpers return a TranslationKey on rejection or
  // null on accept. The component reads each through a $derived getter so
  // changes to the underlying runes invalidate the cached value automatically.
  const nameError = $derived<TranslationKey | null>(validateSaveName(wizardState.saveName));
  const dirError = $derived<TranslationKey | null>(validateSaveDir(wizardState.saveDir));

  // Composed output path. getOutputPath reads mediaInfo + saveName + saveDir
  // from wizardState; $derived tracks all three. Returns null when any input
  // is empty (after normalisation) or when mediaInfo is null.
  const outputPath = $derived<string | null>(getOutputPath());

  const hasKeptRanges = $derived<boolean>(
    deriveKeptRanges(wizardState.trimRange, wizardState.cuts).length > 0
  );

  // Frontend mirror of validate_output_path's output==input rejection
  // (spec §7.3). Case-insensitive string compare — best-effort instant
  // feedback; the canonicalizing Rust check is the security boundary.
  const sameAsInputError = $derived<TranslationKey | null>(
    outputPath !== null &&
      wizardState.mediaInfo !== null &&
      outputPath.toLowerCase() === wizardState.mediaInfo.path.toLowerCase()
      ? 'save.error.same_as_input'
      : null
  );

  // The Start-processing button is enabled iff:
  //   - mediaInfo is set (we have a file)
  //   - both name and location are valid (no errors)
  //   - outputPath composes to a non-null value
  //   - output path is not the same as the input file
  //   - at least one range of audio/video is kept (non-empty selection)
  // The combination guards against edge cases: an input that's valid in
  // isolation but composes to null (e.g., saveName = ".mp4" → after strip
  // becomes empty).
  const canStart = $derived<boolean>(
    wizardState.mediaInfo !== null &&
      nameError === null &&
      dirError === null &&
      sameAsInputError === null &&
      outputPath !== null &&
      hasKeptRanges
  );

  // The format card shows the canonical extension uppercased ("MP4") plus the
  // codec from mediaInfo (when set). Both are read defensively because the
  // form could theoretically render before mediaInfo is populated (the
  // WizardShell only mounts SaveStep when currentStep === 'save', and
  // entering 'save' implies mediaInfo is set, but a defensive null check
  // avoids a runtime crash if that invariant ever breaks).
  const formatLabel = $derived<string>(
    wizardState.mediaInfo === null ? '' : wizardState.mediaInfo.ext.toUpperCase()
  );

  async function chooseFolder(): Promise<void> {
    const dir = await pickFolder();
    if (dir === null) return; // user cancelled — preserve current saveDir
    wizardState.saveDir = dir;
  }
</script>

<section class="step" data-step="save">
  <h1 class="text-2xl font-semibold">{t('wizard.steps.save.title')}</h1>
  <p class="mt-2 text-gray-600">{t('save.hint')}</p>

  <div class="mt-6 flex flex-col gap-4">
    <!-- Filename row -->
    <label class="flex flex-col gap-1" data-field="filename">
      <span class="text-sm font-medium text-gray-700">{t('save.filename')}</span>
      <div class="flex items-stretch gap-2">
        <input
          type="text"
          class="flex-1 rounded border border-gray-300 px-3 py-2 text-base"
          dir="ltr"
          autocapitalize="none"
          autocorrect="off"
          spellcheck="false"
          bind:value={wizardState.saveName}
          aria-invalid={nameError !== null}
          aria-describedby={nameError !== null ? 'save-name-error' : undefined}
          data-input="filename"
        />
        <span
          class="flex items-center rounded bg-gray-100 px-3 py-2 text-sm font-mono text-gray-700"
          aria-hidden="true"
          data-pill="ext"
          >{'.'}{wizardState.mediaInfo === null ? '' : wizardState.mediaInfo.ext}</span
        >
      </div>
      {#if nameError !== null}
        <span class="text-sm text-red-700" id="save-name-error" role="alert">{t(nameError)}</span>
      {/if}
    </label>

    <!-- Location row -->
    <label class="flex flex-col gap-1" data-field="location">
      <span class="text-sm font-medium text-gray-700">{t('save.location')}</span>
      <div class="flex items-stretch gap-2">
        <input
          type="text"
          class="flex-1 rounded border border-gray-300 px-3 py-2 text-base"
          dir="ltr"
          autocapitalize="none"
          autocorrect="off"
          spellcheck="false"
          bind:value={wizardState.saveDir}
          aria-invalid={dirError !== null}
          aria-describedby={dirError !== null ? 'save-dir-error' : undefined}
          data-input="location"
        />
        <button
          type="button"
          class="rounded border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700"
          onclick={() => {
            void chooseFolder();
          }}
          data-action="choose-folder"
        >
          {t('save.choose')}
        </button>
      </div>
      {#if dirError !== null}
        <span class="text-sm text-red-700" id="save-dir-error" role="alert">{t(dirError)}</span>
      {/if}
    </label>

    {#if sameAsInputError !== null}
      <span class="text-sm text-red-700" id="save-same-error" role="alert">
        {t(sameAsInputError)}
      </span>
    {/if}

    <!-- Format card -->
    <div class="flex flex-col gap-1" data-field="format">
      <span class="text-sm font-medium text-gray-700">{t('save.format')}</span>
      <div
        class="flex items-center justify-between rounded-lg border border-gray-200 bg-gray-50 px-4 py-3"
        data-card="format"
      >
        <span class="text-base font-semibold text-gray-800" data-field-value="ext"
          >{formatLabel}</span
        >
        <span class="text-sm text-gray-500" data-field-value="locked">{t('save.locked')}</span>
      </div>
    </div>
  </div>

  <div class="mt-8 flex items-center gap-3">
    <button
      type="button"
      class="rounded border border-gray-300 bg-white px-4 py-2 text-gray-700"
      onclick={() => {
        onBack();
      }}
    >
      {t('save.back')}
    </button>
    <button
      type="button"
      class="rounded bg-brand-700 px-4 py-2 text-white disabled:cursor-not-allowed disabled:bg-gray-300"
      disabled={!canStart}
      onclick={() => {
        onStartProcessing();
      }}
      data-action="start-processing"
    >
      {t('save.start')}
    </button>
  </div>
</section>
