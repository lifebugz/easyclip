import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
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

test('video decode error → poster + a preview-proxy build is requested (forceTranscode:false)', async ({
  page
}) => {
  // Ladder rung 1: the existing failToPoster route now ALSO kicks the proxy.
  // The default mock rejects builds, so the poster note stays put (exhausted).
  await gotoTimeline(page);
  const video = page.locator('video.preview-video');
  await expect(video).toBeAttached();
  await video.evaluate((el) => el.dispatchEvent(new Event('error')));
  await expect(page.locator('img.preview-poster')).toBeVisible();
  await expect
    .poll(async () =>
      page.evaluate(() => (window as unknown as { __proxyCalls?: unknown[] }).__proxyCalls ?? [])
    )
    .toHaveLength(2); // default build rejects → one forced retry, then exhausted
  const calls = await page.evaluate(
    () => (window as unknown as { __proxyCalls?: unknown[] }).__proxyCalls
  );
  expect(calls?.[0]).toMatchObject({ path: '/fixtures/sample.mp4', forceTranscode: false });
  expect(calls?.[1]).toMatchObject({ path: '/fixtures/sample.mp4', forceTranscode: true });
  // Exhausted video keeps today's bottom rung: poster + its note, never art.
  await expect(page.locator('.preview-note')).toContainText('Showing extracted frames');
});

test('proxy resolve swaps the <video> to the proxy src and re-classifies from scratch', async ({
  page
}) => {
  await installTauriMocks(page, {
    convertFileSrcBase: ASSET_STUB_BASE,
    proxyResult: { proxyPath: '/fixtures/proxy/easyclip-proxy-cafe.mp4', method: 'transcode' }
  });
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  await page.route(`${ASSET_STUB_BASE}/**`, (_route) => {
    /* pending forever - keeps both original and proxy elements mounted */
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose file…' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();

  const video = page.locator('video.preview-video');
  await expect(video).toBeAttached();
  await video.evaluate((el) => el.dispatchEvent(new Event('error')));
  // Poster shows while the proxy builds… then the resolve swaps the src: the
  // decode-state reset clears `errored`, so the element REMOUNTS pointing at
  // the proxy (optimistic video mode), and the poster clears.
  await expect(video).toBeAttached();
  await expect(video).toHaveAttribute(
    'src',
    `${ASSET_STUB_BASE}/${encodeURIComponent('/fixtures/proxy/easyclip-proxy-cafe.mp4')}`
  );
  await expect(page.locator('img.preview-poster')).toHaveCount(0);
  // Task 8 invariant: the swap co-occurs with a play-stop.
  await expect(page.locator('.play-btn')).toHaveAttribute('aria-label', 'Play');
});

test('undecodable audio-only: Preparing note during the build, art + unavailable after exhaustion', async ({
  page
}) => {
  test.setTimeout(30_000); // rides through AUDIO_DECODE_TIMEOUT_MS (4s) + 2 builds
  await installTauriMocks(page, {
    probeResult: {
      path: '/fixtures/broken.wma',
      duration: 30,
      container: 'asf',
      codec: '',
      ext: 'wma',
      hasAudio: true,
      keyframes: []
    },
    convertFileSrcBase: ASSET_STUB_BASE,
    proxyDelayMs: 900 // hold 'building' long enough for the note poll to see it
  });
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  await page.route(`${ASSET_STUB_BASE}/**`, (_route) => {
    /* pending forever - element stays at readyState 0 (undecodable audio) */
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose file…' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();

  // Before the ladder: silent invisible audio (no note, element mounted).
  await expect(page.locator('video.preview-video.audio-only')).toBeAttached();
  await expect(page.locator('.preview-note')).toHaveCount(0);
  // At AUDIO_DECODE_TIMEOUT_MS the watchdog fires (readyState still 0) and the
  // build starts - the note appears instead of the old silent-forever gap.
  await expect(page.locator('.preview-note')).toContainText('Preparing preview', {
    timeout: 7000
  });
  // Both builds reject (default) → exhausted → art + unavailable note, and the
  // dead element unmounts.
  await expect(page.locator('.preview-note')).toContainText("Live preview isn't available", {
    timeout: 5000
  });
  await expect(page.locator('video.preview-video')).toHaveCount(0);
});

test('mpegts kicks the proxy eagerly at load - no error event needed', async ({ page }) => {
  // mpegts fails SILENTLY in WKWebView: valid dimensions at loadedmetadata (so
  // the decode timeout disarms), then no frame and no `error` - ever. The kick
  // therefore comes from the probed container name at load. This spec dispatches
  // NO events at all: the proxy request must appear anyway.
  await installTauriMocks(page, {
    probeResult: {
      path: '/fixtures/camcorder.ts',
      duration: 30,
      container: 'mpegts',
      codec: 'h264',
      ext: 'ts',
      hasAudio: true,
      keyframes: [0, 10, 20, 30]
    },
    convertFileSrcBase: ASSET_STUB_BASE,
    proxyResult: { proxyPath: '/fixtures/proxy/easyclip-proxy-ts.mp4', method: 'remux' }
  });
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  await page.route(`${ASSET_STUB_BASE}/**`, (_route) => {
    /* pending forever - mimics mpegts: loads nothing, errors never */
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose file…' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();

  // Poster + a build request, with zero synthetic events dispatched.
  await expect
    .poll(async () =>
      page.evaluate(() => (window as unknown as { __proxyCalls?: unknown[] }).__proxyCalls ?? [])
    )
    .toHaveLength(1);
  const calls = await page.evaluate(
    () => (window as unknown as { __proxyCalls?: unknown[] }).__proxyCalls
  );
  expect(calls?.[0]).toMatchObject({ path: '/fixtures/camcorder.ts', forceTranscode: false });
  // The resolve swaps the element onto the proxy → live preview.
  await expect(page.locator('video.preview-video')).toHaveAttribute(
    'src',
    `${ASSET_STUB_BASE}/${encodeURIComponent('/fixtures/proxy/easyclip-proxy-ts.mp4')}`
  );
});

test('a natively-playable container never triggers an eager proxy build', async ({ page }) => {
  // Guard on the eager path's blast radius: the mp4 fixture must reach the
  // editor with the ladder completely untouched.
  await gotoTimeline(page); // PROBE_MP4 → container 'mov,mp4,m4a,3gp,3g2,mj2'
  await expect(page.locator('video.preview-video')).toBeAttached();
  await page.waitForTimeout(500);
  expect(
    await page.evaluate(
      () => (window as unknown as { __proxyCalls?: unknown[] }).__proxyCalls ?? []
    )
  ).toHaveLength(0);
});

test('an exhausted ladder does NOT stop poster playback the user started', async ({ page }) => {
  // The ladder must never yank the transport out from under the user. A video
  // file is already in poster mode when the ladder runs (failToPoster unmounted
  // the element and stopped playback at THAT moment); poster playback runs on
  // the virtual wall-clock RAF with no element bound, so exhaustion later has
  // nothing to tear down. Stopping playback there made the two timeline-edit
  // play/pause specs flake ~8% of runs (whenever the click landed inside the
  // build window). The audio-only case is different - exhaustion unmounts the
  // element (mode → art), so its play-stop stays.
  await installTauriMocks(page, {
    convertFileSrcBase: ASSET_STUB_BASE,
    proxyDelayMs: 400 // hold each rung so the Play click lands mid-build
  });
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  await page.route(`${ASSET_STUB_BASE}/**`, (_route) => {
    /* pending forever */
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose file…' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();

  const video = page.locator('video.preview-video');
  await expect(video).toBeAttached();
  await video.evaluate((el) => el.dispatchEvent(new Event('error')));
  await expect(page.locator('img.preview-poster')).toBeVisible();

  // User presses Play while rung 1 is still building.
  const playBtn = page.locator('.play-btn');
  await playBtn.click();
  await expect(playBtn).toHaveAttribute('aria-label', 'Pause');

  // Both rungs reject (~400ms each) → exhausted. Playback must survive.
  await expect
    .poll(
      async () =>
        page.evaluate(() => (window as unknown as { __proxyCalls?: unknown[] }).__proxyCalls ?? []),
      { timeout: 5000 }
    )
    .toHaveLength(2);
  await expect(page.locator('.preview-note')).toContainText('Showing extracted frames');
  await expect(playBtn).toHaveAttribute('aria-label', 'Pause');
});

test('a REMUX proxy that fails decode retries once with forceTranscode:true', async ({ page }) => {
  await installTauriMocks(page, {
    convertFileSrcBase: ASSET_STUB_BASE,
    proxyResult: { proxyPath: '/fixtures/proxy/easyclip-proxy-beef.mp4', method: 'remux' }
  });
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  await page.route(`${ASSET_STUB_BASE}/**`, (_route) => {
    /* pending forever */
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose file…' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();

  const video = page.locator('video.preview-video');
  await expect(video).toBeAttached();
  // Original fails → build #1 (remux) resolves → element remounts on the proxy.
  await video.evaluate((el) => el.dispatchEvent(new Event('error')));
  const proxySrc = `${ASSET_STUB_BASE}/${encodeURIComponent('/fixtures/proxy/easyclip-proxy-beef.mp4')}`;
  await expect(video).toHaveAttribute('src', proxySrc);
  // The remux proxy ALSO fails decode → rung 2 must force a transcode.
  await video.evaluate((el) => el.dispatchEvent(new Event('error')));
  await expect
    .poll(async () =>
      page.evaluate(() => (window as unknown as { __proxyCalls?: unknown[] }).__proxyCalls ?? [])
    )
    .toHaveLength(2);
  const calls = await page.evaluate(
    () => (window as unknown as { __proxyCalls?: unknown[] }).__proxyCalls
  );
  expect(calls?.[0]).toMatchObject({ forceTranscode: false });
  expect(calls?.[1]).toMatchObject({ forceTranscode: true });
});

test('app-initiated play actually advances the media clock (no self-pause on first tick)', async ({
  page
}) => {
  // Regression guard for the adf0cb6 freeze: the video-as-clock RAF $effect read
  // `wizardState.playhead` reactively in its body (pendingSeek init), so the
  // first tick that advanced the playhead re-triggered the effect, whose cleanup
  // ran el.pause() - and the re-run never calls play() again. Every element-backed
  // playback (video AND audio) froze within one frame, transport stuck on Pause.
  // This spec serves REAL media bytes (VP8 - Playwright's Chromium always decodes
  // it; h264 is not in its open build) so the element genuinely plays, then
  // asserts the clock advances past the first frame after clicking Play.
  await installTauriMocks(page, {
    probeResult: {
      path: '/fixtures/tiny-playable.webm',
      duration: 3,
      container: 'matroska,webm',
      codec: 'vp8',
      ext: 'webm',
      hasAudio: true,
      keyframes: [0, 1, 2, 3]
    },
    convertFileSrcBase: ASSET_STUB_BASE
  });
  const fixture = fileURLToPath(new URL('./fixtures/tiny-playable.webm', import.meta.url));
  await page.route(`${ASSET_STUB_BASE}/**`, (route) => {
    void route.fulfill({
      status: 200,
      contentType: 'video/webm',
      body: fs.readFileSync(fixture)
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose file…' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();

  const video = page.locator('video.preview-video');
  await expect(video).toBeAttached();
  // Wait for a real decoded first frame so play() starts from a ready element.
  await expect
    .poll(async () => video.evaluate((el) => (el as HTMLVideoElement).readyState))
    .toBeGreaterThanOrEqual(2);

  await page.locator('.play-btn').click();
  // The element must still be playing AND its clock must clear the first frame.
  // Under the bug it pauses within ~one RAF tick (currentTime ≈ 0.0–0.1, paused
  // true) while the transport sticks on Pause, so both assertions go red.
  await expect
    .poll(async () => video.evaluate((el) => (el as HTMLVideoElement).currentTime), {
      timeout: 5000
    })
    .toBeGreaterThan(0.5);
  await expect(video).toHaveJSProperty('paused', false);
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
