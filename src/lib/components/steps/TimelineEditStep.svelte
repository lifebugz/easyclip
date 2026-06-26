<script lang="ts">
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
  // True iff the file has a usable keyframe table (video stream, under MAX_KF).
  // Drives the keyframe hint (here) and DF-1's plan_duration round-trip (Commit 6).
  // !hasAudio is NOT a proxy — audio-only files have hasAudio:true; empty keyframes
  // is the signal (also covers over-MAX_KF video, where snapping is disabled).
  const canSnap = $derived((wizardState.mediaInfo?.keyframes.length ?? 0) > 0);
  // Union measure (overlapping cuts counted once) — cuts can legitimately
  // overlap when the user dismisses the merge prompt, so a naive per-cut sum
  // would double-count the shared span and under-report the Final duration.
  const removedSeconds = $derived(removedWithinTrim(wizardState.cuts, wizardState.trimRange));

  // DF-1: the FINAL readout must match the EXPORT, not raw arithmetic. For
  // keyframe-snappable files the export forward-snaps cut boundaries, so the
  // true planned length can differ from (trim - cuts). We round-trip the kept
  // ranges through the pure `plan_duration` command (the real build_plan, no
  // ffmpeg/IO) — debounced, generation-guarded, and gated on `canSnap` so a
  // file with no usable keyframe table (audio-only / over-MAX_KF) never pays
  // for a round-trip that would be a no-op (planned == raw).
  const keptRanges = $derived(deriveKeptRanges(wizardState.trimRange, wizardState.cuts));
  let plan: PlanDurationResult | null = $state(null);
  let computing = $state(false); // a recompute is in-flight on a snappable file → "settling"
  let gen = 0;
  $effect(() => {
    void keptRanges; // track: re-run whenever the kept ranges change
    if (!wizardState.mediaInfo) return;
    // No keyframes → export does no snapping → exact == raw; skip the round-trip.
    if (!canSnap) {
      plan = null;
      computing = false;
      return;
    }
    const myGen = ++gen;
    computing = true;
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
  const finalSeconds = $derived.by(() => {
    const raw = Math.max(
      0,
      wizardState.trimRange.end - wizardState.trimRange.start - removedSeconds
    );
    return plan ? (plan.wouldBeTooNarrow ? 0 : plan.plannedDuration) : raw;
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
    <button type="button" class="rounded bg-brand-700 px-4 py-2 text-white" onclick={onContinue}>
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
