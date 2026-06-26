//! FFmpeg integration: media probing data model + probe / invoker submodules.

pub mod concat;
pub mod invoker;
pub mod probe;
pub mod progress;
pub mod trim;

use serde::Serialize;
use std::path::Path;

/// MAX_KF cap from amendment §3.5. Adversarial inputs (all-keyframe encodes,
/// 60fps × 4-hour videos) can push counts past 100k at f64 ≈ 800 KB across
/// IPC. The cap returns an empty list rather than a truncated list (partial
/// snap is worse than no snap). Frontend interprets empty as "snap disabled".
pub const MAX_KF: usize = 50_000;

/// Probed media metadata. Serialised across the IPC boundary as the success
/// payload of `probe_media`. Field names use camelCase on the wire to match
/// TypeScript convention (the Rust struct uses snake_case for idiomatic Rust).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    /// Absolute path the file was probed from (validated upstream).
    pub path: String,
    /// Duration in seconds as parsed from the probe.
    pub duration: f64,
    /// Container format name (e.g. "mov,mp4,m4a,3gp,3g2,mj2", "matroska,webm").
    pub container: String,
    /// Primary video codec name (e.g. "h264", "vp9"). Empty string when no
    /// video stream is present.
    pub codec: String,
    /// Canonical extension WITHOUT the leading dot (e.g. "mp4", "mov", "mkv").
    pub ext: String,
    /// True if any audio stream is present.
    pub has_audio: bool,
    /// Ascending video-keyframe timestamps in seconds, capped at MAX_KF.
    /// Empty when the actual count exceeds MAX_KF (snap disabled).
    pub keyframes: Vec<f64>,
}

/// Derive the canonical extension from a path. Lowercased, no leading dot,
/// empty string when the path has no extension.
pub fn derive_ext(path: &Path) -> String {
    path.extension()
        .and_then(|os| os.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

/// Containers whose finals get `-movflags +faststart` AND whose stderr is
/// watched for the moov-relocation marker (the two must never desync).
pub fn wants_faststart_ext(ext: &str) -> bool {
    matches!(ext, "mp4" | "mov" | "m4a")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derive_ext_lowercases_mixed_case() {
        assert_eq!(derive_ext(Path::new("clip.MP4")), "mp4");
        assert_eq!(derive_ext(Path::new("/tmp/a.MoV")), "mov");
        assert_eq!(derive_ext(Path::new("/tmp/a.MKV")), "mkv");
    }

    #[test]
    fn derive_ext_returns_empty_for_no_extension() {
        assert_eq!(derive_ext(Path::new("/tmp/no-ext")), "");
        assert_eq!(derive_ext(Path::new("/")), "");
    }

    #[test]
    fn derive_ext_strips_leading_dot() {
        assert_eq!(derive_ext(Path::new("/tmp/a.mp4")), "mp4");
    }

    #[test]
    fn derive_ext_handles_double_extensions() {
        // Path::extension only returns the last component; that's the canonical
        // ffmpeg-compatible extension we want.
        assert_eq!(derive_ext(Path::new("/tmp/clip.tar.gz")), "gz");
    }

    #[test]
    fn media_info_serializes_with_camelcase_keys() {
        let mi = MediaInfo {
            path: "/tmp/x.mp4".into(),
            duration: 5.0,
            container: "mov,mp4".into(),
            codec: "h264".into(),
            ext: "mp4".into(),
            has_audio: true,
            keyframes: vec![0.0, 1.0, 2.0],
        };
        let json = serde_json::to_string(&mi).unwrap();
        assert!(json.contains(r#""hasAudio":true"#), "got {json}");
        assert!(
            !json.contains(r#""has_audio""#),
            "expected camelCase only, got {json}"
        );
        assert!(json.contains(r#""ext":"mp4""#), "got {json}");
        assert!(json.contains(r#""keyframes":[0.0,1.0,2.0]"#), "got {json}");
    }

    #[test]
    fn max_kf_constant_matches_amendment() {
        assert_eq!(MAX_KF, 50_000);
    }
}
