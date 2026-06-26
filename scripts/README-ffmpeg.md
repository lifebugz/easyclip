# FFmpeg sidecar setup

`bun run setup:ffmpeg` downloads the LGPL FFmpeg static build for your current Rust target triple, SHA256-verifies it against `scripts/ffmpeg-checksums.json`, extracts it, and places the binary at `src-tauri/binaries/ffmpeg-<triple>{.exe}` per Tauri's sidecar naming convention.

## Sources

- macOS arm64: [evermeet.cx](https://evermeet.cx/ffmpeg/) — universal-static daily builds
- macOS x86_64: [ffmpeg.martin-riedl.de](https://ffmpeg.martin-riedl.de/) — static release builds for amd64
- Windows x64: [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds/releases) — `n8.1-latest` LGPL-shared
- Windows arm64: [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds/releases) — `n8.1-latest` LGPL-shared winarm64

Linux is CI-only; v1 doesn't ship Linux. The CI matrix builds against the BtbN Linux LGPL static for green Layer 1/2 runs.

## Updating to a new FFmpeg version

1. Bump `ffmpegVersion` and the URL templates in `scripts/ffmpeg-checksums.json`.
2. Run `bun run scripts/update-ffmpeg-hashes.ts` (Task 17) to fetch each target's new binary and compute its SHA256.
3. Commit the regenerated checksums.
4. Trigger the `regenerate-goldens.yml` workflow_dispatch action — Layer 3 framehash goldens are FFmpeg-version-dependent.
5. Open a PR and verify CI green on all 3 platforms.

## Why SHA256-pinned

Without pinning, a compromised mirror or a silently-rebuilt binary could swap our FFmpeg out from under us at the next CI run. Three reference apps we surveyed (LosslessCut, vibe, screenpipe) all skip this — we don't.
