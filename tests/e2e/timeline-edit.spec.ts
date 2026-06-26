import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { installTauriMocks } from './helpers/tauri-mocks';
import type { ProbeMockResult, TauriMockOptions } from './helpers/tauri-mocks';

// Full ProbeMockResult with a known 120-second duration so drag-fraction math
// maps to clear time values (0.4–0.6 of 120s = 48–72s, well above MIN_CUT_DUR).
const PROBE_120: ProbeMockResult = {
  path: '/fixtures/sample.mp4',
  duration: 120,
  container: 'mov,mp4,m4a,3gp,3g2,mj2',
  codec: 'h264',
  ext: 'mp4',
  hasAudio: true,
  keyframes: [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120]
};

async function gotoTimeline(page: Page, opts: TauriMockOptions = {}): Promise<void> {
  await installTauriMocks(page, { probeResult: PROBE_120, ...opts });
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose file…' }).click();
  await page.getByRole('button', { name: 'Continue' }).click(); // file-pick → timeline-edit
}

async function dragOnTrack(page: Page, fromFrac: number, toFrac: number): Promise<void> {
  const box = await page.locator('.timeline-track').boundingBox();
  if (box === null) throw new Error('timeline track not found');
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * fromFrac, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * toFrac, y, { steps: 8 });
  await page.mouse.up();
}

test('renders the timeline editor with heading, track, and anchors', async ({ page }) => {
  await gotoTimeline(page);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Trim and remove');
  await expect(page.locator('.timeline-track')).toBeVisible();
  await expect(page.locator('.side-anchor')).toHaveCount(2);
  await expect(page.locator('.cut-region')).toHaveCount(0);
});

test('dragging the start anchor inward shows a head wash', async ({ page }) => {
  await gotoTimeline(page);
  const startAnchor = page.locator('.side-anchor').first();
  const box = await startAnchor.boundingBox();
  if (box === null) throw new Error('anchor not found');
  const trackBox = await page.locator('.timeline-track').boundingBox();
  if (trackBox === null) throw new Error('track not found');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(trackBox.x + trackBox.width * 0.25, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator('.tl-outside.head')).toBeVisible();
});

test('dragging across the empty band creates a cut region', async ({ page }) => {
  await gotoTimeline(page);
  await dragOnTrack(page, 0.4, 0.6);
  await expect(page.locator('.cut-region:not(.pending)')).toHaveCount(1);
  await expect(page.locator('.cut-region .cut-label')).toContainText('Cut');
});

test('the × button deletes a cut', async ({ page }) => {
  await gotoTimeline(page);
  await dragOnTrack(page, 0.4, 0.6);
  await expect(page.locator('.cut-region:not(.pending)')).toHaveCount(1);
  await page.locator('.cut-region').first().hover();
  await page.locator('.cut-x').click();
  await expect(page.locator('.cut-region:not(.pending)')).toHaveCount(0);
});

test('an overlapping second cut raises the merge prompt; Merge collapses to one', async ({
  page
}) => {
  await gotoTimeline(page);
  await dragOnTrack(page, 0.3, 0.5);
  // Start the second drag outside the first cut (at 0.6), drag leftward so the
  // resulting range [0.4–0.6] overlaps the first [0.3–0.5]. Starting inside the
  // first cut would be swallowed by the .cut-region guard.
  await dragOnTrack(page, 0.6, 0.4); // overlaps the first
  await expect(page.locator('.merge-prompt')).toBeVisible();
  await page.getByRole('button', { name: 'Merge' }).click();
  await expect(page.locator('.merge-prompt')).toHaveCount(0);
  await expect(page.locator('.cut-region:not(.pending)')).toHaveCount(1);
});

test('"Keep separate" dismisses the prompt and leaves both overlapping cuts', async ({ page }) => {
  await gotoTimeline(page);
  await dragOnTrack(page, 0.3, 0.5);
  await dragOnTrack(page, 0.6, 0.4); // overlaps the first → merge prompt
  await expect(page.locator('.merge-prompt')).toBeVisible();
  await page.getByRole('button', { name: 'Keep separate' }).click();
  await expect(page.locator('.merge-prompt')).toHaveCount(0);
  // Intentionally-overlapping cuts persist (the readout counts the union, not the sum).
  await expect(page.locator('.cut-region:not(.pending)')).toHaveCount(2);
});

test('Escape during a create drag cancels it (no cut committed)', async ({ page }) => {
  await gotoTimeline(page);
  const box = await page.locator('.timeline-track').boundingBox();
  if (box === null) throw new Error('track not found');
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * 0.4, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, y, { steps: 8 });
  await expect(page.locator('.cut-region.pending')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(page.locator('.cut-region')).toHaveCount(0);
});

test('dragging a cut start-handle outward widens the cut (resize)', async ({ page }) => {
  await gotoTimeline(page);
  await dragOnTrack(page, 0.4, 0.6);
  const region = page.locator('.cut-region:not(.pending)');
  await expect(region).toHaveCount(1);
  const before = await region.boundingBox();
  if (before === null) throw new Error('cut region not found');
  const handle = region.locator('.cut-handle.start');
  const hb = await handle.boundingBox();
  const trackBox = await page.locator('.timeline-track').boundingBox();
  if (hb === null || trackBox === null) throw new Error('handle/track not found');
  const y = hb.y + hb.height / 2;
  await page.mouse.move(hb.x + hb.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(trackBox.x + trackBox.width * 0.3, y, { steps: 8 });
  await page.mouse.up();
  const after = await region.boundingBox();
  if (after === null) throw new Error('cut region not found after resize');
  expect(after.width).toBeGreaterThan(before.width + 5);
});

test('pointercancel during a create drag discards it without freezing the track', async ({
  page
}) => {
  await gotoTimeline(page);
  // Record the active pointer's id so the synthetic pointercancel below carries
  // the SAME id (the gesture's terminal listeners are pointerId-scoped).
  await page.evaluate(() => {
    window.addEventListener(
      'pointerdown',
      (e) => {
        (window as unknown as { __pid?: number }).__pid = e.pointerId;
      },
      { capture: true, once: true }
    );
  });
  const box = await page.locator('.timeline-track').boundingBox();
  if (box === null) throw new Error('track not found');
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * 0.4, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, y, { steps: 8 });
  await expect(page.locator('.cut-region.pending')).toHaveCount(1);
  // The OS/WebView can preempt an active pointer with pointercancel instead of
  // pointerup (touch interruption, system gesture). The gesture must revert.
  await page.evaluate(() => {
    const pid = (window as unknown as { __pid?: number }).__pid ?? 1;
    window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: pid }));
  });
  await page.mouse.up(); // late real release — must be a no-op (listeners torn down)
  await expect(page.locator('.cut-region')).toHaveCount(0); // pending discarded, nothing committed
  // Not frozen: a fresh drag still creates exactly one cut.
  await dragOnTrack(page, 0.2, 0.35);
  await expect(page.locator('.cut-region:not(.pending)')).toHaveCount(1);
});

test('a foreign pointer release does not terminate an active gesture (pointerId scoped)', async ({
  page
}) => {
  await gotoTimeline(page);
  const box = await page.locator('.timeline-track').boundingBox();
  if (box === null) throw new Error('track not found');
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * 0.4, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, y, { steps: 8 });
  await expect(page.locator('.cut-region.pending')).toHaveCount(1);
  // A DIFFERENT pointer's release/cancel (e.g. a second finger) must not commit or
  // cancel the pointer that armed this gesture.
  await page.evaluate(() => {
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 987654 }));
    window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 987654 }));
  });
  await expect(page.locator('.cut-region.pending')).toHaveCount(1); // gesture still alive
  await expect(page.locator('.cut-region:not(.pending)')).toHaveCount(0); // nothing committed
  await page.mouse.up(); // the arming pointer's real release commits
  await expect(page.locator('.cut-region:not(.pending)')).toHaveCount(1);
});

test('Delete during a cut resize is ignored (focused cut not deleted mid-gesture)', async ({
  page
}) => {
  await gotoTimeline(page);
  await dragOnTrack(page, 0.2, 0.35); // cut A (earlier start → rendered first)
  await dragOnTrack(page, 0.5, 0.7); // cut B
  await expect(page.locator('.cut-region:not(.pending)')).toHaveCount(2);
  // Keyboard-focus cut A's delete button (the focus-within reveal path).
  await page.locator('.cut-region').first().locator('.cut-x').focus();
  // Start resizing cut B's start handle and hold (preventDefault keeps focus on A).
  const bHandle = page.locator('.cut-region').nth(1).locator('.cut-handle.start');
  const hb = await bHandle.boundingBox();
  if (hb === null) throw new Error('B handle not found');
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x - 25, hb.y + hb.height / 2, { steps: 4 });
  await page.keyboard.press('Delete'); // must be ignored while a gesture is in flight
  await page.mouse.up();
  // A is NOT deleted — both cuts remain (a mid-gesture delete would have removed A,
  // then the resize snapshot-restore would have resurrected it inconsistently).
  await expect(page.locator('.cut-region:not(.pending)')).toHaveCount(2);
});

test('right-button pointerdown on the start anchor does not move it', async ({ page }) => {
  await gotoTimeline(page);
  await expect(page.locator('.tl-outside.head')).toHaveCount(0); // full trim, no head wash yet
  const anchor = page.locator('.side-anchor').first();
  const ab = await anchor.boundingBox();
  const trackBox = await page.locator('.timeline-track').boundingBox();
  if (ab === null || trackBox === null) throw new Error('anchor/track not found');
  const y = ab.y + ab.height / 2;
  await page.mouse.move(ab.x + ab.width / 2, y);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(trackBox.x + trackBox.width * 0.25, y, { steps: 8 });
  await page.mouse.up({ button: 'right' });
  // A non-primary button must not start a trim drag → start anchor stays at 0 → no head wash.
  await expect(page.locator('.tl-outside.head')).toHaveCount(0);
});

// ADAPTATION: The language toggle is a <label> radio pair, not a <button>.
// wizard-shell.spec.ts confirms: `page.locator('label', { hasText: 'עברית' }).click()`
test('HE: chrome mirrors but the timeline track stays LTR', async ({ page }) => {
  await gotoTimeline(page);
  await page.locator('label', { hasText: 'עברית' }).click(); // language toggle to HE
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('.timeline-track')).toHaveCSS('direction', 'ltr');
  // The media timecodes stay LTR so "playhead / duration" never visually reverses
  // under RTL (bidi would otherwise reorder the slash-separated numerals).
  await expect(page.locator('.preview-tc')).toHaveCSS('direction', 'ltr');
  await expect(page.locator('.transport .time-display')).toHaveCSS('direction', 'ltr');
});

test('snap badge appears when an anchor drag locks onto a keyframe and clears on release', async ({
  page
}) => {
  await gotoTimeline(page);
  const startAnchor = page.locator('.side-anchor').first();
  const aBox = await startAnchor.boundingBox();
  if (aBox === null) throw new Error('anchor not found');
  const track = await page.locator('.timeline-track').boundingBox();
  if (track === null) throw new Error('track not found');
  const y = aBox.y + aBox.height / 2;

  await page.mouse.move(aBox.x + aBox.width / 2, y);
  await page.mouse.down();
  // 0.25 of a 120s clip = 30s, which is keyframe index 3 in PROBE_120.
  await page.mouse.move(track.x + track.width * 0.25, y, { steps: 8 });

  await expect(page.locator('.snap-badge')).toBeVisible();
  await expect(page.locator('.snap-badge')).toContainText('keyframe');

  await page.mouse.up();
  await expect(page.locator('.snap-badge')).toHaveCount(0); // cleared on teardown
});

test('play button starts playback (playhead visible, label flips) and pause stops it', async ({
  page
}) => {
  await gotoTimeline(page);

  // Fresh entry: playhead reset to trimRange.start (0) — marker is in range.
  await expect(page.locator('.playhead')).toBeVisible();

  const playBtn = page.locator('.play-btn');
  await expect(playBtn).toHaveAttribute('aria-label', 'Play');
  await playBtn.click();
  await expect(playBtn).toHaveAttribute('aria-label', 'Pause');

  // Let the RAF loop advance the timecode, then pause.
  await page.waitForTimeout(150);
  await playBtn.click();
  await expect(playBtn).toHaveAttribute('aria-label', 'Play');

  // The transport time display advanced past 0:00.00.
  await expect(page.locator('.transport .time-display .big')).not.toHaveText('0:00.00');
});

test('continuing to Save pauses playback', async ({ page }) => {
  await gotoTimeline(page);
  await page.locator('.play-btn').click();
  await expect(page.locator('.play-btn')).toHaveAttribute('aria-label', 'Pause');
  await page.getByRole('button', { name: 'Continue' }).click(); // timeline-edit → save
  await page.getByRole('button', { name: 'Back' }).click(); // save → timeline-edit (no reset)
  // Returned to edit; playback was paused on the way out (label back to Play).
  await expect(page.locator('.play-btn')).toHaveAttribute('aria-label', 'Play');
});

test('renders a 64-bar waveform for files with audio', async ({ page }) => {
  await gotoTimeline(page); // PROBE_120 has hasAudio: true
  await expect(page.locator('.track-dynamic')).not.toHaveClass(/silent/);
  await expect(page.locator('.wave-bar')).toHaveCount(64);
});

test('video-only files get the silent treatment (no bars)', async ({ page }) => {
  await gotoTimeline(page, { probeResult: { ...PROBE_120, hasAudio: false } });
  await expect(page.locator('.track-dynamic.silent')).toBeVisible();
  await expect(page.locator('.wave-bar')).toHaveCount(0);
});

test('video file: the keyframe-snap hint sentence is shown', async ({ page }) => {
  await gotoTimeline(page); // PROBE_120 has keyframes → canSnap true
  await expect(page.locator('p.hint')).toContainText('keyframe');
});

test('audio-only file: the keyframe-snap hint sentence is hidden, base remains', async ({
  page
}) => {
  await gotoTimeline(page, {
    probeResult: {
      path: '/fixtures/audio.m4a',
      duration: 60,
      container: 'mov,mp4,m4a,3gp,3g2,mj2',
      codec: '',
      ext: 'm4a',
      hasAudio: true,
      keyframes: [] // no video stream → canSnap false
    }
  });
  await expect(page.locator('p.hint')).not.toContainText('keyframe');
  await expect(page.locator('p.hint')).toContainText('Drag the side anchors');
});

// ── Commit 5 (DF-2): focus-on-create ──

test('merge prompt: the confirm button receives focus on open', async ({ page }) => {
  await gotoTimeline(page);
  await dragOnTrack(page, 0.3, 0.5);
  await dragOnTrack(page, 0.6, 0.4); // overlaps the first → raises the merge prompt
  await expect(page.locator('.merge-prompt')).toBeVisible();
  await expect(page.locator('.merge-prompt .prompt-btn.confirm')).toBeFocused();
});

test('drag-created cut is focused so Delete works without Tab', async ({ page }) => {
  await gotoTimeline(page);
  await dragOnTrack(page, 0.4, 0.6);
  await expect(page.locator('.cut-region:not(.pending)')).toHaveCount(1);
  await expect(page.locator('.cut-region .cut-x')).toBeFocused();
  await page.keyboard.press('Delete'); // no hover, no Tab
  await expect(page.locator('.cut-region:not(.pending)')).toHaveCount(0);
});

test('merge-creating drag focuses the prompt, not the new cut', async ({ page }) => {
  await gotoTimeline(page);
  await dragOnTrack(page, 0.3, 0.5);
  await dragOnTrack(page, 0.6, 0.4); // merge
  await expect(page.locator('.merge-prompt .prompt-btn.confirm')).toBeFocused();
  // ...and NOT the freshly-committed cut: focusNewCut() must be skipped on the merge
  // path. Without this negative assertion the test is indistinguishable from the
  // 'confirm receives focus on open' case above and proves nothing about the split.
  await expect(page.locator('.cut-region .cut-x:focus')).toHaveCount(0);
});

// ── Commit 6 (DF-1): exact keyframe-snapped FINAL duration ──

test('FINAL readout reflects the keyframe-snapped plan_duration, not raw arithmetic', async ({
  page
}) => {
  // Pin the viewport so the interactive snap radius (SNAP_PX * duration/trackWidth)
  // is deterministic. The discriminator below relies on cut end 55 staying
  // UNsnapped during the drag (raw 1:35 vs snapped 1:30); a narrower viewport
  // could widen the radius enough to snap end→60, collapsing both to 1:30 and
  // letting the test pass without ever consulting plan_duration.
  await page.setViewportSize({ width: 1280, height: 800 });
  await gotoTimeline(page); // 120s clip, keyframes every 10s (PROBE_120)
  // Cut [30s, 55s]: the cut END (55s) sits 5s from the nearest keyframe — outside
  // the ~2.3s interactive snap radius — so it is NOT snapped during the drag.
  // Raw arithmetic would show 120 - 25 = 95s ("1:35"); the backend forward-snaps
  // the surviving kept range's start 55→60, yielding 90s ("1:30"). The readout must
  // land on the snapped value, proving it routes through the debounced round-trip.
  await dragOnTrack(page, 30 / 120, 55 / 120);
  await expect(page.locator('.cut-region:not(.pending)')).toHaveCount(1);
  // Debounced (250ms) round-trip then lands on the mocked planned (snapped) value.
  await expect(page.locator('.readout-val').last()).toHaveText('1:30', { timeout: 2000 });
  // Once the plan has settled the FINAL piece is no longer busy — aria-busy mirrors
  // the same `computing` flag as the visual dim, so a settled readout exposes
  // aria-busy="false" (and the binding's removal would surface as a missing attr).
  await expect(page.locator('.readout-piece').last()).toHaveAttribute('aria-busy', 'false');
});

test('audio-only file: a selection that collapses below MIN_CUT_DUR disables Continue', async ({
  page
}) => {
  // Non-snappable file (keyframes: []). The export runs build_plan with an empty
  // keyframe table and rejects SelectionTooNarrow when no kept range survives
  // MIN_CUT_DUR (0.25s). The plan_duration round-trip runs here too (it is no longer
  // gated on snappable files), so `plan.wouldBeTooNarrow` carries that verdict and
  // the Continue gate mirrors it locally — the user can't walk into a hard export
  // failure. Short 1.5s clip so 0.25s is a comfortable ~17% of the track: a single
  // centered cut leaves 0.15s slivers at both ends, both sub-threshold.
  await page.setViewportSize({ width: 1280, height: 800 });
  await gotoTimeline(page, {
    probeResult: {
      path: '/fixtures/short.m4a',
      duration: 1.5,
      container: 'mov,mp4,m4a,3gp,3g2,mj2',
      codec: '',
      ext: 'm4a',
      hasAudio: true,
      keyframes: []
    }
  });
  // No cuts yet → the whole 1.5s trim survives (>= MIN_CUT_DUR) → Continue enabled
  // once the initial plan settles.
  await expect(page.getByRole('button', { name: 'Continue' })).toBeEnabled();
  // Cut [0.15s, 1.35s] (width 1.2s commits) leaves only [0,0.15] and [1.35,1.5] —
  // both 0.15s < MIN_CUT_DUR. build_plan drops both and aborts SelectionTooNarrow.
  await dragOnTrack(page, 0.1, 0.9);
  await expect(page.locator('.cut-region:not(.pending)')).toHaveCount(1);
  // Wait for the debounced round-trip to SETTLE on the too-narrow verdict: FINAL
  // reads 0:00. This proves the disable below is the `tooNarrow` verdict (the
  // build_plan round-trip ran for this non-snappable file), not just the transient
  // `computing` guard during settle.
  await expect(page.locator('.readout-val').last()).toHaveText('0:00', { timeout: 2000 });
  await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled();
});
