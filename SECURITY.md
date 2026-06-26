# Security Policy

## Supported versions

EasyClip is pre-1.0. Only the latest release and the current `main` branch
receive security fixes.

| Version               | Supported |
| --------------------- | --------- |
| `main` / latest release | ✅ |
| older 0.x             | ❌ |

## Reporting a vulnerability

Please report security vulnerabilities **privately** through GitHub's Private
Vulnerability Reporting:

1. Open the repository's **Security** tab.
2. Click **Report a vulnerability**.
3. Complete the advisory form.

**Do not open a public issue for security reports.** We aim to acknowledge
reports within 7 days and to coordinate disclosure once a fix is available.

## Scope

In scope for this repository:

- How EasyClip invokes and sandboxes the bundled FFmpeg / ffprobe sidecar.
- Integrity of the sidecar fetch pipeline and the SHA-256 pins in
  `scripts/ffmpeg-checksums.json`.
- The Tauri capability/permission model, the `asset://` protocol scope, and
  the filesystem (FsScope) media allowlist.
- The build/release supply chain (GitHub Actions workflows).

Out of scope — please report upstream instead:

- Vulnerabilities in **FFmpeg** itself → the FFmpeg project.
- Vulnerabilities in **Tauri, Bun, or other dependencies** → upstream
  (Dependabot tracks known CVEs in this repo).
