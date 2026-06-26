---
sketch: 002
name: cut-treatment
question: "What does a placed 'going out' region look like on the timeline? How do cut-edge handles differ from the brand-blue side anchors?"
winner: 'A (accessibility-refined)'
tags: [cut, visual-intent, handles, overlay]
---

# Sketch 002: Cut Treatment

## Design Question

The concept locks that cuts are regions the user marks to REMOVE. This sketch asks: **what visual treatment most clearly communicates "this part is going away"?** The treatment must:

1. Be **unambiguous** — users should not confuse a cut region with a selection, a highlight, or a "focus" area. Red (destructive) is the obvious anchor, but HOW red is the question.
2. Be **compatible with the D track** (bar + adaptive waveform overlay from sketch 001) — the cut treatment has to read clearly ON TOP of the wave overlay without drowning it.
3. Keep **cut-edge handles visually distinct from side anchors** — if they look the same, users can't tell which controls trim the ends and which mark middle cuts.

All three variants show the SAME 2-minute clip with two middle cuts placed (0:50→1:05 and 1:30→1:45) on top of the D track. Side anchors are at the outer edges (no side trimming in this mockup so you can compare anchor vs cut-edge-handle treatment directly).

## How to View

```bash
open .planning/sketches/002-cut-treatment/index.html
```

## Variants

All three variants share identical:

- App shell, stepper, preview, playback controls
- D track visual (calm brand bar + waveform overlay)
- Brand-blue side anchors at outer edges
- Red cut-edge handles (8px wide, thin red bars with white grip line)
- Two cut regions at the same positions

Only the **cut region FILL** differs:

### A: Red semi-transparent overlay

Solid red at ~35% alpha. The waveform shows through, tinted red in the cut region. Edges are painted via `inset` box-shadow for crisp 2px red borders. Traditional video-editor convention — users coming from iMovie / Premiere / YouTube will recognize it immediately. Most direct mapping: "red = gone."

### B: Diagonal stripes

Repeating 45° red stripes (alternating 50% alpha and 15% alpha). Reads more unambiguously as "void / excluded" — the stripe pattern is the universal symbol for "this slot is disabled." Less intuitive than A's red wash for the "going out" meaning, but harder to mistake for a selection. Waveform still shows through the gaps.

### C: Desaturate (gray vs color)

Inverts the rhetoric: instead of painting the cut region red, it **grays out** the cut region (via `backdrop-filter: grayscale(1)`). The KEPT portions show the vibrant blue waveform; the CUT portions show a gray echo of it. Dashed red borders mark the edges for disambiguation. The mental model is "the final video is what stays colorful" — and you see it directly. Most cognitively novel; also the one that scales best visually when the cut count grows (5+ cuts) because gray is quieter than red.

## What to Look For

1. **Scannability at a glance** — which variant answers "what's the final clip going to look like?" fastest?
2. **Cut-edge handle vs side-anchor differentiation** — with your eye jumping between the left edge (blue anchor) and the first cut's left edge (red handle), do they feel clearly like different control types? Or are you second-guessing?
3. **Compatibility with waveform** — does the cut treatment swallow the waveform, or does the waveform still read inside the cut region? (A partially swallows; B shows through the gaps; C desaturates but keeps shape.)
4. **Emotional tone** — A feels urgent/destructive ("lots of red on screen"); B feels technical ("this slot is unavailable"); C feels calm/editorial ("this is what you're keeping").
5. **Many-cut scalability** — imagine 4-5 cuts on a 10-minute video. Does the variant still read cleanly, or does the screen feel overwhelmed?
6. **Cut label placement** — each cut shows a small red badge above (e.g., "0:50 → 1:05 (–15s)"). Does it help or clutter?
7. **The "cuts summary" chip** below the timeline ("2 cuts — removing 30 seconds. Final clip: 1:30.") — is that informative or redundant given the visual?

## Variant Comparison Matrix

| Variant            | Clarity of intent            | Waveform readability     | Many-cut scalability         | Tone                   |
| ------------------ | ---------------------------- | ------------------------ | ---------------------------- | ---------------------- |
| A Red overlay      | High (familiar)              | Medium (tinted)          | Medium (redness accumulates) | Urgent, destructive    |
| B Diagonal stripes | High (symbolic)              | High (gaps show through) | Medium (pattern accumulates) | Technical, unambiguous |
| C Desaturate       | Very high (inverse rhetoric) | High (shape preserved)   | Excellent (gray is quiet)    | Calm, editorial        |

## Accessibility Refinement (applied to variant A, the winner)

User selected variant A with an explicit requirement: **must be accessible for color-blind users.** Red is the most commonly-affected color in color-vision deficiencies (protanopia / deuteranopia — ~8% of men), so a "red fill = cut" design that relies on color alone violates WCAG 1.4.1 ("Use of Color"). Three non-color redundancies were added:

1. **Subtle diagonal micro-stripe texture overlaid on the red fill** — 8% white alpha, 135° repeating pattern, barely visible to color-sighted users (reads as soft texture) but clearly perceptible to users whose red desaturates toward brown. The pattern + the red together make the cut region identifiable in ANY vision mode.

2. **Cut-edge handle grips flipped from vertical → horizontal white lines** — side anchors retain their vertical grip pattern (2 vertical white lines on the blue bar); cut-edge handles use 2 horizontal white lines on the red bar. A user who sees both as "brownish bars" can still tell them apart by the direction of the grip marks. Color-free control-type differentiation.

3. **Scissors icon (`✂`) prefix on cut labels** — e.g., the label now reads "✂ 0:50 → 1:05 (–15s)". A non-color semantic symbol that screen readers announce and color-blind users see as "this means cut / removed." Reinforces intent independent of hue.

**Plus:** red borders and handle fills darkened from `#dc2626` → `#991b1b` for stronger contrast across all vision modes. Border thickness increased from 2px → 3px so it survives even when red washes toward beige in deuteranopic rendering.

**Verification approach (for Phase 5/6 execution):** simulate protanopia/deuteranopia/tritanopia with a browser extension (e.g., Chrome's "Emulate vision deficiency" in DevTools → Rendering) and verify that cut regions remain clearly distinguishable from kept regions AND from side-anchor controls. WCAG 1.4.1 Level A requires this — audit in Phase 10 A11Y-01.

## Implementation Notes (if this variant wins)

- **A:** `background: rgba(220,38,38,0.35)` + `box-shadow: inset 2px 0 0 red, inset -2px 0 0 red`. One absolutely-positioned div per cut. Trivial.
- **B:** `background: repeating-linear-gradient(135deg, ...)` — same positioning as A, just swap the `background` property. Slightly higher paint cost but unnoticeable at timeline sizes.
- **C:** `backdrop-filter: grayscale(1) brightness(1.05)` — requires checking WebView2 / WebKit `backdrop-filter` support in Tauri 2 (all modern browsers support it, but verify on Windows' WebView2). Fallback: solid gray overlay at 65% alpha (degraded but still functional). Dashed border via `border-left: 2px dashed red`.
- **Cut-edge handles** (shared across variants): 8px wide, red fill (#b91c1c), white grip line inside, arrow-notch-like indent at top/bottom. Use `cursor: ew-resize`. These must extend slightly above/below the track (3px each side) so they're grabbable even when the cut region is narrow.
