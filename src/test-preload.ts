// Svelte 5 rune stubs for Bun's test runner.
//
// Svelte 5 runes ($state, $derived, $effect, etc.) are compiler macros that
// the Svelte compiler transforms before code reaches the runtime. Bun's test
// runner doesn't run the Svelte compiler, so any .svelte.ts module that uses
// runes at module scope would crash with "ReferenceError: $state is not defined".
//
// This preload defines minimal pass-through stubs so that .svelte.ts modules can
// be imported in Bun tests. Reactivity is NOT active in tests — $state behaves as
// a plain let binding, $derived as a computed-once getter, $effect is a no-op.
// That is intentional and sufficient for unit-testing the logic layer.

function $state<T>(initial: T): T {
  return initial;
}

function $derived<T>(fn: () => T): T {
  return fn();
}

function $effect(fn: () => (() => void) | undefined): void {
  // no-op in test context — effects are not executed by Bun's runner
  void fn;
}

// Assign to globalThis so every module loaded after this preload sees them.
Object.assign(globalThis, { $state, $derived, $effect });
