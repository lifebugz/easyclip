---
sketch: 003
name: merge-prompt
question: "How does the 'merge with existing cut?' confirmation appear without breaking the drag flow? Where does it live on screen, and how does it relate visually to the overlap that triggered it?"
winner: 'A'
tags: [confirmation, overlap, interruption-surface]
---

# Sketch 003: Merge-Prompt

## Design Question

The concept locks that overlap triggers a confirmation — neither silent-snap (user loses intent) nor full modal (too heavy for a non-destructive decision). This sketch asks: **WHERE on screen does the prompt appear, and how visible is its relationship to the overlap that triggered it?**

Each variant shows the same frozen moment: one existing cut at 0:50→1:20, one PENDING new cut (dashed outline, slightly faded) at 1:10→1:42, and the 5-second overlap at 1:10→1:15. The merge prompt asks whether to fuse them into one cut covering 0:50→1:42, or discard the new cut.

## How to View

```bash
open .planning/sketches/003-merge-prompt/index.html
```

## Variants

### A: Inline floating tooltip

A small callout floats above the timeline, anchored roughly near the cursor's release position (right edge of the pending cut). Arrow points down. Minimum text: _"This cut overlaps an existing one. Merge them into one cut?"_ — with `Cancel` / `Merge` buttons.

**Pros:** closest to the user's attention (their cursor was just there). Fastest to acknowledge — no eye travel. Small footprint.

**Cons:** doesn't visually connect to the OVERLAP — the user might not understand which two cuts are being merged if they have more than one existing cut. Also, the prompt may cover other timeline content depending on position.

### B: Overlap-anchored popover

The prompt sits directly above the overlap region (1:10→1:15, the 5% slice where the cuts collide), with a tail pointing down at it. The overlap itself is highlighted with an amber box (border + 20% amber fill) to make the conflict location visually explicit. Prompt text references "this existing cut (highlighted)."

**Pros:** The relationship between the PROMPT and the CONFLICT is unambiguous. Works equally well for 1 cut or 10 cuts on the timeline — the user's eye is drawn to the exact place where the problem is. Best "teaching" UI — on first overlap, user learns what an overlap looks like.

**Cons:** Requires the prompt to calculate where the overlap is, which adds a tiny layout wrinkle (two cuts could overlap asymmetrically). More screen real estate consumed (the popover + the amber highlight).

### C: Bottom-of-screen toast

A thin horizontal bar slides up from the bottom of the app (above the footer, below the timeline). Left side: description text. Right side: `Cancel` / `Merge` buttons. No visual connection to the timeline — the prompt is always in the same fixed place, predictable.

**Pros:** Predictable location — users learn "prompts live here" and look there. Doesn't cover any timeline content. Very non-intrusive. Consistent with toast patterns in other apps (banking, productivity).

**Cons:** Requires eye travel from the cursor to the bottom of the screen. Loss of context — the user has to re-orient to find which cut is being discussed. Worst for the "teaching" case (first time overlap happens, user may not connect the toast to the overlap).

## What to Look For

1. **Time-to-comprehension** — which variant lets you, on first view, immediately understand what the prompt is asking about without reading the text twice?
2. **Scalability with many cuts** — imagine you have 5 cuts already, and your new cut overlaps #3. Which variant still makes it obvious which cut you're about to merge with?
3. **Eye travel** — after the prompt appears, how far does your eye have to travel to process it? Near zero for A, near zero for B (because you were already looking at the overlap), medium for C.
4. **State cycling** — try the demo state buttons ("Prompt showing" / "After merge" / "After cancel") above the preview. Do the result states feel right — does "after merge" make sense as one big cut, does "after cancel" cleanly remove the pending cut?
5. **Button click feedback** — clicking Merge or Cancel in the prompt itself cycles to the matching result state. Does the transition feel natural, or jarring?
6. **Button labels** — which variant's labels are clearest? A uses "Cancel / Merge" (minimal), B uses "Keep separate (cancel) / Merge" (explicit), C uses "Cancel (discard new cut) / Merge" (most explicit). Overcommunication helps non-technical users; is it worth the verbosity?

## Variant Comparison Matrix

| Variant           | Visible overlap link             | Prompt location predictability | Eye travel           | Scalability (many cuts) | Footprint                          |
| ----------------- | -------------------------------- | ------------------------------ | -------------------- | ----------------------- | ---------------------------------- |
| A Inline tooltip  | Weak (near cursor, not overlap)  | Low (floats near the cursor)   | Minimal              | Medium                  | Small                              |
| B Overlap popover | Strong (tail points at conflict) | Medium (follows overlap)       | Minimal              | Excellent               | Medium                             |
| C Bottom toast    | None (spatially disconnected)    | High (always same spot)        | Medium (down & back) | Fair                    | Smallest per-cut; fixed per-prompt |

## Implementation Notes (if this variant wins)

- **A:** absolutely position the prompt relative to the cursor's mouseup coordinates, clamping to the timeline bounds. On gesture end, compute `(x, y)` → set `left` / `top`. Simple; reuses the existing ConfirmModal component pattern minus the backdrop.
- **B:** compute the overlap range `[max(newStart, existStart), min(newEnd, existEnd)]` → position prompt centered above it, with an amber-highlight `<div>` at the overlap bounds. Slightly more code for the overlap-detection path, but the Rust side already computes overlap intersections for the merge logic — just hand that data to the UI. The extra amber `<div>` is purely presentational.
- **C:** position `fixed; bottom: 0` (or `sticky` above footer) inside the wizard content area. Simplest technically — no coordinate math, no tail positioning. CSS-only slide-up animation. Pattern can be reused for any future in-flow confirmations (Phase 7 cancel-in-progress, etc.).

## Accessibility Notes (all variants)

- All three variants use text + buttons (no color-only signaling) so they're inherently color-blind accessible.
- Variant B's amber overlap highlight is additive — the prompt TEXT already references the conflict, so the highlight is a visual enhancement, not a dependency.
- All prompts should trap focus when open (same pattern as Phase 4's ConfirmModal `<dialog>`) and dismiss on `Esc` = cancel.
- Screen readers: prompts should be `role="alertdialog"` with `aria-describedby` pointing at the descriptive text.
