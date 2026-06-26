# Sketch Manifest

## Design Direction

Unified timeline editor for EasyClip — one view replacing the old two-mode wizard (trim-sides + remove-sections). Side anchors for trimming ends, hover-revealed middle cuts for removing interior sections, both coexisting on one timeline. Design inherits Phase 4's calm-blue + clean-neutral aesthetic established in `src/app.css`. Target audience: non-technical users ("anyone who can click a button") — so affordances must be discoverable on first hover, no tutorial.

## Reference Points

- Phase 4 shipped UI (calm-blue brand, clean neutrals, Phase 4 @theme tokens)
- iMovie-level simplicity for primary user; Premiere-style precision as ceiling
- YouTube trim tool for the drag-to-select gesture familiarity

## Concept Source

- `.planning/notes/unified-timeline-editor-concept.md` — design decisions from `/gsd-explore`
- `.planning/seeds/preview-and-undo-unified-editor.md` — three deferred UX questions (cut-delete, preview, undo)

## Sketches

| #   | Name             | Design Question                                                                                                                | Winner                                                                                                                                                                                                               | Tags                              |
| --- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| 001 | editor-main-view | What does the unified timeline editor look like before the first cut? (layout, track visual, side-anchor affordance, playback) | **D** — Dynamic: calm brand bar base (from A) + data-driven waveform overlay (from C), adaptive fallback when file is silent                                                                                         | layout, track, anchors            |
| 002 | cut-treatment    | What does a placed "going out" region look like? How do cut-edge handles differ from side anchors?                             | **A (a11y-refined)** — red overlay with diagonal micro-stripe texture, horizontal-grip handles (vs anchors' vertical), ✂ scissors-icon label prefix; satisfies WCAG 1.4.1 "Use of Color" for protanopia/deuteranopia | cut, anchors, visual-intent, a11y |
| 003 | merge-prompt     | How does the "merge with existing cut?" confirmation appear without breaking flow?                                             | **A** — inline floating tooltip above the cursor's release point, small footprint, two buttons (Cancel / Merge), downward arrow anchor                                                                               | confirmation, overlap             |
