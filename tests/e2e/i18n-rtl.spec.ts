import { test, expect } from '@playwright/test';

// Helper: click the language toggle label. Radio inputs are sr-only (visually
// hidden for styling), so the wrapping <label> element must receive the click.
async function clickLang(page: import('@playwright/test').Page, text: string) {
  await page.locator('label', { hasText: text }).click();
}

test('EN initial: <html dir>=ltr and the file-pick step title is in English', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Pick a file');
});

test('clicking HE flips dir to rtl, lang to he, and step title to Hebrew', async ({ page }) => {
  await page.goto('/');
  await clickLang(page, 'עברית');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('html')).toHaveAttribute('lang', 'he');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('בחרו קובץ');
});

test('clicking EN flips back to ltr', async ({ page }) => {
  await page.goto('/');
  await clickLang(page, 'עברית');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await clickLang(page, 'English');
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
});
