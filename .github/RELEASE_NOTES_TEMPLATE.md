<!--
Append this footer beneath release-please's generated changelog on each GitHub Release.
(Future enhancement: have the publish job append it automatically via `gh release edit`.)
-->

---

## Installing an unsigned build

EasyClip is not yet code-signed or notarized, so your OS will warn you the first time.

**macOS (Apple Silicon):**

1. Download the `.dmg`, open it, and drag **EasyClip** to Applications.
2. Clear the download quarantine so the bundled FFmpeg sidecar can launch:
   ```bash
   xattr -dr com.apple.quarantine /Applications/EasyClip.app
   ```
3. Right-click **EasyClip → Open → Open** (only needed the first launch).

**Windows:** If SmartScreen shows "Windows protected your PC", click **More info → Run anyway**.

## FFmpeg license notice

EasyClip bundles unmodified prebuilt FFmpeg/ffprobe binaries as separate sidecar
executables (run as child processes, not linked). The bundled build's license
depends on the platform:

- **macOS and Linux** builds bundle FFmpeg (8.1 series) under
  **GPL-3.0-or-later** - ffmpeg.martin-riedl.de builds configured with
  `--enable-gpl` and `--enable-version3` (statically linking libx264, libx265).
- **Windows** builds bundle FFmpeg under **LGPL-2.1-or-later** - BtbN "lgpl"
  build, configured without `--enable-gpl`.

**Corresponding Source (GPL/LGPL):** the authoritative mechanism is our written
offer - for three (3) years from the date of this release, open an issue at
<https://github.com/lifebugz/easyclip/issues> and we will provide the complete
Corresponding Source for the exact bundled builds (FFmpeg plus the statically
linked GPL/LGPL libraries such as x264 and x265, plus the build scripts) at no
more than the cost of distribution. Upstream source locations are listed in the
bundled `NOTICE` file.

Full license texts and per-platform details are in `THIRD-PARTY-LICENSES.md`
and `NOTICE` inside the app bundle.
