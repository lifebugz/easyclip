cask "easyclip" do
  version "0.2.0"
  sha256 "87c8548b878e35ab6a7a802e9c4512a829a28305924456632909f5f3313d1e42"

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

      • Right-click EasyClip in your Applications folder, choose "Open", and
        confirm in the dialog, or
      • Run:
          xattr -dr com.apple.quarantine "#{appdir}/EasyClip.app"

    EasyClip ships for Apple Silicon (arm64) only - there is no Intel build.
  EOS
end
