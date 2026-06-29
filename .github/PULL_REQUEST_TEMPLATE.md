## Summary

<!-- What does this PR do? Link issues with "Closes #123". -->

> **PR title must be a Conventional Commit** (e.g. `feat(timeline): …`) — it
> becomes the squash commit message.

## Checklist

- [ ] `bun run check` passes locally
- [ ] `bunx playwright test` passes (or N/A)
- [ ] Rust `bun run test:layer1` / wdio `bun run test:layer2` if relevant
- [ ] No hardcoded user-facing strings (i18n) and no physical CSS axes (RTL) — `scan:*` guards pass
- [ ] Added/updated a design doc for substantial changes
- [ ] Screenshots/GIF for UI changes, including an RTL/Hebrew shot
- [ ] Targets `main`; will be squash-merged

CI runs on the macOS / Windows / Ubuntu matrix.
