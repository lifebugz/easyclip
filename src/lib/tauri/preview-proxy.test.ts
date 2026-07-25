import { test, expect, beforeEach, mock } from 'bun:test';
import type { ProxyProgressEvent } from '$lib/types';

// Mock @tauri-apps/api/core before the SUT loads (dialog.test.ts precedent).
// FakeChannel captures onmessage so tests can drive progress events.
class FakeChannel {
  onmessage: ((e: ProxyProgressEvent) => void) | null = null;
}
const invokeMock = mock((): Promise<unknown> => Promise.resolve());
void mock.module('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
  Channel: FakeChannel,
  convertFileSrc: (p: string) => `asset://localhost/${encodeURIComponent(p)}`
}));

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
});

const { buildPreviewProxy, cancelPreviewProxy } = await import('./preview');

test('buildPreviewProxy invokes build_preview_proxy with path, flag and a wired Channel', async () => {
  invokeMock.mockResolvedValue({ proxyPath: '/cache/easyclip-proxy-ab.mp4', method: 'remux' });
  const seen: ProxyProgressEvent[] = [];
  const result = await buildPreviewProxy('/media/clip.mkv', false, (e) => seen.push(e));
  expect(result).toEqual({ proxyPath: '/cache/easyclip-proxy-ab.mp4', method: 'remux' });

  expect(invokeMock).toHaveBeenCalledTimes(1);
  const rawCalls = invokeMock.mock.calls as unknown as unknown[][];
  expect(rawCalls[0]?.[0]).toBe('build_preview_proxy');
  const args = rawCalls[0]?.[1] as {
    path: string;
    forceTranscode: boolean;
    onEvent: FakeChannel;
  };
  expect(args.path).toBe('/media/clip.mkv');
  expect(args.forceTranscode).toBe(false);
  // The channel's onmessage must be wired to the caller's onProgress.
  expect(args.onEvent).toBeInstanceOf(FakeChannel);
  args.onEvent.onmessage?.({ fraction: 0.5 });
  args.onEvent.onmessage?.({ fraction: null });
  expect(seen).toEqual([{ fraction: 0.5 }, { fraction: null }]);
});

test('buildPreviewProxy passes forceTranscode=true through', async () => {
  invokeMock.mockResolvedValue({ proxyPath: '/p.mp4', method: 'transcode' });
  await buildPreviewProxy('/media/clip.ts', true, () => undefined);
  const rawCalls = invokeMock.mock.calls as unknown as unknown[][];
  expect((rawCalls[0]?.[1] as { forceTranscode: boolean }).forceTranscode).toBe(true);
});

test('buildPreviewProxy rejects with the AppError payload untouched', () => {
  const appErr = { kind: 'processingFailed', i18nKey: 'error.processingFailed' };
  invokeMock.mockRejectedValue(appErr);
  expect(buildPreviewProxy('/media/clip.mkv', false, () => undefined)).rejects.toBe(appErr);
});

test('cancelPreviewProxy invokes cancel_preview_proxy', async () => {
  await cancelPreviewProxy();
  const rawCalls = invokeMock.mock.calls as unknown as unknown[][];
  expect(rawCalls[0]?.[0]).toBe('cancel_preview_proxy');
});
