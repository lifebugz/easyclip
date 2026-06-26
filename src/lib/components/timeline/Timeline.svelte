<script lang="ts">
  import { onDestroy, tick } from 'svelte';
  import { t } from '$lib/i18n/index.svelte';
  import { wizardState } from '$lib/wizard/state.svelte';
  import { timeToPct, xToTime } from '$lib/timeline/coord';
  import { CUT_DRAG_THRESH_PX, MIN_TRIM_DUR, SNAP_PX } from '$lib/timeline/constants';
  import { snapToKeyframe } from '$lib/timeline/snap';
  import { pause as pausePlayback } from '$lib/timeline/playback.svelte';
  import { clampToTrim, findOverlapping } from '$lib/timeline/overlap';
  import {
    proposeCut,
    commitCut,
    commitMerge,
    proposeCutEdit,
    deleteCut,
    setTrimRange
  } from '$lib/timeline/state';
  import TimeRuler from './TimeRuler.svelte';
  import SideAnchor from './SideAnchor.svelte';
  import CutRegion from './CutRegion.svelte';
  import AnchorTip from './AnchorTip.svelte';
  import MergePrompt from './MergePrompt.svelte';
  import SnapBadge from './SnapBadge.svelte';
  import Playhead from './Playhead.svelte';
  import WaveformOverlay from './WaveformOverlay.svelte';
  import { seedToWaveBars } from '$lib/timeline/waveform-seed';

  let trackEl = $state<HTMLDivElement | null>(null);
  let hoverPct = $state<number | null>(null);
  let pendingCut = $state<{ start: number; end: number } | null>(null);
  let anchorTip = $state<{ pct: number; seconds: number } | null>(null);
  let mergePrompt = $state<{ aId: string; bId: string; midPct: number } | null>(null);
  // Cancel fn for the in-flight gesture; Escape calls it to revert + tear down.
  let activeCancel: (() => void) | null = $state(null);

  // Snap badge position (percent of clip), or null when not snapped. Deduped at
  // the source: lastSnappedIndex tracks the engaged keyframe so the badge state is
  // only touched on an index change (or an on/off transition), never once per
  // pointermove tick — keeping the aria-live region quiet during a drag (§6.1).
  let snapBadge = $state<{ pct: number } | null>(null);
  let lastSnappedIndex = -1;

  const duration = $derived(wizardState.mediaInfo?.duration ?? 0);
  const hasAudio = $derived(wizardState.mediaInfo?.hasAudio ?? false);
  const mediaPath = $derived(wizardState.mediaInfo?.path ?? '');
  // 64-bin decorative waveform (§6.3). Empty when no audio / no path → nothing renders.
  const waveBars = $derived(hasAudio && mediaPath !== '' ? seedToWaveBars(mediaPath, 64) : []);
  // Keyframes for snapping. snapToKeyframe binary-searches, so it requires ascending
  // order. The Rust probe emits keyframe packets in ffprobe order and does NOT sort
  // (parse_keyframes_packets), so sort defensively here — once per file load, not per
  // pointermove tick — to guarantee the invariant the search depends on.
  const sortedKeyframes = $derived(
    [...(wizardState.mediaInfo?.keyframes ?? [])].sort((a, b) => a - b)
  );

  // If the step unmounts mid-drag (e.g. a programmatic navigation while a pointer
  // is still down), cancel the in-flight gesture so its window-level pointer
  // listeners are removed instead of leaking and mutating a detached wizardState.
  // No-op when no gesture is active (activeCancel is null).
  onDestroy(() => {
    activeCancel?.();
  });

  function trackRect(): DOMRect | null {
    return trackEl?.getBoundingClientRect() ?? null;
  }

  function pxToTime(clientX: number): number {
    const r = trackRect();
    if (r === null) return 0;
    return xToTime(clientX, { x: r.x, width: r.width }, duration);
  }

  // Snap a pointer clientX to the nearest keyframe within SNAP_PX worth of seconds.
  // radius = SNAP_PX * (duration / trackWidth). Returns the raw time unchanged when
  // there is no track rect, a zero-width track, a degenerate (<= 0) duration, or no
  // keyframes (empty list = snap disabled). Reads the track rect once (the hot
  // pointermove path) instead of via pxToTime + a second getBoundingClientRect.
  function snapAt(clientX: number): { time: number; snapped: boolean; index: number } {
    const r = trackRect();
    if (r === null || r.width <= 0 || duration <= 0) {
      return { time: pxToTime(clientX), snapped: false, index: -1 };
    }
    const raw = xToTime(clientX, { x: r.x, width: r.width }, duration);
    const secPerPx = duration / r.width;
    return snapToKeyframe(raw, sortedKeyframes, SNAP_PX * secPerPx);
  }

  // `applied` is the edge value the handler actually committed for this tick (after
  // its MIN_TRIM_DUR / MIN_CUT_DUR / trim clamping). Treat the snap as engaged only
  // when that value still equals the keyframe — otherwise clamping pulled the edge
  // off the keyframe, so it isn't snapped. Position the badge at `applied` (same
  // basis as AnchorTip) and dedupe on the keyframe index so the aria-live region
  // isn't touched on every pointermove tick.
  function updateSnapBadge(
    snap: { time: number; snapped: boolean; index: number },
    applied: number
  ): void {
    if (snap.snapped && applied === snap.time) {
      if (snap.index !== lastSnappedIndex) {
        lastSnappedIndex = snap.index;
        snapBadge = { pct: timeToPct(applied, duration) };
      }
    } else if (lastSnappedIndex !== -1 || snapBadge !== null) {
      lastSnappedIndex = -1;
      snapBadge = null;
    }
  }

  function detectOverlap(): void {
    const pair = findOverlapping(wizardState.cuts);
    if (pair === null) {
      mergePrompt = null;
      return;
    }
    const mid = (Math.max(pair.a.start, pair.b.start) + Math.min(pair.a.end, pair.b.end)) / 2;
    mergePrompt = { aId: pair.a.id, bId: pair.b.id, midPct: timeToPct(mid, duration) };
  }

  // Shared gesture lifecycle for all three pointer drags. Wires the window
  // pointermove / pointerup / pointercancel listeners plus the Escape hook
  // (activeCancel), and tears them ALL down on every terminal path. onCommit runs
  // on a clean pointerup; onCancel runs on Escape OR pointercancel — the OS/WebView
  // preempting the pointer (touch interruption, system gesture) must revert the
  // in-progress mutation exactly like Escape, never commit a half-finished gesture.
  //
  // All terminal listeners are scoped to `pointerId` (captured from the arming
  // pointerdown): the activeCancel re-entrancy guard only blocks a SECOND gesture
  // from STARTING, so without this scope a FOREIGN pointer's up/cancel (a second
  // finger lifting) would fire this gesture's handlers and commit it at a
  // half-dragged value. Escape/onDestroy invoke `revert` directly (no event), so
  // they remain unconditional.
  function beginGesture(
    pointerId: number,
    handlers: {
      onMove: (ev: PointerEvent) => void;
      onCommit?: () => void;
      onCancel?: () => void;
    }
  ): void {
    // Interacting with the timeline stops playback (standard editor behaviour).
    // This also prevents the RAF loop from fighting the drag: it would otherwise
    // write playhead each frame while setTrimRange clamps it (jitter), and make
    // the anchor-drag's playhead snapshot stale for the Escape/cancel restore.
    pausePlayback();
    const teardown = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', onPointerCancel);
      anchorTip = null;
      snapBadge = null;
      lastSnappedIndex = -1;
      activeCancel = null;
    };
    const move = (ev: PointerEvent): void => {
      if (ev.pointerId !== pointerId) return;
      handlers.onMove(ev);
    };
    const up = (ev: PointerEvent): void => {
      if (ev.pointerId !== pointerId) return;
      teardown();
      handlers.onCommit?.();
    };
    const revert = (): void => {
      handlers.onCancel?.();
      teardown();
    };
    const onPointerCancel = (ev: PointerEvent): void => {
      if (ev.pointerId !== pointerId) return;
      revert();
    };
    activeCancel = revert;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', onPointerCancel);
  }

  // ── anchor (head/tail) drag ──
  function startAnchorDrag(which: 'start' | 'end', e: PointerEvent): void {
    if (activeCancel !== null) return; // a gesture is already in flight — ignore a 2nd pointer
    if (e.button !== 0) return; // primary button only (right/middle must not drag)
    e.preventDefault();
    e.stopPropagation();
    const snapshot = { ...wizardState.trimRange };
    const playheadSnapshot = wizardState.playhead; // setTrimRange may nudge it; restore on cancel
    beginGesture(e.pointerId, {
      onMove: (ev) => {
        const snap = snapAt(ev.clientX); // Phase 8: live snap to keyframe
        const time = snap.time;
        if (which === 'start') {
          const next = Math.max(0, Math.min(time, wizardState.trimRange.end - MIN_TRIM_DUR));
          setTrimRange(wizardState, { start: next, end: wizardState.trimRange.end });
          updateSnapBadge(snap, wizardState.trimRange.start);
          anchorTip = {
            pct: timeToPct(wizardState.trimRange.start, duration),
            seconds: wizardState.trimRange.start
          };
        } else {
          const next = Math.min(
            duration,
            Math.max(time, wizardState.trimRange.start + MIN_TRIM_DUR)
          );
          setTrimRange(wizardState, { start: wizardState.trimRange.start, end: next });
          updateSnapBadge(snap, wizardState.trimRange.end);
          anchorTip = {
            pct: timeToPct(wizardState.trimRange.end, duration),
            seconds: wizardState.trimRange.end
          };
        }
      },
      onCancel: () => {
        wizardState.trimRange = snapshot;
        wizardState.playhead = playheadSnapshot;
      }
    });
  }

  // ── cut-handle (resize existing cut) drag ──
  function startCutHandleDrag(cutId: string, edge: 'start' | 'end', e: PointerEvent): void {
    if (activeCancel !== null) return; // a gesture is already in flight — ignore a 2nd pointer
    if (e.button !== 0) return; // primary button only (right/middle must not resize)
    e.preventDefault();
    e.stopPropagation();
    const snapshot = wizardState.cuts.map((c) => ({ ...c }));
    beginGesture(e.pointerId, {
      onMove: (ev) => {
        const snap = snapAt(ev.clientX); // Phase 8: live snap to keyframe
        proposeCutEdit(wizardState, cutId, edge, snap.time);
        const c = wizardState.cuts.find((x) => x.id === cutId);
        if (c !== undefined) {
          const v = edge === 'start' ? c.start : c.end;
          updateSnapBadge(snap, v);
          anchorTip = { pct: timeToPct(v, duration), seconds: v };
        }
      },
      onCommit: () => {
        detectOverlap();
      },
      onCancel: () => {
        wizardState.cuts = snapshot;
      }
    });
  }

  let pendingFocusId: string | null = $state(null);
  // Focus a freshly-committed cut's delete button so keyboard Delete works
  // immediately (matches the :focus-within reveal). After tick() (DOM commit),
  // bail if a new gesture armed or this focus was superseded. DF-2.
  function focusNewCut(id: string): void {
    pendingFocusId = id;
    void tick().then(() => {
      if (activeCancel !== null || pendingFocusId !== id) return;
      const btn = document.querySelector<HTMLButtonElement>(
        `.cut-region[data-cut-id="${CSS.escape(id)}"] .cut-x`
      );
      btn?.focus();
      pendingFocusId = null;
    });
  }

  // ── empty-band drag → create new cut ──
  function startEmptyDrag(e: PointerEvent): void {
    if (activeCancel !== null) return; // a gesture is already in flight — ignore a 2nd pointer
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest('.cut-region, .cut-handle, .side-anchor, .merge-prompt') !== null) return;
    const startXpx = e.clientX;
    // Gate "did the press land inside the kept band?" on the RAW pointer time.
    // Snapping first could lock onto a keyframe just OUTSIDE the trim window (within
    // the snap radius) and wrongly reject a press that was actually inside the band.
    const rawStartT = pxToTime(startXpx);
    if (rawStartT < wizardState.trimRange.start || rawStartT > wizardState.trimRange.end) return;
    const startT = snapAt(startXpx).time; // snap the anchored start (no badge); clamped in onMove
    e.preventDefault();
    let committed = false;
    beginGesture(e.pointerId, {
      onMove: (ev) => {
        if (!committed && Math.abs(ev.clientX - startXpx) < CUT_DRAG_THRESH_PX) return;
        committed = true;
        const endSnap = snapAt(ev.clientX); // Phase 8: live snap the moving end
        const endT = endSnap.time;
        const a = clampToTrim(Math.min(startT, endT), wizardState.trimRange);
        const b = clampToTrim(Math.max(startT, endT), wizardState.trimRange);
        pendingCut = { start: a, end: b };
        // Badge tracks the moving end (the pointer), clamped into the trim window.
        updateSnapBadge(endSnap, clampToTrim(endT, wizardState.trimRange));
        anchorTip = { pct: timeToPct(b, duration), seconds: b };
      },
      onCommit: () => {
        const pc = pendingCut;
        pendingCut = null;
        if (committed && pc !== null) {
          const result = proposeCut(wizardState, pc);
          if (result.kind === 'commit') {
            const newCut = commitCut(wizardState, result.range);
            focusNewCut(newCut.id); // Delete works immediately, no Tab
          } else if (result.kind === 'merge') {
            commitCut(wizardState, result.range);
            detectOverlap(); // raises MergePrompt, which self-focuses (Task 7)
          }
          // reject → silently discard (too short)
        }
      },
      onCancel: () => {
        pendingCut = null;
      }
    });
  }

  // ── hover cue (empty kept band only) ──
  function onTrackMove(e: MouseEvent): void {
    // Suppress the hover-cue during ANY in-flight gesture. anchor/cut-handle
    // drags set anchorTip but never pendingCut, so gate on activeCancel (the
    // single in-flight flag) rather than pendingCut alone.
    if (activeCancel !== null) {
      hoverPct = null;
      return;
    }
    const r = trackRect();
    if (r === null) return;
    const target = e.target as HTMLElement;
    if (target.closest('.cut-region, .cut-handle, .side-anchor') !== null) {
      hoverPct = null;
      return;
    }
    const x = e.clientX - r.x;
    if (x < 0 || x > r.width) {
      hoverPct = null;
      return;
    }
    const tSec = xToTime(e.clientX, { x: r.x, width: r.width }, duration);
    if (tSec < wizardState.trimRange.start || tSec > wizardState.trimRange.end) {
      hoverPct = null;
      return;
    }
    hoverPct = timeToPct(tSec, duration);
  }

  function onTrackLeave(): void {
    hoverPct = null;
  }

  function acceptMerge(): void {
    if (mergePrompt === null) return;
    commitMerge(wizardState, mergePrompt.aId, mergePrompt.bId);
    // Clear, do NOT re-detect (design spec §"after any commit/resize"; the bundle's
    // acceptMerge clears too). Re-detecting here would re-raise an UNRELATED overlap
    // the user already kept separate. A residual overlap among 3+ cuts is surfaced
    // on the next create/resize commit, like every other overlap.
    mergePrompt = null;
  }

  function dismissMerge(): void {
    mergePrompt = null;
  }

  function handleKeydown(e: KeyboardEvent): void {
    const target = e.target as HTMLElement | null;
    if (target !== null && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
    // Ignore keyboard delete while a pointer gesture is in flight (symmetric with
    // the Escape path below): otherwise a mid-resize Delete on a focused cut would
    // mutate cuts under the gesture and then be silently undone by its snapshot.
    if (activeCancel !== null) return;
    // Escape is intentionally NOT handled here — see handleKeyup below.
    if (e.key === 'Delete' || e.key === 'Backspace') {
      const region = target?.closest('.cut-region') as HTMLElement | null;
      const id = region?.dataset['cutId'];
      if (id !== undefined && id !== '') {
        e.preventDefault(); // also kills WebKit history-back on Backspace
        deleteCut(wizardState, id);
        mergePrompt = null;
      }
    }
  }

  // Escape cancels an in-flight gesture / dismisses the merge prompt. It is handled
  // on KEYUP, not keydown: macOS WKWebView consumes the Escape keydown natively
  // (cancelOperation:) before any JS listener — window AND document-capture keydown
  // both never fire for Escape, while every other key does — but the keyup still
  // reaches web content. Verified in the real Tauri release build (2026-05-31).
  // Chromium fires both keydown and keyup, so the Playwright "Escape cancels a
  // create drag" spec (keyboard.press dispatches keyup too) still covers this path.
  // Delete/Backspace stay on keydown: their preventDefault must run on keydown to
  // suppress WebKit history-back, and they read the focused .cut-region target.
  function handleKeyup(e: KeyboardEvent): void {
    if (e.key !== 'Escape') return;
    const target = e.target as HTMLElement | null;
    if (target !== null && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
    // A ConfirmModal (native <dialog showModal()>) owns Escape while open: stand
    // down so one Escape doesn't also cancel a gesture / dismiss the merge prompt
    // behind the modal. In WKWebView the dialog is still [open] at keyup time (it
    // closes a tick later via its open-prop effect), so this guard fires exactly
    // when the invariant needs it. §11 mutual-exclusion.
    if (document.querySelector('dialog[open]') !== null) return;
    if (activeCancel !== null) {
      activeCancel();
      return;
    }
    if (mergePrompt !== null) {
      mergePrompt = null;
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} onkeyup={handleKeyup} />

<div class="timeline-wrap">
  <TimeRuler {duration} />

  <!-- The track is a pointer-driven readout (role=slider was dropped per design
       review). Keyboard cut-creation + full a11y land in Phase 10; Phase 7
       supports pointer creation + keyboard delete (focused cut region). -->
  <div
    class="timeline-track"
    bind:this={trackEl}
    role="group"
    aria-label={t('edit.timeline.aria')}
    onpointerdown={startEmptyDrag}
    onmousemove={onTrackMove}
    onmouseleave={onTrackLeave}
  >
    {#if wizardState.trimRange.start > 0}
      <div
        class="tl-outside head"
        style="width: {timeToPct(wizardState.trimRange.start, duration)}%"
      ></div>
    {/if}
    {#if wizardState.trimRange.end < duration}
      <div
        class="tl-outside tail"
        style="width: {100 - timeToPct(wizardState.trimRange.end, duration)}%"
      ></div>
    {/if}

    <div
      class="tl-content"
      style="inset-inline-start: {timeToPct(
        wizardState.trimRange.start,
        duration
      )}%; width: {timeToPct(wizardState.trimRange.end - wizardState.trimRange.start, duration)}%"
    >
      <!-- `silent` is a state hook (asserted by the e2e suite, and a seam for any
           future video-only styling): such files show the gradient band with no
           waveform bars. No extra CSS today — the bars are simply omitted below. -->
      <div class="track-dynamic" class:silent={!hasAudio}>
        {#if hasAudio}
          <WaveformOverlay bars={waveBars} />
        {/if}
      </div>
    </div>

    {#each wizardState.cuts as cut (cut.id)}
      <CutRegion
        {cut}
        leftPct={timeToPct(cut.start, duration)}
        widthPct={timeToPct(cut.end - cut.start, duration)}
        onResizeStart={(edge: 'start' | 'end', ev: PointerEvent) => {
          startCutHandleDrag(cut.id, edge, ev);
        }}
        onDelete={() => {
          deleteCut(wizardState, cut.id);
          mergePrompt = null;
        }}
      />
    {/each}

    {#if pendingCut !== null}
      <CutRegion
        cut={{ id: 'pending', start: pendingCut.start, end: pendingCut.end }}
        leftPct={timeToPct(pendingCut.start, duration)}
        widthPct={timeToPct(pendingCut.end - pendingCut.start, duration)}
        pending
      />
    {/if}

    <SideAnchor
      pct={timeToPct(wizardState.trimRange.start, duration)}
      ariaLabel={t('edit.aria.trimStart')}
      onpointerdown={(ev: PointerEvent) => {
        startAnchorDrag('start', ev);
      }}
    />
    <SideAnchor
      pct={timeToPct(wizardState.trimRange.end, duration)}
      ariaLabel={t('edit.aria.trimEnd')}
      onpointerdown={(ev: PointerEvent) => {
        startAnchorDrag('end', ev);
      }}
    />

    {#if hoverPct !== null && activeCancel === null}
      <div class="hover-cue" style="inset-inline-start: {hoverPct}%">
        <span class="hover-cue-icon" aria-hidden="true">✂</span>
      </div>
    {/if}

    {#if anchorTip !== null}
      <AnchorTip pct={anchorTip.pct} seconds={anchorTip.seconds} />
    {/if}

    {#if snapBadge !== null}
      <SnapBadge pct={snapBadge.pct} label={t('edit.snapKf')} />
    {/if}

    {#if mergePrompt !== null}
      <MergePrompt midPct={mergePrompt.midPct} onConfirm={acceptMerge} onCancel={dismissMerge} />
    {/if}

    <Playhead {duration} />
  </div>
</div>

<style>
  /* Port .timeline-wrap, .timeline-track, .tl-outside (+ .head/.tail),
     .tl-content, .track-dynamic, .hover-cue, .hover-cue-icon from app.css.
     Keep `direction: ltr` on .timeline-track. Already logical — port verbatim. */
  .timeline-wrap {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 4px;
  }
  .timeline-track {
    position: relative;
    display: block;
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    height: 78px;
    user-select: none;
    -webkit-user-select: none;
    direction: ltr;
  }
  .tl-outside {
    position: absolute;
    top: 0;
    bottom: 0;
    background: repeating-linear-gradient(
      135deg,
      rgba(15, 21, 37, 0.05) 0,
      rgba(15, 21, 37, 0.05) 6px,
      rgba(15, 21, 37, 0.025) 6px,
      rgba(15, 21, 37, 0.025) 12px
    );
    z-index: 0;
  }
  .tl-outside.head {
    inset-inline-start: 0;
    border-radius: var(--radius-sm) 0 0 var(--radius-sm);
  }
  .tl-outside.tail {
    inset-inline-end: 0;
    border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  }
  .tl-content {
    position: absolute;
    top: 0;
    bottom: 0;
    z-index: 1;
    cursor: crosshair;
    overflow: visible;
  }
  .track-dynamic {
    position: absolute;
    inset: 0;
    background: linear-gradient(180deg, var(--color-brand-100), var(--color-brand-50));
    overflow: hidden;
  }
  .hover-cue {
    position: absolute;
    top: -2px;
    bottom: -2px;
    width: 1.5px;
    background: rgba(153, 27, 27, 0.55);
    pointer-events: none;
    z-index: 2;
  }
  .hover-cue-icon {
    position: absolute;
    top: -20px;
    inset-inline-start: 50%;
    transform: translateX(-50%);
    font-size: 13px;
    background: var(--color-danger-700);
    color: white;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    box-shadow: var(--shadow-sm);
  }
</style>
