import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { installTauriMocks } from './helpers/tauri-mocks';

// Helper: install mocks, navigate, advance from file-pick → timeline-edit → save.
// The default mocks (sample.mp4 with hasAudio=true) yield saveName='sample-trimmed'
// and saveDir='/fixtures' on entry to the save step (Phase 5 seeding logic).
async function gotoSaveStep(
  page: Page,
  opts: Parameters<typeof installTauriMocks>[1] = {}
): Promise<void> {
  await installTauriMocks(page, opts);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose file…' }).click();
  await page.getByRole('button', { name: 'Continue' }).click(); // file-pick → timeline-edit
  await page.getByRole('button', { name: 'Continue' }).click(); // timeline-edit → save
}

test('defaults: saveName seeded as "<stem>-trimmed", saveDir as dirname', async ({ page }) => {
  await gotoSaveStep(page);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Where should we save?');
  await expect(page.locator('[data-input="filename"]')).toHaveValue('sample-trimmed');
  await expect(page.locator('[data-input="location"]')).toHaveValue('/fixtures');
});

test('ext pill shows the canonical extension', async ({ page }) => {
  await gotoSaveStep(page);
  await expect(page.locator('[data-pill="ext"]')).toHaveText('.mp4');
});

test('format card shows uppercased ext + locked caption', async ({ page }) => {
  await gotoSaveStep(page);
  const card = page.locator('[data-card="format"]');
  await expect(card.locator('[data-field-value="ext"]')).toHaveText('MP4');
  await expect(card.locator('[data-field-value="locked"]')).toHaveText(
    'locked (matches your input)'
  );
});

test('filename input is editable and updates wizardState', async ({ page }) => {
  await gotoSaveStep(page);
  const input = page.locator('[data-input="filename"]');
  await input.fill('my-custom-name');
  await expect(input).toHaveValue('my-custom-name');
  // Start-processing button stays enabled — the new name is valid.
  await expect(page.locator('[data-action="start-processing"]')).toBeEnabled();
});

test('Choose button updates saveDir only; saveName is preserved', async ({ page }) => {
  await gotoSaveStep(page, { pickFolderResult: '/Users/me/NewLocation' });
  const nameInput = page.locator('[data-input="filename"]');
  const dirInput = page.locator('[data-input="location"]');

  // Type a custom filename first.
  await nameInput.fill('custom-name');
  await expect(nameInput).toHaveValue('custom-name');
  await expect(dirInput).toHaveValue('/fixtures');

  // Click Choose → folder picker returns /Users/me/NewLocation.
  await page.locator('[data-action="choose-folder"]').click();

  await expect(dirInput).toHaveValue('/Users/me/NewLocation');
  // saveName preserved through the folder change.
  await expect(nameInput).toHaveValue('custom-name');
});

test('Choose cancel preserves both saveDir and saveName', async ({ page }) => {
  await gotoSaveStep(page, { pickFolderResult: null });
  const nameInput = page.locator('[data-input="filename"]');
  const dirInput = page.locator('[data-input="location"]');
  await nameInput.fill('typed-name');

  await page.locator('[data-action="choose-folder"]').click();

  // Neither rune mutated on cancel.
  await expect(nameInput).toHaveValue('typed-name');
  await expect(dirInput).toHaveValue('/fixtures');
});

test('empty filename: error visible, Start-processing disabled', async ({ page }) => {
  await gotoSaveStep(page);
  const nameInput = page.locator('[data-input="filename"]');

  await nameInput.fill('');
  // The $effect "apply when empty" re-seeds on the next render. To assert the
  // empty-error state we need to observe BEFORE the effect fires — or, more
  // robustly, type whitespace-only which trims to empty but isn't '' so the
  // effect skips.
  await nameInput.fill('   ');

  await expect(page.locator('#save-name-error')).toHaveText(
    "Filename and location can't be empty."
  );
  await expect(page.locator('[data-action="start-processing"]')).toBeDisabled();
});

test('filename with shell metacharacter: invalid-chars error, Start-processing disabled', async ({
  page
}) => {
  await gotoSaveStep(page);
  const nameInput = page.locator('[data-input="filename"]');
  await nameInput.fill('bad;name');

  await expect(page.locator('#save-name-error')).toContainText(
    "That filename has characters we can't use"
  );
  await expect(page.locator('[data-action="start-processing"]')).toBeDisabled();
});

test('filename with forward slash: invalid-chars error', async ({ page }) => {
  await gotoSaveStep(page);
  const nameInput = page.locator('[data-input="filename"]');
  await nameInput.fill('foo/bar');

  await expect(page.locator('#save-name-error')).toContainText(
    "That filename has characters we can't use"
  );
  await expect(page.locator('[data-action="start-processing"]')).toBeDisabled();
});

test('Windows-reserved filename stem: invalid-chars error', async ({ page }) => {
  await gotoSaveStep(page);
  const nameInput = page.locator('[data-input="filename"]');
  await nameInput.fill('CON');

  await expect(page.locator('#save-name-error')).toContainText(
    "That filename has characters we can't use"
  );
  await expect(page.locator('[data-action="start-processing"]')).toBeDisabled();
});

test('empty location: error visible, Start-processing disabled', async ({ page }) => {
  await gotoSaveStep(page);
  const dirInput = page.locator('[data-input="location"]');
  await dirInput.fill('   ');

  await expect(page.locator('#save-dir-error')).toHaveText("Filename and location can't be empty.");
  await expect(page.locator('[data-action="start-processing"]')).toBeDisabled();
});

test('location with shell metacharacter: invalid-chars error', async ({ page }) => {
  await gotoSaveStep(page);
  const dirInput = page.locator('[data-input="location"]');
  await dirInput.fill('/bad;dir');

  await expect(page.locator('#save-dir-error')).toContainText(
    "That filename has characters we can't use"
  );
  await expect(page.locator('[data-action="start-processing"]')).toBeDisabled();
});

test('valid form: Start-processing advances to processing step', async ({ page }) => {
  await gotoSaveStep(page);
  await expect(page.locator('[data-action="start-processing"]')).toBeEnabled();
  await page.locator('[data-action="start-processing"]').click();

  // ProcessingStep h1 = proc.h1 = "Trimming…" (real step, not placeholder).
  // process_media mock defaults to 'pending' — the step stays visible.
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Trimming…');
});

test('Back returns to timeline-edit without confirm modal', async ({ page }) => {
  await gotoSaveStep(page);
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Trim and remove');
  await expect(page.locator('dialog[open]')).toHaveCount(0);
});

test('HE: form labels mirror, but filename input keeps dir="ltr"', async ({ page }) => {
  await installTauriMocks(page);
  await page.goto('/');
  await page.locator('label', { hasText: 'עברית' }).click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

  await page.getByRole('button', { name: 'בחירת קובץ…' }).click();
  await page.getByRole('button', { name: 'המשך' }).click(); // file-pick → timeline-edit (Continue in HE)
  await page.getByRole('button', { name: 'המשך' }).click(); // timeline-edit → save

  await expect(page.getByRole('heading', { level: 1 })).toHaveText('איפה לשמור?');
  // Filename label in HE.
  await expect(page.locator('[data-field="filename"] span').first()).toHaveText('שם קובץ');
  // Filename input keeps dir="ltr" for natural Latin cursor behaviour.
  await expect(page.locator('[data-input="filename"]')).toHaveAttribute('dir', 'ltr');
  // Format card "locked" caption in HE.
  await expect(page.locator('[data-card="format"] [data-field-value="locked"]')).toHaveText(
    'נעול (תואם לקובץ המקור)'
  );
});

test('HE invalid-chars error renders in Hebrew', async ({ page }) => {
  await installTauriMocks(page);
  await page.goto('/');
  await page.locator('label', { hasText: 'עברית' }).click();
  await page.getByRole('button', { name: 'בחירת קובץ…' }).click();
  await page.getByRole('button', { name: 'המשך' }).click();
  await page.getByRole('button', { name: 'המשך' }).click();

  await page.locator('[data-input="filename"]').fill('bad;name');
  await expect(page.locator('#save-name-error')).toContainText(
    'יש בשם הקובץ הזה תווים שאנחנו לא יכולים להשתמש בהם'
  );
});

// Both filename + location inputs MUST opt out of macOS WKWebView text services
// (autocapitalize / autocorrect / spellcheck). Without these, typing "my-clip"
// in the filename becomes "My-clip" after blur — a silent transformation of
// user input that lands in the saved filename. Chromium (Playwright) doesn't
// apply text services so we can't observe the transformation here; the spec
// asserts the attributes are present so a future refactor can't quietly drop
// them. Real-app verification happens at phase-boundary UAT.
test('filename input opts out of macOS text services', async ({ page }) => {
  await gotoSaveStep(page);
  const input = page.locator('[data-input="filename"]');
  await expect(input).toHaveAttribute('autocapitalize', 'none');
  await expect(input).toHaveAttribute('autocorrect', 'off');
  await expect(input).toHaveAttribute('spellcheck', 'false');
});

test('location input opts out of macOS text services', async ({ page }) => {
  await gotoSaveStep(page);
  const input = page.locator('[data-input="location"]');
  await expect(input).toHaveAttribute('autocapitalize', 'none');
  await expect(input).toHaveAttribute('autocorrect', 'off');
  await expect(input).toHaveAttribute('spellcheck', 'false');
});
