#!/usr/bin/env bash
set -euo pipefail

# Single source of truth for the Homebrew cask text. Used by:
#   - the homebrew job in .github/workflows/release.yml (real bump), and
#   - .github/workflows/homebrew-dryrun.yml (plumbing smoke test).
# Per-release, CI substitutes only the version + DMG sha256 - never new Ruby - so
# brew style/audit lock this template's style once (tap PR #1) and `ruby -c` is
# the ongoing regression guard.
#
# Usage: render-brew-cask.sh <version> <dmg_sha256>   → cask ruby on stdout
#
# Callers MUST write the output via direct redirect (`> file`), never through a
# captured variable: command substitution strips the trailing newline, defeating
# the tap job's no-op diff and brew style's final-newline rule.

if [ "$#" -ne 2 ]; then
  echo "usage: render-brew-cask.sh <version> <dmg_sha256>" >&2
  exit 1
fi
VERSION="$1"
SHA256="$2"
# Never render garbage: a malformed version/sha still passes `ruby -c`, then
# fails at `brew install` with an opaque checksum/URL error. Fail loudly here.
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "render-brew-cask.sh: version '$VERSION' must match X.Y.Z" >&2
  exit 1
fi
if ! [[ "$SHA256" =~ ^[0-9a-f]{64}$ ]]; then
  echo "render-brew-cask.sh: sha256 '$SHA256' must be 64 lowercase hex chars" >&2
  exit 1
fi

# Quoted heredoc (<<'RUBY') + placeholder substitution: template text passes
# through byte-for-byte, immune to future $/backtick content (e.g. a livecheck
# regex) that an unquoted heredoc would silently mangle. The guards above make
# the sed replacements injection-safe (digits/dots/hex only).
sed -e "s/__VERSION__/${VERSION}/g" -e "s/__SHA256__/${SHA256}/g" <<'RUBY'
cask "easyclip" do
  version "__VERSION__"
  sha256 "__SHA256__"

  url "https://github.com/lifebugz/easyclip/releases/download/v#{version}/EasyClip_#{version}_aarch64.dmg"
  name "EasyClip"
  desc "Lossless video and audio trimmer"
  homepage "https://github.com/lifebugz/easyclip"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on macos: :big_sur
  depends_on arch: :arm64

  app "EasyClip.app"

  zap trash: [
    "~/Library/Application Support/com.easyclip.app",
    "~/Library/Caches/com.easyclip.app",
    "~/Library/HTTPStorages/com.easyclip.app",
    "~/Library/Preferences/com.easyclip.app.plist",
    "~/Library/Saved Application State/com.easyclip.app.savedState",
    "~/Library/WebKit/com.easyclip.app",
  ]

  caveats <<~EOS
    EasyClip is ad-hoc signed and is not notarized by Apple, so macOS Gatekeeper
    blocks it the first time you open it. To approve it once, either:

      • Open EasyClip once (macOS will block it), then click "Open Anyway"
        under System Settings > Privacy & Security (System Preferences >
        Security & Privacy on macOS 12 or earlier), or
      • Run:
          xattr -dr com.apple.quarantine "#{appdir}/EasyClip.app"

    EasyClip ships for Apple Silicon (arm64) only - there is no Intel build.
  EOS
end
RUBY
