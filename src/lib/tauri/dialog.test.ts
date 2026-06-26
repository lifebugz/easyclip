import { test, expect, beforeEach, mock } from 'bun:test';

// Mock @tauri-apps/plugin-dialog's `open` before the SUT loads.
const tauriOpenMock = mock((): Promise<string | null> => Promise.resolve(null));
void mock.module('@tauri-apps/plugin-dialog', () => ({ open: tauriOpenMock }));

beforeEach(() => {
  tauriOpenMock.mockReset();
  tauriOpenMock.mockResolvedValue(null);
});

const { pickMediaFile, pickFolder } = await import('./dialog');

test('pickMediaFile() calls plugin-dialog.open with media filters and multiple:false', async () => {
  tauriOpenMock.mockResolvedValue('/Users/me/Movies/clip.mp4');
  const result = await pickMediaFile();
  expect(result).toBe('/Users/me/Movies/clip.mp4');
  expect(tauriOpenMock).toHaveBeenCalledTimes(1);
  const rawCalls = tauriOpenMock.mock.calls as unknown as unknown[][];
  const arg = rawCalls[0]?.[0] as {
    multiple: boolean;
    directory: boolean;
    filters: { name: string; extensions: string[] }[];
  };
  expect(arg.multiple).toBe(false);
  expect(arg.directory).toBe(false);
  expect(arg.filters.length).toBeGreaterThan(0);
  // The filter must include common video extensions; the exact set is
  // implementation-defined but mp4 must be there.
  expect(arg.filters[0]?.extensions).toContain('mp4');
});

test('pickMediaFile() returns null when the user cancels (open returns null)', async () => {
  tauriOpenMock.mockResolvedValue(null);
  const result = await pickMediaFile();
  expect(result).toBeNull();
});

test('pickMediaFile() returns null defensively if open returns a string array (multiple-mode result we never requested)', async () => {
  // Tauri's open() typing union includes string[]; with multiple:false we
  // should never see one, but guard against API drift.
  tauriOpenMock.mockResolvedValue(['/a/b.mp4', '/a/c.mp4'] as unknown as string);
  const result = await pickMediaFile();
  expect(result).toBeNull();
});

test('pickFolder() calls plugin-dialog.open with directory:true and multiple:false', async () => {
  tauriOpenMock.mockResolvedValue('/Users/me/Movies');
  const result = await pickFolder();
  expect(result).toBe('/Users/me/Movies');
  expect(tauriOpenMock).toHaveBeenCalledTimes(1);
  const rawCalls = tauriOpenMock.mock.calls as unknown as unknown[][];
  const arg = rawCalls[0]?.[0] as {
    multiple: boolean;
    directory: boolean;
  };
  expect(arg.multiple).toBe(false);
  expect(arg.directory).toBe(true);
});

test('pickFolder() returns null when the user cancels (open returns null)', async () => {
  tauriOpenMock.mockResolvedValue(null);
  const result = await pickFolder();
  expect(result).toBeNull();
});

test('pickFolder() returns null defensively if open returns a string array (multiple-mode result we never requested)', async () => {
  tauriOpenMock.mockResolvedValue(['/a', '/b'] as unknown as string);
  const result = await pickFolder();
  expect(result).toBeNull();
});
