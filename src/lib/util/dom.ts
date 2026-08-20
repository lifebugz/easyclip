// Shared DOM predicates for keyboard handlers.

/**
 * True when the event target is a text-entry control that should swallow
 * app-level keyboard shortcuts (Escape, Delete/Backspace, Cmd/Ctrl+O, …).
 *
 * Centralises the INPUT/TEXTAREA rule so every window/document key handler
 * agrees on what counts as "the user is typing" — extend it HERE (e.g. to add
 * contentEditable or SELECT) instead of editing each call site, which used to
 * carry its own copy of the check.
 */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  // `instanceof HTMLElement` (not a bare cast): these handlers live on
  // <svelte:window>, so the target is often `window`/`document`, which have no
  // `.tagName`. The cast made `.tagName` read `undefined` (still correct today),
  // but a future extension reading Element-only props (`el.isContentEditable`,
  // `el.matches(...)`) — exactly what the doc above invites — would throw on a
  // non-Element target. The guard keeps this helper safe to extend.
  if (!(target instanceof HTMLElement)) return false;
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';
}
