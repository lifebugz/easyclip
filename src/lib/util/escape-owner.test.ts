import { test, expect, beforeEach } from 'bun:test';
import { registerEscapeOwner, unregisterEscapeOwner, isEscapeOwned } from './escape-owner';

const macrotask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// The registry is module-global and `unregisterEscapeOwner` removes ids on a
// deferred macrotask, so let any pending removals from the previous test settle
// before each one to keep them isolated.
beforeEach(macrotask);

test('registering an owner makes isEscapeOwned() true; a settled unregister clears it', async () => {
  const id = Symbol('modal');
  expect(isEscapeOwned()).toBe(false);
  registerEscapeOwner(id);
  expect(isEscapeOwned()).toBe(true);
  unregisterEscapeOwner(id);
  await macrotask();
  expect(isEscapeOwned()).toBe(false);
});

test('unregister DEFERS removal to a macrotask: survives the sync dispatch AND a microtask checkpoint', async () => {
  const id = Symbol('modal');
  registerEscapeOwner(id);
  unregisterEscapeOwner(id);
  // LOAD-BEARING regression guard for the real-build WKWebView double-fire. Both
  // the modal's and the timeline's Escape handlers live on `window` keyup; the
  // modal's runs first and closes itself (firing this unregister mid-dispatch),
  // and a microtask checkpoint runs before the timeline's handler. So the owner
  // must survive BOTH the synchronous return AND a microtask, clearing only on a
  // macrotask (after the whole event dispatch). A synchronous removal fails the
  // first assert; a queueMicrotask removal fails the second — both of which the
  // UAT proved double-fire. Only the macrotask defer passes all three.
  expect(isEscapeOwned()).toBe(true); // synchronous: still owned
  await Promise.resolve(); // a microtask checkpoint: STILL owned (this is what a microtask defer got wrong)
  expect(isEscapeOwned()).toBe(true);
  await macrotask(); // input task is over → cleared
  expect(isEscapeOwned()).toBe(false);
});

test('isEscapeOwned() stays true while any other owner remains registered', async () => {
  const a = Symbol('a');
  const b = Symbol('b');
  registerEscapeOwner(a);
  registerEscapeOwner(b);
  unregisterEscapeOwner(a);
  await macrotask(); // a's deferred removal runs; b still owns
  expect(isEscapeOwned()).toBe(true);
  unregisterEscapeOwner(b);
  await macrotask();
  expect(isEscapeOwned()).toBe(false);
});

test('a close→reopen within ONE task keeps the owner registered', async () => {
  // ConfirmModal's escapeId is a STABLE per-instance symbol, so an open→false→true
  // flip inside a single task (two queued confirmations, or a confirm handler that
  // immediately raises another) re-registers the SAME id while the close's deferred
  // removal is still pending. Unless that timer is cancelled it fires afterwards and
  // deletes a live owner - isEscapeOwned() then reads false with a modal open, and
  // the next Escape double-fires: the modal cancels AND the timeline dismisses the
  // merge prompt behind it. That is exactly what this registry exists to prevent.
  const id = Symbol('modal');
  registerEscapeOwner(id);
  unregisterEscapeOwner(id); // close
  registerEscapeOwner(id); // reopen, same task, same symbol
  await macrotask(); // the close's stale timer fires here
  expect(isEscapeOwned()).toBe(true);
  unregisterEscapeOwner(id);
  await macrotask();
  expect(isEscapeOwned()).toBe(false);
});

test('a deferred removal is a no-op once the id is already gone (idempotent)', async () => {
  const id = Symbol('modal');
  registerEscapeOwner(id);
  unregisterEscapeOwner(id);
  unregisterEscapeOwner(id); // second call: also deferred, must not throw
  await macrotask();
  expect(isEscapeOwned()).toBe(false);
});
