import { expect, test, type Page } from '@playwright/test';
import { installTauriMocks, type TauriMockOptions } from './helpers/tauri-mocks';

const PROBE = {
  path: '/fixtures/sample.mp4',
  duration: 12,
  container: 'mov,mp4,m4a,3gp,3g2,mj2',
  codec: 'h264',
  ext: 'mp4',
  hasAudio: true,
  keyframes: [0, 2, 4, 6, 8, 10]
};

/**
 * Navigate from the initial page through file-pick → timeline-edit → save →
 * processing.  Reuses the exact selectors from save-step.spec.ts /
 * wizard-shell.spec.ts — the Start processing button is keyed by
 * data-action="start-processing".
 */
async function gotoSaveAndStart(page: Page, options: TauriMockOptions): Promise<void> {
  await installTauriMocks(page, {
    probeResult: PROBE,
    ...options
  });
  await page.goto('/');
  // file-pick step: choose file → Continue
  await page.getByRole('button', { name: 'Choose file…' }).click();
  await page.getByRole('button', { name: 'Continue' }).click(); // file-pick → timeline-edit
  await page.getByRole('button', { name: 'Continue' }).click(); // timeline-edit → save
  // save step: click Start processing → transitions to processing step
  await page.locator('[data-action="start-processing"]').click();
  // Confirm we're on the processing step before returning.
  await page.locator('[data-step="processing"]').waitFor();
}

// The script events fire at ~15ms, which is well before any Playwright assertion
// can run after gotoSaveAndStart (~400ms navigation).  The stable state to assert
// is therefore the FINAL scripted state, not intermediate windows.  We use a
// three-event script whose final event leaves a deterministic stable state before
// processHoldUntilCancel keeps the step visible indefinitely.
test('progress ring, stage label, and conditional ETA render from events', async ({ page }) => {
  await gotoSaveAndStart(page, {
    processScript: [
      { stage: 'segment', segmentIndex: 1, segmentCount: 2, fraction: 0.3, etaSeconds: null },
      { stage: 'concat', segmentIndex: 1, segmentCount: 2, fraction: 0.8, etaSeconds: 4 },
      // Final scripted event: finalizing — ETA null again, label flips.
      { stage: 'finalizing', segmentIndex: 1, segmentCount: 2, fraction: 0.99, etaSeconds: null }
    ],
    processHoldUntilCancel: true
  });

  // All three events have fired before the assertions run.  The final stable
  // state is the finalizing event: "Finishing up…" and no ETA element.
  await expect(page.getByTestId('proc-pass')).toHaveText('Finishing up…');
  // proc-eta is absent from the DOM when etaSeconds is null (conditional {#if}).
  await expect(page.getByTestId('proc-eta')).toHaveCount(0);
  // The ring has advanced to ~99% (fraction from finalizing event).
  await expect(page.getByTestId('proc-pct')).toHaveText('99%');

  // Cancel to release the hold.
  await page.locator('[data-action="cancel-processing"]').click();
  await expect(page.locator('[data-step="timeline-edit"]')).toBeVisible();
});

// Separate test: verify ETA renders when etaSeconds is present.
// A single-event script with etaSeconds: 4 produces a deterministic stable state.
test('ETA label renders when etaSeconds is non-null (N16 load-bearing spaces)', async ({
  page
}) => {
  await gotoSaveAndStart(page, {
    processScript: [
      { stage: 'concat', segmentIndex: 1, segmentCount: 2, fraction: 0.8, etaSeconds: 4 }
    ],
    processHoldUntilCancel: true
  });
  // After the single concat event the ETA is visible with the assembled string.
  await expect(page.getByTestId('proc-eta')).toHaveText('About 4s remaining');
  // Pass label shows the concat stage.
  await expect(page.getByTestId('proc-pass')).toHaveText(/Pass 2 of 2/);
  await page.locator('[data-action="cancel-processing"]').click();
});

test('terminal success: done step shows correct stats', async ({ page }) => {
  await gotoSaveAndStart(page, {
    processResult: {
      outputPath: '/fixtures/out/sample-trimmed.mp4',
      finalDuration: 9,
      removedDuration: 3,
      segmentCount: 1
    }
  });
  // Terminal success → done step with stats.
  await expect(page.locator('[data-step="done"]')).toBeVisible();
  await expect(page.getByTestId('done-final')).toHaveText('0:09');
  // U+2212 minus sign prepended by DoneStep (not a hyphen).
  await expect(page.getByTestId('done-removed')).toHaveText('−0:03');
});

test('cancel disables the button and returns to timeline-edit with state intact', async ({
  page
}) => {
  await gotoSaveAndStart(page, { processHoldUntilCancel: true });
  const cancel = page.locator('[data-action="cancel-processing"]');
  await cancel.click();
  await expect(cancel).toBeDisabled();
  await expect(page.locator('[data-step="timeline-edit"]')).toBeVisible();
});

test('retry from the error step shows a clean ring from 0 and re-invokes', async ({ page }) => {
  await gotoSaveAndStart(page, {
    processReject: { kind: 'DiskFull', i18nKey: 'errors.disk.full', details: 'x' }
  });
  await expect(page.locator('[data-step="error"]')).toBeVisible();
  // "errors.disk.full" → "There isn't enough free space…" — contains "free space".
  await expect(page.getByTestId('error-message')).toHaveText(/free space/i);
  await page.locator('[data-action="retry"]').click();
  await expect(page.locator('[data-step="processing"]')).toBeVisible();
  // S12: baseline reset — the ring must not show the prior run's value.
  await expect(page.getByTestId('proc-pct')).toHaveText('0%');
  // Two calls recorded: original + retry.
  const calls = await page.evaluate(
    () => (window as unknown as { __processCalls?: unknown[] }).__processCalls?.length ?? 0
  );
  expect(calls).toBe(2);
});

test('done actions route reveal/open through the gated commands', async ({ page }) => {
  await gotoSaveAndStart(page, {});
  await page.locator('[data-step="done"]').waitFor();
  await page.locator('[data-action="reveal"]').click();
  await page.locator('[data-action="open"]').click();
  const opener = await page.evaluate(
    () => (window as unknown as { __openerCalls?: unknown[] }).__openerCalls
  );
  expect(opener).toEqual([
    { cmd: 'reveal_output', path: '/fixtures/out/sample-trimmed.mp4' },
    { cmd: 'open_output', path: '/fixtures/out/sample-trimmed.mp4' }
  ]);
});

test('HE: done stats stay LTR while the chrome mirrors', async ({ page }) => {
  await gotoSaveAndStart(page, {});
  await page.locator('[data-step="done"]').waitFor();
  // Language toggle is a <label> radio — same idiom as wizard-shell.spec.ts.
  await page.locator('label', { hasText: 'עברית' }).click();
  await expect(page.getByTestId('done-path')).toHaveCSS('direction', 'ltr');
  await expect(page.getByTestId('done-final')).toHaveCSS('direction', 'ltr');
  await expect(page.getByTestId('done-removed')).toHaveCSS('direction', 'ltr');
  // U+2212 minus sign must survive the locale switch.
  await expect(page.getByTestId('done-removed')).toHaveText('−0:03');
});

test('F2: re-picking a different file resets the editor coordinates', async ({ page }) => {
  await gotoSaveAndStart(page, { processHoldUntilCancel: true });
  await page.locator('[data-action="cancel-processing"]').click();
  await page.locator('[data-step="timeline-edit"]').waitFor();
  // Back from timeline-edit to file-pick.
  await page.getByRole('button', { name: 'Back' }).click();
  await page.locator('[data-step="file-pick"]').waitFor();
  // Re-pick (same mock path, but a fresh probe) — trim must re-seed.
  await page.getByRole('button', { name: 'Choose file…' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.locator('[data-step="timeline-edit"]').waitFor();
  // DurationReadout shows the full re-seeded duration (0:12).
  await expect(page.locator('[data-step="timeline-edit"]')).toContainText('0:12');
});
