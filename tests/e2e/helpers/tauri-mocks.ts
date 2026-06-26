import type { Page } from '@playwright/test';
import { MIN_CUT_DUR } from '../../../src/lib/timeline/constants';

export interface ProbeMockResult {
  path: string;
  duration: number;
  container: string;
  codec: string;
  ext: string;
  /**
   * Whether the file has a real video stream. Optional in the mock only: when
   * omitted it defaults to `codec !== ''` (the wire MediaInfo field is required,
   * but defaulting here mirrors the legacy heuristic so existing specs need no
   * edit). Set it explicitly — e.g. `hasRealVideo: true` with `codec: ''` — to
   * exercise a real video whose codec is unidentifiable.
   */
  hasRealVideo?: boolean;
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
  /**
   * Override the base URL that convertFileSrc uses. Defaults to the Tauri
   * `asset://localhost` scheme. Set to an HTTP origin+prefix (e.g.
   * `'http://localhost:5173/asset-stub'`) so Playwright e2e specs that need the
   * <video> to stay mounted can pair this with `page.route` to serve stub
   * responses — the `asset://` scheme causes an immediate Blink error that
   * unmounts the element before any Playwright poll. The VideoPreview src
   * assertion still proves that assetUrl(path) === convertFileSrc(path).
   */
  convertFileSrcBase?: string;
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
    processHoldUntilCancel: options.processHoldUntilCancel ?? false,
    convertFileSrcBase: options.convertFileSrcBase ?? null,
    // Single source of truth for the snap threshold — keeps the plan_duration
    // mock below from drifting from the Rust engine's MIN_CUT_DUR.
    minCutDur: MIN_CUT_DUR
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
            // hasRealVideo is required on the wire MediaInfo; default it from the
            // legacy codec heuristic when a spec doesn't set it explicitly.
            return {
              ...d.probeResult,
              hasRealVideo: d.probeResult.hasRealVideo ?? d.probeResult.codec !== ''
            };
          }
          // Sensible default — covers the wizard-shell.spec.ts walk-through.
          return {
            path: (args as { path?: string } | undefined)?.path ?? '/fixtures/sample.mp4',
            duration: 12,
            container: 'mov,mp4,m4a,3gp,3g2,mj2',
            codec: 'h264',
            ext: 'mp4',
            hasRealVideo: true,
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
        // Faithful mirror of the Rust build_plan (src-tauri/src/processing/plan.rs) so e2e
        // assertions about the FINAL readout match the REAL export, not a divergent shadow:
        //  - each range start snaps FORWARD to the first keyframe >= start (ends never snap);
        //  - a post-snap width < MIN_CUT_DUR collapses: silently DROP it iff the REQUESTED
        //    width is also < MIN_CUT_DUR, otherwise ABORT the whole plan (SelectionTooNarrow);
        //  - an empty plan after drops also aborts;
        //  - each segment weight clamps its end to `duration` (build_plan's effective_end).
        // SelectionTooNarrow maps to { plannedDuration: 0, wouldBeTooNarrow: true }.
        if (cmd === 'plan_duration') {
          const a = args as
            | {
                keptRanges?: { start: number; end: number }[];
                keyframes?: number[];
                duration?: number;
              }
            | undefined;
          const ranges = a?.keptRanges ?? [];
          const kfs = a?.keyframes ?? [];
          const total = a?.duration ?? 0;
          const minCut = d.minCutDur;
          const snapFwd = (t: number): number => {
            // ?? (not ||): a keyframe at 0.0 is a valid snap target, not a falsy miss.
            return kfs.find((kf) => kf >= t) ?? t; // no kf >= t → verbatim (collapse decides fate)
          };
          let planned = 0;
          let kept = 0;
          let aborted = false;
          for (const r of ranges) {
            const snappedStart = snapFwd(r.start);
            const postSnap = r.end - snappedStart;
            if (postSnap < minCut) {
              // Collapsed: sub-threshold REQUEST → silent drop; meaningful → abort whole plan.
              if (r.end - r.start < minCut) continue;
              aborted = true;
              break;
            }
            const effEnd = r.end >= total ? total : r.end; // clamp end to duration
            planned += effEnd - snappedStart;
            kept += 1;
          }
          if (aborted || kept === 0) return { plannedDuration: 0, wouldBeTooNarrow: true };
          return { plannedDuration: planned, wouldBeTooNarrow: false };
        }
        // Preview poster extraction: invoke('extract_poster_frame', { path, timeSeconds }).
        if (cmd === 'extract_poster_frame') {
          const w = window as unknown as { __posterCalls?: unknown[] };
          w.__posterCalls = w.__posterCalls ?? [];
          w.__posterCalls.push({ ...args });
          // A 1x1 canned JPEG (base64, no data: prefix — the wrapper adds it).
          return '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAAAv/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AvwAH/9k=';
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
      unregisterCallback: () => {},
      // convertFileSrc routes through __TAURI_INTERNALS__ directly, NOT invoke
      // (core.js). VideoPreview's assetUrl feature-detects this exact field; it
      // must exist or assetUrl returns null and every Edit-step test → art mode.
      // d.convertFileSrcBase overrides the URL base for specs that pair this
      // with page.route — the `asset://` scheme causes an immediate Blink error
      // in Playwright/Chromium that unmounts <video> before any assertion fires.
      convertFileSrc: (p: string, proto = 'asset'): string =>
        d.convertFileSrcBase !== null
          ? // Stub-base mode ignores `proto` (no caller passes a non-default
            // proto; the real asset:// host distinction is irrelevant to the
            // HTTP test stub).
            `${d.convertFileSrcBase}/${encodeURIComponent(p)}`
          : `${proto}://localhost/${encodeURIComponent(p)}`
    };
  }, data);
}
