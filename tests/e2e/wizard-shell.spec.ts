import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { installTauriMocks } from './helpers/tauri-mocks';

// Click "Choose file…" → wait for the probed-stage Continue button →
// click Continue. After this, the wizard is on timeline-edit.
async function advancePastFilePick(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Choose file…' }).click();
  // The probed stage renders both the Continue button (wizard.actions.continue)
  // and a separate "Choose a different file" button. We disambiguate by name.
  await page.getByRole('button', { name: 'Continue' }).click();
}

async function clickByName(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name }).click();
}

test('initial render: file-pick step active, stepper shows dot 1 active, Choose button visible', async ({
  page
}) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Pick a file');
  await expect(page.locator('li[aria-current="step"]')).toHaveText(/Pick/);
  await expect(page.getByRole('button', { name: 'Choose file…' })).toBeVisible();
});

test('Continue advances file-pick → timeline-edit and indicator moves', async ({ page }) => {
  await installTauriMocks(page);
  await page.goto('/');
  await advancePastFilePick(page);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Trim and remove');
  await expect(page.locator('li[aria-current="step"]')).toHaveText(/Edit/);
});

test('Continue advances timeline-edit → save', async ({ page }) => {
  await installTauriMocks(page);
  await page.goto('/');
  await advancePastFilePick(page);
  await clickByName(page, 'Continue'); // timeline-edit → save
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Where should we save?');
  await expect(page.locator('li[aria-current="step"]')).toHaveText(/Save/);
});

test('Back from timeline-edit returns to file-pick without confirm', async ({ page }) => {
  await installTauriMocks(page);
  await page.goto('/');
  await advancePastFilePick(page);
  await clickByName(page, 'Back');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Pick a file');
  await expect(page.locator('dialog[open]')).toHaveCount(0);
});

test('Back from save returns to timeline-edit without confirm', async ({ page }) => {
  await installTauriMocks(page);
  await page.goto('/');
  await advancePastFilePick(page);
  await clickByName(page, 'Continue'); // → save
  await clickByName(page, 'Back');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Trim and remove');
  await expect(page.locator('dialog[open]')).toHaveCount(0);
});

test('Start Over from timeline-edit opens confirm modal', async ({ page }) => {
  await installTauriMocks(page);
  await page.goto('/');
  await advancePastFilePick(page);
  await clickByName(page, 'Start over');
  await expect(page.locator('dialog[open]')).toBeVisible();
  await expect(page.locator('dialog[open] h3')).toHaveText('Start over?');
});

test('Confirm modal Cancel keeps current step', async ({ page }) => {
  await installTauriMocks(page);
  await page.goto('/');
  await advancePastFilePick(page);
  await clickByName(page, 'Start over');
  await page.locator('dialog[open]').getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Trim and remove');
});

test('Confirm modal Confirm resets to file-pick', async ({ page }) => {
  await installTauriMocks(page);
  await page.goto('/');
  await advancePastFilePick(page);
  await clickByName(page, 'Start over');
  await page.locator('dialog[open]').getByRole('button', { name: 'Start over' }).click();
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Pick a file');
});

test('Escape key in confirm modal cancels (focus return verified by sibling test)', async ({
  page
}) => {
  await installTauriMocks(page);
  await page.goto('/');
  await advancePastFilePick(page);
  await clickByName(page, 'Start over');
  await expect(page.locator('dialog[open]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Trim and remove');
});

test('HE: dir=rtl flip mirrors layout, step content is Hebrew', async ({ page }) => {
  await installTauriMocks(page);
  await page.goto('/');
  await page.locator('label', { hasText: 'עברית' }).click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('בחרו קובץ');
  // The picker chrome is in HE too; the Choose button label is "בחירת קובץ…"
  await page.getByRole('button', { name: 'בחירת קובץ…' }).click();
  // Continue button in HE = "המשך"
  await page.getByRole('button', { name: 'המשך' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('חיתוך והסרה');
});

test('confirm modal: danger button is red-700 and aria ids are per-instance', async ({ page }) => {
  await installTauriMocks(page);
  await page.goto('/');
  await advancePastFilePick(page);
  await clickByName(page, 'Start over');
  const dialog = page.locator('dialog[open]');
  await expect(dialog).toBeVisible();
  // Per-instance ids: aria-labelledby is NOT the hardcoded "confirm-title".
  const labelledby = await dialog.getAttribute('aria-labelledby');
  expect(labelledby).not.toBe('confirm-title');
  expect(labelledby).toBeTruthy();
  if (labelledby === null) throw new Error('aria-labelledby missing'); // narrows for the template below
  // Attribute selector, not `#${id}`: a UUID-derived id starts with a hex digit
  // ~62.5% of the time, and `#3e32…` is an INVALID CSS id selector (SyntaxError).
  // `[id="…"]` matches the raw attribute value, so any UUID first char is safe.
  await expect(dialog.locator(`[id="${labelledby}"]`)).toHaveText('Start over?');
  // Danger button uses red-700. This Chromium serializes computed colors as
  // oklch() (it no longer down-converts wide-gamut to rgb) — mirroring the
  // StepIndicator spec. red-700 = oklch(50.5% 0.213 27.518), normalized by
  // getComputedStyle to decimals (cf. red-600 → oklch(0.577 …)). Asserting the
  // red-700 oklch makes this go RED while the button is still bg-red-600.
  const danger = dialog.getByRole('button', { name: 'Start over' });
  const bg = await danger.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).toBe('oklch(0.505 0.213 27.518)'); // tailwind red-700
});

test('Cancel during processing returns to timeline-edit', async ({ page }) => {
  await installTauriMocks(page, { processHoldUntilCancel: true });
  await page.goto('/');
  await advancePastFilePick(page); // file-pick → timeline-edit
  await clickByName(page, 'Continue'); // timeline-edit → save
  await clickByName(page, 'Start processing'); // save → processing
  await clickByName(page, 'Cancel'); // processing → timeline-edit (per §4.1 PROC-05)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Trim and remove');
  // Confirms no modal gate on cancel.
  await expect(page.locator('dialog[open]')).toHaveCount(0);
});
