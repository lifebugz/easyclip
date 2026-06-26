import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { installTauriMocks } from './helpers/tauri-mocks';
import type { ProbeMockResult } from './helpers/tauri-mocks';

// The asset:// scheme causes an immediate Blink resource-load error in
// Playwright/Chromium (ERR_UNKNOWN_URL_SCHEME) before any JS event listener
// fires, so the <video> is unmounted before the first Playwright poll. Fix:
// redirect convertFileSrc to an HTTP base and use a never-resolving page.route
// so the browser hangs waiting (no error event fires, no loadedmetadata fires,
// decode-timeout is 4 s which far exceeds the test assertions). The <video>
// stays mounted in optimistic mode long enough for all assertions to run.
// Intent preserved: assertions still prove assetUrl(path) === convertFileSrc(path).
const ASSET_STUB_BASE = 'http://localhost:5173/asset-stub';

function assetStubUrl(path: string): string {
  return `${ASSET_STUB_BASE}/${encodeURIComponent(path)}`;
}

const PROBE_MP4: ProbeMockResult = {
  path: '/fixtures/sample.mp4',
  duration: 120,
  container: 'mov,mp4,m4a,3gp,3g2,mj2',
  codec: 'h264',
  ext: 'mp4',
  hasAudio: true,
  keyframes: [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120]
};

async function gotoTimeline(page: Page, probe = PROBE_MP4): Promise<void> {
  await installTauriMocks(page, {
    probeResult: probe,
    convertFileSrcBase: ASSET_STUB_BASE
  });
  // Never resolve asset-stub requests so Chromium neither errors nor fires
  // loadedmetadata; the <video> stays in optimistic video/audio mode for the
  // duration of the test assertions (well under DECODE_TIMEOUT_MS = 4 000 ms).
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  await page.route(`${ASSET_STUB_BASE}/**`, (_route) => {
    /* intentionally left pending — do not call fulfill/abort/continue */
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose file…' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
}

test('mounts a <video> whose src is the mocked assetUrl', async ({ page }) => {
  await gotoTimeline(page);
  const video = page.locator('video.preview-video');
  await expect(video).toBeAttached();
  await expect(video).toHaveAttribute('src', assetStubUrl('/fixtures/sample.mp4'));
});

test('a <video> error event routes to poster mode: <img> appears, extract invoked', async ({
  page
}) => {
  await gotoTimeline(page);
  // Simulate an undecodable codec: dispatch `error` on the <video>.
  await page.locator('video.preview-video').evaluate((el) => {
    el.dispatchEvent(new Event('error'));
  });
  await expect(page.locator('img.preview-poster')).toBeVisible();
  await expect(page.locator('.preview-note')).toContainText('Showing extracted frames');
  const posterCalls = await page.evaluate(
    () => (window as unknown as { __posterCalls?: unknown[] }).__posterCalls?.length ?? 0
  );
  expect(posterCalls).toBeGreaterThan(0);
});

test('audio-only file (codec === "") routes to audio mode, art backdrop visible', async ({
  page
}) => {
  await gotoTimeline(page, {
    path: '/fixtures/song.m4a',
    duration: 60,
    container: 'mov,mp4,m4a,3gp,3g2,mj2',
    codec: '',
    ext: 'm4a',
    hasAudio: true,
    keyframes: []
  });
  // codec === '' ⇒ never poster; the <video> mounts (audio-only class) and the
  // decorative art backdrop stays visible. No poster note in audio mode.
  await expect(page.locator('video.preview-video.audio-only')).toBeAttached();
  await expect(page.locator('.preview-art')).toBeVisible();
  // Audio mode is neither 'poster' nor 'art', so the note block must NOT render —
  // assert the negative so a regression that leaks a note into audio mode fails here
  // (the poster test above proves the selector matches when a note IS shown).
  await expect(page.locator('.preview-note')).toHaveCount(0);
});

test('audio-only file: a spurious <video> error does NOT silence it (stays audio, not art)', async ({
  page
}) => {
  // An audio-only file has no poster to fall to. A spurious MediaError on the
  // invisible audio <video> (asset:// transient / embedded cover-art quirk) must
  // NOT route to 'art', which would unmount the element and permanently silence a
  // playable file. failToPoster is hasVideo-gated, so the error is a no-op here.
  await gotoTimeline(page, {
    path: '/fixtures/song.m4a',
    duration: 60,
    container: 'mov,mp4,m4a,3gp,3g2,mj2',
    codec: '',
    ext: 'm4a',
    hasAudio: true,
    keyframes: []
  });
  const video = page.locator('video.preview-video.audio-only');
  await expect(video).toBeAttached();
  await video.evaluate((el) => {
    el.dispatchEvent(new Event('error'));
  });
  // Still mounted + audio-only after the error (NOT unmounted to art mode), and no
  // poster note leaked in.
  await expect(page.locator('video.preview-video.audio-only')).toBeAttached();
  await expect(page.locator('.preview-note')).toHaveCount(0);
});

test('a real video with an unidentifiable codec (codec === "" but hasRealVideo) routes to VIDEO, not audio', async ({
  page
}) => {
  // ffprobe can report a real video stream with no codec_name → the wire carries
  // codec === '' yet has_real_video === true. Preview routing must follow
  // hasRealVideo, NOT codec !== '': this is a real video and must mount in video
  // mode (no .audio-only class), never be misrouted to invisible audio. Contrast
  // the codec === '' + (defaulted) hasRealVideo:false audio-only tests above.
  await gotoTimeline(page, {
    path: '/fixtures/weird.mkv',
    duration: 60,
    container: 'matroska,webm',
    codec: '',
    ext: 'mkv',
    hasRealVideo: true,
    hasAudio: false,
    keyframes: [0, 10, 20]
  });
  const video = page.locator('video.preview-video');
  await expect(video).toBeAttached();
  // Video mode ⇒ the audio-only class must NOT be applied (would mean it was
  // misrouted to audio because codec === '').
  await expect(page.locator('video.preview-video.audio-only')).toHaveCount(0);
});

test('a real video stuck at videoWidth 0 (audio-latched) still falls to poster, not stranded invisible', async ({
  page
}) => {
  // A real video (hasRealVideo) whose <video> reports videoWidth 0 at BOTH
  // loadedmetadata and loadeddata latches decodedAsAudio (provisional invisible
  // audio). The decode-timeout must stay armed THROUGH that latch so the stuck
  // video falls to a visible poster — regression guard for the F2 disarm-guard
  // fix: disarming on decodedAsAudio would strand a real video in invisible-audio
  // mode forever. (The never-resolving asset stub keeps videoWidth 0.)
  await gotoTimeline(page); // PROBE_MP4: h264 ⇒ hasRealVideo true via the mock default
  const video = page.locator('video.preview-video');
  await expect(video).toBeAttached();
  await video.evaluate((el) => {
    el.dispatchEvent(new Event('loadedmetadata'));
    el.dispatchEvent(new Event('loadeddata'));
  });
  // decodedAsAudio is now latched (videoWidth 0). The still-armed 4 s decode
  // timeout fires failToPoster → poster mode with the extracted-frames note.
  await expect(page.locator('img.preview-poster')).toBeVisible({ timeout: 7000 });
  await expect(page.locator('.preview-note')).toContainText('Showing extracted frames');
});

test('play() rejected with AbortError resets the transport (no stuck Pause + frozen clock)', async ({
  page
}) => {
  // `el.play()` can reject with AbortError when a pause()/load() races the play
  // promise. Unlike an undecodable source it fires NO `error` event, so without
  // the AbortError guard `wizardState.playing` would stay true and the transport
  // would stick on Pause with a frozen clock until a manual pause. Regression
  // guard: the play button must settle back to 'Play'.
  await gotoTimeline(page);
  const video = page.locator('video.preview-video');
  await expect(video).toBeAttached();
  await video.evaluate((el) => {
    const v = el as HTMLVideoElement;
    // Force a real decoded frame so decodedAsVideo latches and the 4 s decode
    // timeout DISARMS — otherwise the timeout's own failToPoster would reset
    // `playing` at 4 s and mask whether the AbortError guard did its job.
    Object.defineProperty(v, 'videoWidth', { value: 1920, configurable: true });
    v.dispatchEvent(new Event('loadedmetadata'));
    // Make the next play() reject as an interrupted play (no MediaError event).
    v.play = () =>
      Promise.reject(new DOMException('interrupted by a new load request', 'AbortError'));
  });
  const playBtn = page.locator('.play-btn');
  await expect(playBtn).toHaveAttribute('aria-label', 'Play');
  await playBtn.click();
  // playing is briefly set true then reset to false by the AbortError guard, so
  // the button settles back to 'Play'. With the decode timeout disarmed, this
  // guard is now the ONLY thing that can reset it — without the fix it sticks on
  // 'Pause' indefinitely and this assertion fails.
  await expect(playBtn).toHaveAttribute('aria-label', 'Play');
});
