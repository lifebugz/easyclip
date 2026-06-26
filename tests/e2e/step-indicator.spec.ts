import { test, expect } from '@playwright/test';
import { installTauriMocks } from './helpers/tauri-mocks';

test('active step dot is filled and carries a halo box-shadow', async ({ page }) => {
  await page.goto('/');
  const activeDot = page.locator('li[aria-current="step"] > span').first();
  const shadow = await activeDot.evaluate((el) => getComputedStyle(el).boxShadow);
  expect(shadow).not.toBe('none'); // the halo
  const bg = await activeDot.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).not.toBe('rgba(0, 0, 0, 0)'); // filled, not transparent
});

test('connector behind a completed step is brand-colored, not grey', async ({ page }) => {
  await installTauriMocks(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose file…' }).click();
  await page.getByRole('button', { name: 'Continue' }).click(); // now on step 2; step 1 done
  // The connector after the first (done) dot is the first h-px span.
  const firstConnector = page.locator('ol[role="list"] span.h-px').first();
  const doneBg = await firstConnector.evaluate((el) => getComputedStyle(el).backgroundColor);
  // Chromium serializes the computed bg as oklch() (it no longer down-converts
  // wide-gamut colors to rgb). gray-300 computes to oklch(0.872 0.01 258.338);
  // brand-700 (bg-brand-700) is oklch(0.42 0.2 250). Pin the grey value so a
  // regression (connector staying grey) genuinely fails — comparing against an
  // rgb() string can never go red here.
  const greyConnector = 'oklch(0.872 0.01 258.338)';
  expect(doneBg).not.toBe(greyConnector);
  // And an upcoming (future) connector MUST stay grey — proves the brand color
  // is gated on `done`, not applied to every connector.
  const lastConnector = page.locator('ol[role="list"] span.h-px').last();
  const futureBg = await lastConnector.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(futureBg).toBe(greyConnector);
});
