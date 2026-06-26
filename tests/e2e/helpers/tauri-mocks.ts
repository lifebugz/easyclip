import type { Page } from '@playwright/test';

export interface ProbeMockResult {
  path: string;
  duration: number;
  container: string;
  codec: string;
  ext: string;
  hasAudio: boolean;
  keyframes: number[];
}

export interface ProbeMockReject {
  kind: string;
  i18nKey: string;
  details: string | null;
}

export interface TauriMockOptions {
  /** Path the file picker resolves to. null = user-cancel. Default '/fixtures/sample.mp4'. */
  pickResult?: string | null;
  /** Probe result. Mutually exclusive with probeReject; default = sensible h264 fixture. */
  probeResult?: ProbeMockResult;
  /** Probe rejection (AppError-shaped). Mutually exclusive with probeResult. */
  probeReject?: ProbeMockReject;
  /** Delay probe resolution by N ms so tests can observe the probing-stage UI. */
  probeDelayMs?: number;
  /**
   * Path the folder picker resolves to. null = user-cancel. When unset,
   * folder-picker calls return null (backward-compatible with Phase 5 tests
   * that never invoke pickFolder()).
   */
  pickFolderResult?: string | null;
  /** Scripted progress events streamed (~15ms apart) before settlement. */
  processScript?: {
    stage: 'single' | 'segment' | 'concat' | 'finalizing';
    segmentIndex: number;
    segmentCount: number;
    fraction: number;
    etaSeconds: number | null;
  }[];
  /** Resolution value. Default: a sensible ProcessingResult. */
  processResult?: {
    outputPath: string;
    finalDuration: number;
    removedDuration: number;
    segmentCount: number;
  };
  /** AppError-shaped rejection (mutually exclusive with processResult). */
  processReject?: ProbeMockReject;
  /** Stay pending until cancel_processing, then reject OperationCancelled. */
  processHoldUntilCancel?: boolean;
}

/**
 * Install a mock `window.__TAURI_INTERNALS__` before page navigation, so the
 * dialog plugin's `invoke('plugin:dialog|open', ...)` call and Phase 3's
 * `probeMedia` (which calls `invoke('probe_media', ...)`) route through the
 * mock instead of failing with "window.__TAURI_INTERNALS__ is not defined".
 *
 * Mirrors what `@tauri-apps/api/mocks::mockIPC` does internally (see Tauri's
 * docs/develop/Tests/mocking.md), inlined to avoid bundling the mocks module
 * into the Playwright-served page.
 *
 * Limitations: dispatches only on `plugin:dialog|open` and `probe_media`.
 * Tests that need to mock other IPC commands or per-call dynamic behavior
 * should inline their own `page.addInitScript` with the same shape.
 */
export async function installTauriMocks(page: Page, options: TauriMockOptions = {}): Promise<void> {
  const data = {
    pickResult: options.pickResult === undefined ? '/fixtures/sample.mp4' : options.pickResult,
    pickFolderResult: options.pickFolderResult === undefined ? null : options.pickFolderResult,
    probeResult: options.probeResult ?? null,
    probeReject: options.probeReject ?? null,
    probeDelayMs: options.probeDelayMs ?? 0,
    processScript: options.processScript ?? [],
    processResult: options.processResult ?? null,
    processReject: options.processReject ?? null,
    processHoldUntilCancel: options.processHoldUntilCancel ?? false
  };
  await page.addInitScript((d) => {
    (window as unknown as { __TAURI_INTERNALS__: Record<string, unknown> }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
        // Dialog plugin's open() call: invoke('plugin:dialog|open', { options }).
        if (cmd === 'plugin:dialog|open') {
          // Tauri's plugin-dialog open() forwards its options into the IPC
          // payload as `args.options`. `directory: true` means folder picker;
          // `directory: false` (or unset) means file picker.
          const isFolder =
            (args as { options?: { directory?: boolean } } | undefined)?.options?.directory ===
            true;
          if (isFolder) {
            return d.pickFolderResult;
          }
          return d.pickResult;
        }
        // Phase 3 probe: invoke('probe_media', { path }).
        if (cmd === 'probe_media') {
          if (d.probeDelayMs > 0) {
            await new Promise<void>((r) => setTimeout(r, d.probeDelayMs));
          }
          if (d.probeReject !== null) {
            // Wrap in Error so @typescript-eslint/prefer-promise-reject-errors is satisfied.
            // The plain-object payload is preserved as a property for callers that inspect it.
            const err = Object.assign(new Error(d.probeReject.i18nKey), d.probeReject);
            return Promise.reject(err);
          }
          if (d.probeResult !== null) {
            return d.probeResult;
          }
          // Sensible default — covers the wizard-shell.spec.ts walk-through.
          return {
            path: (args as { path?: string } | undefined)?.path ?? '/fixtures/sample.mp4',
            duration: 12,
            container: 'mov,mp4,m4a,3gp,3g2,mj2',
            codec: 'h264',
            ext: 'mp4',
            hasAudio: true,
            keyframes: [0, 2, 4, 6, 8, 10]
          };
        }
        // Phase 9 processing: invoke('process_media', { input, output, keptRanges, onEvent }).
        if (cmd === 'process_media') {
          const w = window as unknown as { __processCalls?: unknown[] };
          w.__processCalls = w.__processCalls ?? [];
          w.__processCalls.push({ ...args, onEvent: undefined });
          // The mock sees the LIVE Channel object pre-serialization —
          // drive its onmessage directly (spec §9.3).
          const channel = (args as { onEvent?: { onmessage?: (e: unknown) => void } } | undefined)
            ?.onEvent;
          for (const [i, ev] of d.processScript.entries()) {
            setTimeout(() => channel?.onmessage?.(ev), 15 * (i + 1));
          }
          const settleAfter = 15 * (d.processScript.length + 1);
          if (d.processHoldUntilCancel) {
            return new Promise((_resolve, reject) => {
              (
                window as unknown as { __pendingProcessReject?: (e: unknown) => void }
              ).__pendingProcessReject = reject;
            });
          }
          await new Promise<void>((r) => setTimeout(r, settleAfter));
          if (d.processReject !== null) {
            const err = Object.assign(new Error(d.processReject.i18nKey), d.processReject);
            return Promise.reject(err);
          }
          return (
            d.processResult ?? {
              outputPath: '/fixtures/out/sample-trimmed.mp4',
              finalDuration: 9,
              removedDuration: 3,
              segmentCount: 1
            }
          );
        }
        // Phase 10 DF-1 preview: invoke('plan_duration', { keptRanges, keyframes, duration }).
        // Faithfully mirror build_plan's snap policy so the planned value genuinely
        // DIFFERS from the editor's raw arithmetic (Σ kept widths): each range start
        // snaps FORWARD to the first keyframe >= start (ends are never snapped), and a
        // post-snap empty plan flags wouldBeTooNarrow — matching the Rust SelectionTooNarrow
        // abort. With no keyframes, starts pass through verbatim (== raw sum).
        if (cmd === 'plan_duration') {
          const a = args as
            | { keptRanges?: { start: number; end: number }[]; keyframes?: number[] }
            | undefined;
          const ranges = a?.keptRanges ?? [];
          const kfs = a?.keyframes ?? [];
          const MIN_CUT_DUR = 0.25; // mirror of src/lib/timeline/constants.ts
          const snapFwd = (t: number): number => {
            // ?? (not ||): a keyframe at 0.0 is a valid snap target, not a falsy miss.
            return kfs.find((kf) => kf >= t) ?? t; // no kf >= t → verbatim (collapse handles fate)
          };
          let planned = 0;
          for (const r of ranges) {
            const snappedStart = snapFwd(r.start);
            if (r.end - snappedStart < MIN_CUT_DUR) continue; // collapsed → dropped/aborted
            planned += r.end - snappedStart;
          }
          // Lone-or-all collapsed selection → empty plan → SelectionTooNarrow flag.
          const survived = ranges.some((r) => r.end - snapFwd(r.start) >= MIN_CUT_DUR);
          return { plannedDuration: survived ? planned : 0, wouldBeTooNarrow: !survived };
        }
        // Phase 9 cancel: invoke('cancel_processing').
        if (cmd === 'cancel_processing') {
          const w = window as unknown as { __pendingProcessReject?: (e: unknown) => void };
          if (w.__pendingProcessReject !== undefined) {
            const reject = w.__pendingProcessReject;
            delete w.__pendingProcessReject;
            setTimeout(() => {
              reject(
                Object.assign(new Error('cancelled'), {
                  kind: 'OperationCancelled',
                  i18nKey: null,
                  details: null
                })
              );
            }, 30);
          }
          return null;
        }
        // Phase 9 done actions: reveal_output / open_output.
        if (cmd === 'reveal_output' || cmd === 'open_output') {
          const w = window as unknown as { __openerCalls?: { cmd: string; path: unknown }[] };
          w.__openerCalls = w.__openerCalls ?? [];
          w.__openerCalls.push({ cmd, path: (args as { path?: unknown } | undefined)?.path });
          return null;
        }
        throw new Error(`unmocked Tauri IPC: ${cmd}`);
      },
      // Tauri's transformCallback returns a numeric id used for event-callback
      // routing. The Channel constructor calls this to register its callback.
      transformCallback: () => Math.floor(Math.random() * 1e9),
      // Channel teardown calls unregisterCallback; provide a no-op (N23).
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      unregisterCallback: () => {}
    };
  }, data);
}
