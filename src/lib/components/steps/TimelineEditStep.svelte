<script lang="ts">
  import { untrack } from 'svelte';
  import { t } from '$lib/i18n/index.svelte';
  import { wizardState } from '$lib/wizard/state.svelte';
  import { setTrimRange, seedTrimRange } from '$lib/timeline/state';
  import { removedWithinTrim } from '$lib/timeline/overlap';
  import { deriveKeptRanges } from '$lib/timeline/derive-kept-ranges';
  import { planDuration } from '$lib/tauri/processing';
  import type { PlanDurationResult } from '$lib/types';
  import VideoPreview from '$lib/components/timeline/VideoPreview.svelte';
  import Timeline from '$lib/components/timeline/Timeline.svelte';
  import CutsSummary from '$lib/components/timeline/CutsSummary.svelte';
  import DurationReadout from '$lib/components/timeline/DurationReadout.svelte';
  import Transport from '$lib/components/timeline/Transport.svelte';
  import { installPlaybackEffect } from '$lib/timeline/playback.svelte';

  interface Props {
    onBack: () => void;
    onContinue: () => void;
  }

  let { onBack, onContinue }: Props = $props();

  // Seed the trim window on first entry (rune starts {0,0}). The decision —
  // "apply when empty" (end === 0) so returning from Save preserves the range,
  // and skip a degenerate (<= 0) probe duration — lives in the tested pure
  // seedTrimRange seam; the effect just commits its result.
  $effect(() => {
    const seed = seedTrimRange(wizardState);
    if (seed !== null) {
      setTrimRange(wizardState, seed);
    }
  });

  // Owns the RAF playback loop for the edit step (amendment §6.2). Scoped here so
  // leaving the step tears the loop down; play/pause buttons in the children just
  // toggle wizardState.playing, which this effect reacts to.
  installPlaybackEffect();

  const duration = $derived(wizardState.mediaInfo?.duration ?? 0);
  // True iff the file has a usable keyframe table (video stream, under MAX_KF) —
  // i.e. cuts snap to keyframes on export. Drives the keyframe-snap hint sentence.
  // !hasAudio is NOT a proxy — audio-only files have hasAudio:true; empty keyframes
  // is the signal (also covers over-MAX_KF video, where snapping is disabled).
  const canSnap = $derived((wizardState.mediaInfo?.keyframes.length ?? 0) > 0);
  // Union measure (overlapping cuts counted once) — cuts can legitimately
  // overlap when the user dismisses the merge prompt, so a naive per-cut sum
  // would double-count the shared span and under-report the Final duration.
  const removedSeconds = $derived(removedWithinTrim(wizardState.cuts, wizardState.trimRange));

  // DF-1: the FINAL readout must match the EXPORT, not raw arithmetic — and so
  // must the too-narrow gate. The export runs build_plan for EVERY file: snappable
  // files forward-snap cut boundaries (planned can differ from trim - cuts), and
  // non-snappable files (empty keyframe table) still DROP any kept span shorter
  // than MIN_CUT_DUR and abort SelectionTooNarrow if none survive — so "planned ==
  // raw" does NOT hold for them either (a sub-threshold sliver is silently
  // discarded). We therefore round-trip the kept ranges through the pure
  // `plan_duration` command (the real build_plan, no ffmpeg/IO) for all files,
  // debounced and generation-guarded. build_plan stays the single source of
  // truth; nothing here re-implements its snap/collapse rules.
  const keptRanges = $derived(deriveKeptRanges(wizardState.trimRange, wizardState.cuts));
  let plan: PlanDurationResult | null = $state(null);
  let computing = $state(false); // a recompute is in-flight → FINAL is "settling"
  let gen = 0;
  $effect(() => {
    void keptRanges; // track: re-run whenever the kept ranges change
    // Bump the generation on EVERY re-run (incl. the early-return below) so a
    // resolve from a prior in-flight round-trip can never clobber newer state —
    // e.g. a mediaInfo swap landing after `plan` was reset.
    const myGen = ++gen;
    if (!wizardState.mediaInfo) {
      plan = null;
      computing = false;
      return;
    }
    computing = true;
    // Drop a stale "too narrow" verdict immediately so a now-valid (widened)
    // selection never keeps showing a stale 0:00 through the debounce window.
    // untrack(): this effect WRITES `plan`, so a tracked read would self-trigger;
    // we deliberately read the snapshot. Other (positive) stale values stay
    // shown, dimmed, per the settle-stability design.
    if (untrack(() => plan)?.wouldBeTooNarrow) plan = null;
    const info = wizardState.mediaInfo;
    // `timer` (not `t`) — `t` is the imported i18n function in this module.
    const timer = setTimeout(() => {
      void planDuration(keptRanges, info.keyframes, info.duration)
        .then((r) => {
          if (myGen === gen) {
            plan = r; // drop stale resolves (generation guard)
            computing = false;
          }
        })
        .catch(() => {
          if (myGen === gen) {
            plan = null; // transparent fallback to raw arithmetic
            computing = false;
          }
        });
    }, 250);
    return () => {
      clearTimeout(timer);
    };
  });
  // Block Continue when the export would reject SelectionTooNarrow (the plan
  // collapsed to nothing), so a 0:00 readout is never a walk-into-failure. `plan`
  // carries the round-trip's authoritative verdict for every file type; it is null
  // only before the first plan settles, where we optimistically allow Continue —
  // the `computing` guard on the button itself covers that settling window.
  // ($derived.by, not $derived(expr): the macro form mis-narrows `plan` to `never`
  // under svelte-check; the explicit arrow type-checks cleanly.)
  const tooNarrow = $derived.by(() => plan?.wouldBeTooNarrow === true);
  const finalSeconds = $derived.by(() => {
    // When plan.wouldBeTooNarrow is true the backend guarantees plannedDuration
    // === 0 (build_plan / plan_duration), so the `plan ? plan.plannedDuration`
    // branch already yields 0 for the too-narrow case — no separate guard needed.
    const raw = Math.max(
      0,
      wizardState.trimRange.end - wizardState.trimRange.start - removedSeconds
    );
    return plan ? plan.plannedDuration : raw;
  });
</script>

<section class="step" data-step="timeline-edit">
  <div class="step-head">
    <h1>{t('edit.h1')}</h1>
    <p class="hint">
      {t('edit.hintBase')}{#if canSnap}{' '}{t('edit.hintKeyframes')}{/if}
    </p>
  </div>

  <VideoPreview />
  <Timeline />
  <CutsSummary count={wizardState.cuts.length} {removedSeconds} />
  <Transport />
  <DurationReadout original={duration} final={finalSeconds} {computing} />

  <div class="nav">
    <button type="button" class="rounded border px-4 py-2" onclick={onBack}>
      {t('wizard.actions.back')}
    </button>
    <!-- `computing` as well as `tooNarrow`: while the exact plan is still settling
         (FINAL value dimmed) the verdict is unknown, so block Continue rather than
         let a collapsing selection slip through the debounce window into a
         SelectionTooNarrow at export. The plan_duration round-trip now runs for
         EVERY file (the canSnap gate was dropped so non-snappable files get the
         too-narrow verdict too), so this brief mid-settle block applies to all of
         them — it lasts only the 250 ms debounce plus a pure-Rust IPC, after which
         the verdict lands and Continue re-enables (or stays blocked on tooNarrow). -->
    <button
      type="button"
      class="rounded bg-brand-700 px-4 py-2 text-white disabled:cursor-not-allowed disabled:opacity-50"
      disabled={tooNarrow || computing}
      onclick={onContinue}
    >
      {t('wizard.actions.continue')}
    </button>
  </div>
</section>

<style>
  /* Port .step, .step-head, .hint from app.css (gap layout + heading/hint type).
     Already logical — port verbatim. The nav reuses the existing wizard-chrome
     Tailwind utilities (px-N/py-N) for consistency with SaveStep. */
  .step {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .step-head {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .step-head h1 {
    font: 700 var(--text-xl) var(--font-sans);
    color: var(--color-text);
  }
  .hint {
    font-size: var(--text-sm);
    color: var(--color-text-body);
    line-height: 1.5;
  }
  .nav {
    display: flex;
    gap: 8px;
    margin-top: 8px;
  }
</style>
