---
sketch: 001
name: editor-main-view
question: "What does the unified timeline editor look like the moment before a user's first cut? (Layout, track visual, side-anchor affordance, playback controls.)"
winner: 'D'
tags: [layout, track, anchors, playback]
---

# Sketch 001: Unified Timeline Editor — Main View

## Design Question

The concept locks that there will be one unified editor with side anchors + middle cuts. This sketch asks: **what does that editor actually look like as a whole page?** The track's visual treatment especially — should it be a simple bar, a filmstrip of thumbnails, or an audio waveform — drives a lot of downstream decisions (contrast ratios, what handles can contrast against, info density).

## How to View

```bash
open .planning/sketches/001-editor-main-view/index.html
```

## Variants

- **A: Minimal bar** — The timeline is a flat brand-tinted band. Zero content detail inside the track. Simplest possible affordance; easiest to build; trades information density for visual calm. Best if you want the TIMELINE to be pure structure and let the PREVIEW video carry all the content semantics.

- **B: Filmstrip** — The timeline is a row of ~24 pseudo-thumbnails (CSS-drawn, not real frames). Gives immediate visual anchors ("oh, that's the part outside") so users can spot where they are without scrubbing. Higher implementation cost in the real app (requires generating thumbnails via FFmpeg at file-load time, which means a ~1-2s delay on the edit step).

- **C: Waveform** — The timeline shows an audio waveform (sine-envelope-based amplitude). Works for both audio-only files AND video-with-audio (the waveform becomes the video's audio track visual). Silent sections show as a flatter area — useful for finding "obvious cut points" at dialogue pauses. Implementation cost similar to filmstrip but cheaper (just needs audio decode, not thumbnail rendering).

- **D: Dynamic (synthesis of A + C)** — User-requested synthesis. Takes A's calm brand-tinted bar as the base visual frame, and layers C's waveform INSIDE it as a translucent data-driven overlay. "Dynamic" means three things:
  1. **Data-driven:** the waveform bars are computed from the real file's audio samples at load time (not hardcoded). In the sketch, the sine+noise envelope stands in for what a real FFmpeg decode would produce.
  2. **Context-aware:** if the file has no audio or is silent, the overlay automatically hides and the view falls back to pure A. The sketch has a demo toggle ("File has audio" / "Silent") above the timeline so you can feel the fallback.
  3. **Ambient, not dominant:** the overlay is rendered at ~55% opacity in a subtler blue shade so it supplements the bar rather than competing with it — keeping the calm aesthetic of A while adding C's scrubbing help when it's useful.

## What to Look For

1. **Track clarity at 72px height** — which variant lets you find a target position at a glance without scrubbing?
2. **Contrast with the blue side anchors** — on which variant do the anchors stand out most clearly as a different control type?
3. **"Cut cursor hint" plausibility** — when you imagine hovering the timeline, which variant most naturally hosts a cut-mark cursor affordance without visual conflict?
4. **Emotional tone** — A feels calm/spa-like; B feels like iMovie/YouTube; C feels more "pro-tool" / DAW-ish. Which matches the "anyone who can click a button" audience?
5. **The playhead** — it's a white vertical line in all variants; note which variant makes it easiest to see.

## Implementation Notes (if this variant wins)

- **A:** zero extra work; pure CSS; fastest to ship. Can be enhanced later by overlaying a lightweight duration indicator.
- **B:** needs FFmpeg `-i INPUT -vf fps=1/FRAME_INTERVAL -frames:v N thumbs/%03d.jpg` at file-load; ~1-2s cost on the edit step. Thumbnails should be cached in the OS temp dir (tauri-plugin-fs).
- **C:** needs audio-only decode to amplitude samples; either FFmpeg `-ac 1 -ar 8000 -f s16le -` piped to Rust for downsampling, or a JS-side Web Audio API pass over the decoded file. ~0.5-1s cost.
- **Synthesis candidate (if you like parts of multiple):** Waveform for video-with-audio + Minimal bar for video-without-audio + filmstrip as an advanced-user toggle.

## Variant Comparison Matrix

| Variant       | Build cost | Info density             | Scrubbing help                                        | Feels like       |
| ------------- | ---------- | ------------------------ | ----------------------------------------------------- | ---------------- |
| A Minimal bar | Trivial    | Low                      | None                                                  | Spa / calm       |
| B Filmstrip   | High       | High (visual)            | Strong                                                | iMovie / YouTube |
| C Waveform    | Medium     | High (audio)             | Strong for dialogue                                   | DAW / pro        |
| **D Dynamic** | Medium     | Medium (audio, adaptive) | Strong when audio exists, falls back to zero when not | Spa with a pulse |
