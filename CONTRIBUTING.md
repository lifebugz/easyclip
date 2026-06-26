# Contributing to EasyClip

Thanks for your interest! EasyClip is a Tauri 2 + SvelteKit + Bun desktop app
that trims media losslessly via a bundled FFmpeg sidecar.

## Prerequisites

- **Bun** (latest) — https://bun.sh
- **Rust** stable via `rustup`, with `clippy` and `rustfmt` (MSRV 1.82)
- **Linux only** webview deps (from CI): `libwebkit2gtk-4.1-dev libssl-dev
  libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev patchelf`

## Setup

```bash
git clone https://github.com/lifebugz/easyclip.git
cd easyclip
bun install --frozen-lockfile
bunx svelte-kit sync          # REQUIRED first run: creates the gitignored
                              # .svelte-kit/tsconfig.json the root tsconfig extends;
                              # without it, type checks fail with hundreds of errors.
bun run setup:ffmpeg          # fetches the SHA-256-verified LGPL FFmpeg sidecar (never committed)
```

## Validate before pushing

```bash
bun run check                 # eslint, prettier --check, tsc, svelte-check,
                              # cargo check/clippy -D warnings/fmt, the scan:* guards,
                              # unit tests, and the sidecar smoke test
bunx playwright test          # end-to-end (Playwright)
bun run test:layer1           # Rust integration (cargo test), if you touched Rust
bun run test:layer2           # WebDriver (wdio), if relevant
```

## House rules

- **Conventional Commits** (`feat(scope): …`, `fix(scope): …`, `chore: …`).
  The repo **squash-merges**, so your **PR title becomes the commit message** —
  make it a valid Conventional Commit.
- Branch off `main`, open a PR **into** `main`. CI must be green on the
  macOS / Windows / Ubuntu matrix before merge.
- **No hardcoded user-facing strings** (enforced by `scan-hardcoded-strings`)
  and **no physical CSS axes** — use logical properties for RTL (enforced by
  `scan-physical-axes`).
- Substantial features get a dated design doc named
  `YYYY-MM-DD-<slug>-design.md` before code. (Note: `docs/superpowers/` is a
  local-only convention and is not committed.)
- The **FFmpeg sidecar is version-pinned manually** via
  `scripts/update-ffmpeg-hashes.ts` / `scripts/ffmpeg-checksums.json` — it is
  **not** managed by Dependabot, so it must be bumped deliberately.

## Reporting bugs / requesting features

Use the issue forms (Bug report / Feature request). For security issues, see
[SECURITY.md](SECURITY.md) — do not open a public issue.
