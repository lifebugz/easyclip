// SvelteKit static-adapter requires SSR off and prerender on for full static output.
export const ssr = false;
export const prerender = true;

import { bootstrapPathSep } from '$lib/util/path';

// Prime the path-separator cache before the first +page.svelte renders so
// downstream $derived chains (e.g. SaveStep's outputPath in Phase 6) read a
// real platform separator synchronously. SvelteKit blocks render until this
// load resolves. Idempotent — safe to re-run on HMR.
export async function load(): Promise<Record<string, never>> {
  // bootstrapPathSep() now no-ops cleanly outside Tauri; no try/catch needed.
  await bootstrapPathSep();
  return {};
}
