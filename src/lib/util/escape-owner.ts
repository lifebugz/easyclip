// A registry of overlays that currently own the Escape key.
//
// Independently-mounted `<svelte:window onkeyup>` handlers (e.g. ConfirmModal's
// Escape-to-cancel and the timeline's Escape-to-cancel-gesture) must coordinate
// so a single Escape doesn't fire two actions at once. The previous mechanism
// had the timeline query `document.querySelector('dialog[open]')` — which only
// matches native <dialog> and couples to its close timing. This registry is
// type-agnostic (any overlay can own Escape) and is driven from each modal's
// open-state effect, so it tracks open/close without touching the DOM.
//
// Timing (LOAD-BEARING — verified by real-build WKWebView UAT, where Escape only
// reaches JS as a keyup). Both overlays listen on `window` keyup. The modal's
// listener runs first because ConfirmModal is mounted UNCONDITIONALLY from app
// start (WizardShell), while the timeline mounts only on the edit step — so the
// modal's window listener registers, and fires, first (template order is not
// registration order here). The defer is robust even if that order ever flipped:
// a timeline-first listener would see the still-registered owner and stand down
// too. When the modal's keyup fires, its onCancel
// sets open=false, which (a) runs a SYNCHRONOUS Svelte flush that closes the
// <dialog> and runs this registration effect's cleanup, and (b) is followed by a
// microtask checkpoint BEFORE the timeline's listener runs — on a user-initiated
// dispatch the JS stack empties between window listeners, so queued microtasks
// drain there. So an inline removal AND a queueMicrotask removal BOTH land before
// the timeline's keyup, which then sees no owner and double-fires (dismisses the
// merge prompt behind the modal). The real-build UAT confirmed both failing.
//
// The unregister therefore defers to a MACROTASK (setTimeout 0): a macrotask
// cannot run until the entire input task — every keyup listener plus its
// microtasks — has finished, so the owner stays live through the whole Escape
// and clears immediately after. This is also why the registry is strictly more
// correct than the old `document.querySelector('dialog[open]')` check, whose
// [open] attribute is already stripped by dialogEl.close() in that first flush.

const owners = new Set<symbol>();
const pendingRemovals = new Map<symbol, ReturnType<typeof setTimeout>>();

export function registerEscapeOwner(id: symbol): void {
  // Cancel a pending removal for this id: callers re-register a STABLE per-instance
  // symbol (ConfirmModal's escapeId), so an open→false→true flip inside ONE task
  // would otherwise let the close's deferred delete fire after the reopen and drop
  // a live owner - isEscapeOwned() false with a modal open, and the next Escape
  // double-fires. Registration must win over a not-yet-settled unregistration.
  const pending = pendingRemovals.get(id);
  if (pending !== undefined) {
    clearTimeout(pending);
    pendingRemovals.delete(id);
  }
  owners.add(id);
}

export function unregisterEscapeOwner(id: symbol): void {
  // Deferred to a MACROTASK by design - see the "Timing" note above (a microtask
  // is NOT enough: it drains between the two window keyup listeners).
  const existing = pendingRemovals.get(id);
  if (existing !== undefined) clearTimeout(existing);
  pendingRemovals.set(
    id,
    setTimeout(() => {
      owners.delete(id);
      pendingRemovals.delete(id);
    }, 0)
  );
}

/** True when any overlay currently owns Escape (i.e. a modal is open). */
export function isEscapeOwned(): boolean {
  return owners.size > 0;
}
