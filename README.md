# EasyClip

[![CI](https://github.com/lifebugz/easyclip/actions/workflows/ci.yml/badge.svg)](https://github.com/lifebugz/easyclip/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Platforms](https://img.shields.io/badge/platforms-macOS%20%7C%20Windows-lightgrey)

A simple, cross-platform desktop media trimmer for non-technical users. Trim
video and audio without learning complex software: drag the side anchors to
trim the ends, click the timeline to remove middle sections. Every cut is
**lossless** via FFmpeg stream-copy / concat-demuxer — **zero re-encoding**.

Bilingual **English + Hebrew** with full right-to-left (RTL) layout.

> Status: pre-1.0, in active development.

## Features

- Lossless trimming — FFmpeg stream-copy + concat-demuxer, no re-encode
- Drag side anchors to trim ends; click the timeline to cut middle sections
- Keyframe-aware cut placement
- Visual playback preview with a decorative waveform
- Bilingual EN / HE with full RTL layout
- macOS and Windows

## Install

Download installers from the
[latest release](https://github.com/lifebugz/easyclip/releases/latest).

### macOS (Apple Silicon only)

Via [Homebrew](https://brew.sh):

```bash
brew install --cask lifebugz/tap/easyclip
```

Or download the `.dmg` from the latest release and drag EasyClip into
Applications.

Builds are ad-hoc signed and not notarized by Apple, so Gatekeeper blocks the
first launch. Open the app once to trigger the block, then approve it under
**System Settings → Privacy & Security → "Open Anyway"**. On older macOS you
can instead right-click the app and choose **Open**. You can also clear the
quarantine flag from a terminal:

```bash
xattr -dr com.apple.quarantine /Applications/EasyClip.app
```

There is no Intel (x86_64) macOS build.

### Windows (x64)

Download and run the `*-setup.exe` (or the `.msi`) from the latest release.
The installers are unsigned, so Windows SmartScreen may warn on first run.
Choose **More info → Run anyway** to continue.

### Linux

Unsupported. CI attaches `.AppImage` / `.deb` artifacts to each release, but
they are untested. Use at your own risk.

## Built with

Tauri 2 · Svelte 5 / SvelteKit · Bun · Tailwind CSS v4 · FFmpeg (LGPL sidecar)

## Build from source

Prerequisites: [Bun](https://bun.sh) (latest), Rust stable via `rustup` (with
`clippy` + `rustfmt`), and the platform webview toolchain (see
[CONTRIBUTING.md](CONTRIBUTING.md) for the per-OS dependency list).

```bash
bun install --frozen-lockfile
bunx svelte-kit sync          # generates the gitignored .svelte-kit/tsconfig.json
bun run setup:ffmpeg          # fetches the SHA-256-pinned LGPL FFmpeg sidecar (never committed)
bun run dev                   # run the app in development
bun run build                 # build a release bundle
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). PRs use Conventional Commits and are
squash-merged into `main`; CI runs on the macOS / Windows / Ubuntu matrix.
Substantial features get a dated design doc (`docs/*-design.md`).

## Security

See [SECURITY.md](SECURITY.md). Report vulnerabilities privately via GitHub's
Security tab — please do not open public issues for security reports.

## License

EasyClip's source code is licensed under the [MIT License](LICENSE).

Distributed builds bundle **FFmpeg / ffprobe** as separate sidecar
executables, which are licensed under the **GNU LGPL-2.1-or-later** — see
[NOTICE](NOTICE) and [THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md).

## Acknowledgements

[FFmpeg](https://ffmpeg.org/) · [Tauri](https://tauri.app/) and the upstream
FFmpeg build mirrors (ffmpeg.martin-riedl.de, evermeet.cx, BtbN/FFmpeg-Builds).
