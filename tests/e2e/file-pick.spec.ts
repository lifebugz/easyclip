import { test, expect } from '@playwright/test';
import { installTauriMocks } from './helpers/tauri-mocks';

test('empty stage: Choose button visible, drop cue and shortcut badge present', async ({
  page
}) => {
  await page.goto('/');
  const dropzone = page.locator('[data-stage="empty"]');
  await expect(dropzone).toBeVisible();
  await expect(dropzone.getByRole('button', { name: 'Choose file…' })).toBeVisible();
  await expect(dropzone).toContainText('or drag and drop one here');
  // Shortcut badge — ⌘O on Mac, Ctrl+O elsewhere. Playwright's headless
  // Chromium reports a Linux-ish userAgent; we assert the kbd is visible
  // without pinning its content (the FilePickStep picks the right glyph).
  await expect(dropzone.locator('kbd')).toBeVisible();
});

test('probing stage: probing copy appears while the probe is in flight', async ({ page }) => {
  await installTauriMocks(page, { probeDelayMs: 250 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose file…' }).click();
  // The probing stage should be visible while the 250ms timeout runs.
  await expect(page.locator('[data-stage="probing"]')).toBeVisible();
  await expect(page.locator('[data-stage="probing"]')).toContainText('Reading file');
  // And eventually transitions to probed.
  await expect(page.locator('[data-stage="probed"]')).toBeVisible();
});

test('probed stage: media-info card shows duration, format, codec, ext, audio yes', async ({
  page
}) => {
  await installTauriMocks(page, {
    probeResult: {
      path: '/fixtures/sample.mp4',
      duration: 3661, // 1:01:01
      container: 'mov,mp4,m4a,3gp,3g2,mj2',
      codec: 'h264',
      ext: 'mp4',
      hasAudio: true,
      keyframes: [0, 2, 4]
    }
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose file…' }).click();
  const card = page.locator('[data-stage="probed"]');
  await expect(card).toBeVisible();
  await expect(card.locator('[data-field="duration"]')).toHaveText('1:01:01');
  await expect(card.locator('[data-field="container"]')).toHaveText('mov,mp4,m4a,3gp,3g2,mj2');
  await expect(card.locator('[data-field="codec"]')).toHaveText('h264');
  await expect(card.locator('[data-field="ext"]')).toHaveText('mp4');
  await expect(card.locator('[data-field="audio"]')).toHaveText('Yes');
});

test('probed stage: hasAudio=false renders "No" in the audio row', async ({ page }) => {
  await installTauriMocks(page, {
    probeResult: {
      path: '/fixtures/silent.mp4',
      duration: 60,
      container: 'mov,mp4',
      codec: 'h264',
      ext: 'mp4',
      hasAudio: false,
      keyframes: []
    }
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose file…' }).click();
  await expect(page.locator('[data-field="audio"]')).toHaveText('No');
});

test('probed stage: Continue advances to timeline-edit', async ({ page }) => {
  await installTauriMocks(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose file…' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Trim and remove');
});

test('probed stage: "Choose a different file" re-opens picker and re-probes', async ({ page }) => {
  // The helper covers the simple cases (single fixed pick/probe). For per-call
  // dynamic behaviour (different paths across calls), inline the same shape.
  await page.addInitScript(() => {
    let pickCalls = 0;
    (window as unknown as { __TAURI_INTERNALS__: Record<string, unknown> }).__TAURI_INTERNALS__ = {
      // eslint-disable-next-line @typescript-eslint/require-await
      invoke: async (cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
        if (cmd === 'plugin:dialog|open') {
          return pickCalls++ === 0 ? '/fixtures/A.mp4' : '/fixtures/B.mov';
        }
        if (cmd === 'probe_media') {
          const path = (args as { path: string }).path;
          return {
            path,
            duration: 10,
            container: path.endsWith('.mov') ? 'mov,mp4' : 'mov,mp4,m4a',
            codec: 'h264',
            ext: path.endsWith('.mov') ? 'mov' : 'mp4',
            hasAudio: true,
            keyframes: []
          };
        }
        throw new Error(`unmocked: ${cmd}`);
      },
      transformCallback: () => Math.floor(Math.random() * 1e9)
    };
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose file…' }).click();
  await expect(page.locator('[data-field="ext"]')).toHaveText('mp4');
  await page.getByRole('button', { name: 'Choose a different file' }).click();
  await expect(page.locator('[data-field="ext"]')).toHaveText('mov');
});

test('probe-error stage: backend error renders heading + localised error body', async ({
  page
}) => {
  await installTauriMocks(page, {
    probeReject: {
      kind: 'MediaCorrupted',
      i18nKey: 'errors.media.corrupted',
      details: 'moov atom not found'
    }
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose file…' }).click();
  const errorBox = page.locator('[data-stage="probe-error"]');
  await expect(errorBox).toBeVisible();
  await expect(errorBox.getByRole('heading', { level: 2 })).toHaveText(
    "We couldn't open that file"
  );
  await expect(errorBox).toContainText('That file looks damaged');
});

test('probe-error stage: re-pick recovers when the second probe succeeds', async ({ page }) => {
  // First probe fails, second succeeds. Per-call dynamic behaviour — inlined.
  await page.addInitScript(() => {
    let probeCalls = 0;
    (window as unknown as { __TAURI_INTERNALS__: Record<string, unknown> }).__TAURI_INTERNALS__ = {
      // eslint-disable-next-line @typescript-eslint/require-await
      invoke: async (cmd: string): Promise<unknown> => {
        if (cmd === 'plugin:dialog|open') return '/fixtures/v.mp4';
        if (cmd === 'probe_media') {
          probeCalls++;
          if (probeCalls === 1) {
            const err = new Error('errors.media.corrupted');
            Object.assign(err, {
              kind: 'MediaCorrupted',
              i18nKey: 'errors.media.corrupted',
              details: 'corrupt'
            });
            throw err;
          }
          return {
            path: '/fixtures/v.mp4',
            duration: 10,
            container: 'mov,mp4',
            codec: 'h264',
            ext: 'mp4',
            hasAudio: true,
            keyframes: []
          };
        }
        throw new Error(`unmocked: ${cmd}`);
      },
      transformCallback: () => Math.floor(Math.random() * 1e9)
    };
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose file…' }).click();
  await expect(page.locator('[data-stage="probe-error"]')).toBeVisible();
  await page.getByRole('button', { name: 'Choose a different file' }).click();
  await expect(page.locator('[data-stage="probed"]')).toBeVisible();
});

test('user-cancel from picker: stays on empty stage when picker returns null', async ({ page }) => {
  await installTauriMocks(page, { pickResult: null });
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose file…' }).click();
  // After clicking Choose, the stage stays "empty" — the dropzone is still visible.
  await expect(page.locator('[data-stage="empty"]')).toBeVisible();
  // And no probing/probed/probe-error containers exist.
  await expect(page.locator('[data-stage="probing"]')).toHaveCount(0);
  await expect(page.locator('[data-stage="probed"]')).toHaveCount(0);
  await expect(page.locator('[data-stage="probe-error"]')).toHaveCount(0);
});

test('Cmd/Ctrl+O keyboard shortcut opens the picker', async ({ page }) => {
  // Track call count via a side-channel global on window so we can verify
  // the keyboard shortcut DID trigger an invoke (not just any other path).
  await page.addInitScript(() => {
    (window as unknown as { __pickCalls: number }).__pickCalls = 0;
    (window as unknown as { __TAURI_INTERNALS__: Record<string, unknown> }).__TAURI_INTERNALS__ = {
      // eslint-disable-next-line @typescript-eslint/require-await
      invoke: async (cmd: string): Promise<unknown> => {
        if (cmd === 'plugin:dialog|open') {
          (window as unknown as { __pickCalls: number }).__pickCalls++;
          return '/fixtures/k.mp4';
        }
        if (cmd === 'probe_media') {
          return {
            path: '/fixtures/k.mp4',
            duration: 5,
            container: 'mov,mp4',
            codec: 'h264',
            ext: 'mp4',
            hasAudio: true,
            keyframes: []
          };
        }
        throw new Error(`unmocked: ${cmd}`);
      },
      transformCallback: () => Math.floor(Math.random() * 1e9)
    };
  });
  await page.goto('/');
  // svelte:window onkeydown listens on the window object and fires for any
  // keydown event regardless of focus, but Playwright's headless Chromium
  // doesn't deliver keyboard events to the page until something inside the
  // document has been clicked first. Click the non-interactive <h1> so we
  // don't risk activating the Choose button (which would inflate __pickCalls).
  // Playwright accepts either Control+KeyO (key-code form) or Control+o
  // (key-value form). The FilePickStep handler matches on e.key === 'o' with
  // e.ctrlKey || e.metaKey, so Control+o is the cleanest cross-platform key.
  await page.getByRole('heading', { level: 1 }).click();
  await page.keyboard.press('Control+o');
  await expect(page.locator('[data-stage="probed"]')).toBeVisible();
  const calls = await page.evaluate(
    () => (window as unknown as { __pickCalls: number }).__pickCalls
  );
  expect(calls).toBe(1);
});

test('HE: error heading is in Hebrew when probe rejects in HE mode', async ({ page }) => {
  await installTauriMocks(page, {
    probeReject: {
      kind: 'MediaUnsupported',
      i18nKey: 'errors.media.unsupported',
      details: 'no decoder'
    }
  });
  await page.goto('/');
  await page.locator('label', { hasText: 'עברית' }).click();
  await page.getByRole('button', { name: 'בחירת קובץ…' }).click();
  const errorBox = page.locator('[data-stage="probe-error"]');
  await expect(errorBox.getByRole('heading', { level: 2 })).toHaveText('לא הצלחנו לפתוח את הקובץ');
  await expect(errorBox).toContainText('אנחנו לא מזהים את פורמט הקובץ הזה');
});

test('audio-only file hides the Codec row (no blank value)', async ({ page }) => {
  await installTauriMocks(page, {
    probeResult: {
      path: '/fixtures/audio.m4a',
      duration: 60,
      container: 'mov,mp4,m4a,3gp,3g2,mj2',
      codec: '',
      ext: 'm4a',
      hasAudio: true,
      keyframes: []
    }
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose file…' }).click();
  await expect(page.locator('[data-stage="probed"]')).toBeVisible();
  // Positive control: the rest of the detail grid must still render, so this can't
  // false-green on a regression that collapses the whole probed card (which would
  // ALSO drop the codec dd and silently satisfy the count(0) assertion below).
  await expect(page.locator('dd[data-field="container"]')).toBeVisible();
  await expect(page.locator('dd[data-field="ext"]')).toBeVisible();
  await expect(page.locator('dd[data-field="codec"]')).toHaveCount(0);
});
