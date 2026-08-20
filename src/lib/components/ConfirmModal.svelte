<script lang="ts">
  import { untrack } from 'svelte';
  import { t, type TranslationKey } from '$lib/i18n/index.svelte';
  import { isTextEntryTarget } from '$lib/util/dom';
  import { registerEscapeOwner, unregisterEscapeOwner } from '$lib/util/escape-owner';

  interface Props {
    open: boolean;
    titleKey: TranslationKey;
    bodyKey: TranslationKey;
    confirmKey: TranslationKey;
    cancelKey: TranslationKey;
    danger?: boolean;
    id?: string;
    onConfirm: () => void;
    onCancel: () => void;
  }

  let {
    open,
    titleKey,
    bodyKey,
    confirmKey,
    cancelKey,
    danger = false,
    id,
    onConfirm,
    onCancel
  }: Props = $props();

  // Per-instance ids so two modals never collide on aria-labelledby/describedby.
  // Computed ONCE (const, not $derived) — a $derived would regenerate the UUID.
  // untrack() reads the prop's initial value without subscribing: the snapshot
  // is deliberate, and it silences svelte's state_referenced_locally lint.
  const uid = untrack(() => id) ?? crypto.randomUUID();
  const titleId = `${uid}-title`;
  const bodyId = `${uid}-body`;
  // Stable per-instance token for the Escape-ownership registry (see below).
  const escapeId = Symbol('confirm-modal');

  let dialogEl: HTMLDialogElement | null = $state<HTMLDialogElement | null>(null);

  // While open, claim the Escape key so the timeline's window keyup handler
  // (gesture-cancel / merge-prompt-dismiss) stands down — one Escape, one action.
  // The cleanup unregisters on open→false (or unmount); the registry DEFERS the
  // actual removal to a macrotask, so the owner survives the whole keyup dispatch
  // even though Svelte flushes this cleanup mid-dispatch (this modal's keyup
  // handler runs before the timeline's). See util/escape-owner.ts for the timing.
  $effect(() => {
    if (!open) return;
    registerEscapeOwner(escapeId);
    return () => {
      unregisterEscapeOwner(escapeId);
    };
  });

  // Drive the native modal state from the `open` prop. showModal() throws if
  // called on an already-open dialog, and close() is a no-op on a closed one,
  // so we guard explicitly.
  $effect(() => {
    if (dialogEl === null) return;
    if (open && !dialogEl.open) {
      dialogEl.showModal();
    } else if (!open && dialogEl.open) {
      dialogEl.close();
    }
  });

  // The browser fires a 'cancel' event when Escape is pressed; the dialog
  // closes automatically, but we still need to notify the parent so the
  // gating logic in WizardShell can clear its pending state.
  function handleCancel(e: Event): void {
    e.preventDefault(); // we control close via the `open` prop, not directly
    onCancel();
  }

  // Click outside the modal body (the dialog itself receives the click when
  // the user clicks the backdrop) cancels too.
  function handleBackdropClick(e: MouseEvent): void {
    if (e.target === dialogEl) onCancel();
  }

  // WKWebView swallows the Escape KEYDOWN below all JS listeners, but the
  // KEYUP reaches web content (verified Phase 7; Timeline.svelte uses the same
  // pattern). The native oncancel never fires in WebKit, so this is the only
  // Escape path that works in the real build. Guarded by `open` so it no-ops
  // when closed; INPUT/TEXTAREA ignored to match the app-wide rule.
  function handleEscapeKeyup(e: KeyboardEvent): void {
    if (!open) return;
    if (e.key !== 'Escape') return;
    if (isTextEntryTarget(e.target)) return;
    onCancel();
  }
</script>

<svelte:window onkeyup={handleEscapeKeyup} />

<dialog
  bind:this={dialogEl}
  oncancel={handleCancel}
  onclick={handleBackdropClick}
  class="rounded-lg border border-gray-200 p-0 shadow-xl backdrop:bg-black/40"
  aria-labelledby={titleId}
  aria-describedby={bodyId}
>
  <div class="max-w-md p-6">
    <h3 id={titleId} class="text-lg font-semibold">{t(titleKey)}</h3>
    <p id={bodyId} class="mt-2 text-gray-700">{t(bodyKey)}</p>
    <div class="mt-6 flex justify-end gap-2">
      <button type="button" class="rounded border px-4 py-2" onclick={onCancel}>
        {t(cancelKey)}
      </button>
      <button
        type="button"
        class={['rounded px-4 py-2 text-white', danger ? 'bg-red-700' : 'bg-brand-700']}
        onclick={onConfirm}
      >
        {t(confirmKey)}
      </button>
    </div>
  </div>
</dialog>
