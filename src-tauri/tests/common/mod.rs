//! Test helpers shared across Layer 1 integration tests.
//!
//! Generates lavfi-source media on demand into a TempDir; binaries are
//! never committed.
//!
//! Some helpers are only used by specific test binaries — the allow attr
//! suppresses the dead_code lint that would otherwise fire for the unused
//! helpers in each test binary's compilation unit.
#![allow(dead_code)]

use std::path::PathBuf;
use std::process::Command;
use tempfile::TempDir;

pub struct H264Fixture {
    /// Kept alive so the TempDir — and the fixture file inside it — isn't
    /// deleted while the test runs. The field is intentionally "unread".
    pub dir: TempDir,
    pub path: PathBuf,
}

/// L1/PathInvoker binary resolution: env override first (CI points these at
/// the fetched arch-suffixed sidecars — spec §9.2/B2), bare $PATH name as
/// the local fallback.
pub fn ffmpeg_bin() -> String {
    easyclip_lib::ffmpeg::invoker::resolve_path_binary("ffmpeg")
}

pub fn ffprobe_bin() -> String {
    easyclip_lib::ffmpeg::invoker::resolve_path_binary("ffprobe")
}

fn build_fixture(name: &str, args: &[&str]) -> H264Fixture {
    let dir = TempDir::new().expect("tempdir");
    let path = dir.path().join(name);
    let mut all: Vec<&str> = vec!["-hide_banner", "-loglevel", "error", "-y"];
    all.extend_from_slice(args);
    let p = path.to_str().unwrap().to_string();
    let status = Command::new(ffmpeg_bin())
        .args(all.iter().map(|s| s.to_string()).chain([p]))
        .status()
        .expect("ffmpeg not found: set EASYCLIP_TEST_FFMPEG or put ffmpeg on $PATH");
    assert!(status.success(), "fixture generation failed: {name}");
    H264Fixture { dir, path }
}

impl H264Fixture {
    /// 5-second lavfi-generated h264+aac MP4 with forced keyframes every 30
    /// frames (1 second at 30fps) — per v1 spec §8 "Fixtures from lavfi with
    /// forced keyframes".
    pub fn with_audio() -> Self {
        build_fixture(
            "clip.mp4",
            &[
                "-f",
                "lavfi",
                "-i",
                "testsrc=duration=5:size=320x240:rate=30",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=5",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-g",
                "30",
                "-keyint_min",
                "30",
                "-sc_threshold",
                "0",
                "-c:a",
                "aac",
            ],
        )
    }

    /// Video-only variant for `has_audio: false` assertions.
    pub fn video_only() -> Self {
        build_fixture(
            "clip.mp4",
            &[
                "-f",
                "lavfi",
                "-i",
                "testsrc=duration=5:size=320x240:rate=30",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-g",
                "30",
                "-keyint_min",
                "30",
                "-sc_threshold",
                "0",
            ],
        )
    }
}

/// B-frame mp4 (the midpoint-rule prover — exact-PTS seeks are unreliable
/// with B-frames; a whole-GOP-early landing shows up as ~1s extra duration).
pub fn b_frames_mp4() -> H264Fixture {
    build_fixture(
        "bframes.mp4",
        &[
            "-f",
            "lavfi",
            "-i",
            "testsrc=duration=10:size=320x240:rate=30",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-bf",
            "2",
            "-g",
            "60",
            "-keyint_min",
            "60",
            "-sc_threshold",
            "0",
        ],
    )
}

/// Same encode muxed to mkv (cue-offset variant of the same hazard).
pub fn b_frames_mkv() -> H264Fixture {
    build_fixture(
        "bframes.mkv",
        &[
            "-f",
            "lavfi",
            "-i",
            "testsrc=duration=10:size=320x240:rate=30",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-bf",
            "2",
            "-g",
            "60",
            "-keyint_min",
            "60",
            "-sc_threshold",
            "0",
        ],
    )
}

/// Large-GOP (-g 300 at 30fps = 10s GOP): collapse-policy and snap-drift cases.
pub fn large_gop_mp4() -> H264Fixture {
    build_fixture(
        "largegop.mp4",
        &[
            "-f",
            "lavfi",
            "-i",
            "testsrc=duration=30:size=320x240:rate=30",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-g",
            "300",
            "-keyint_min",
            "300",
            "-sc_threshold",
            "0",
        ],
    )
}

/// VFR via setpts (friendly-CFR fixtures can hide timestamp issues).
pub fn vfr_mp4() -> H264Fixture {
    build_fixture(
        "vfr.mp4",
        &[
            "-f",
            "lavfi",
            "-i",
            "testsrc=duration=10:size=320x240:rate=30",
            "-vf",
            "setpts='if(lt(N,150),PTS,PTS+0.5/TB)'",
            "-fps_mode",
            "vfr",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-g",
            "30",
            "-keyint_min",
            "30",
            "-sc_threshold",
            "0",
        ],
    )
}

/// Audio-only m4a (packet-granular cuts; no keyframe table).
pub fn audio_only_m4a() -> H264Fixture {
    build_fixture(
        "audio.m4a",
        &[
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=10",
            "-c:a",
            "aac",
        ],
    )
}

/// Two audio streams (asserts -map 0 keeps both).
pub fn two_audio_mp4() -> H264Fixture {
    build_fixture(
        "twoaudio.mp4",
        &[
            "-f",
            "lavfi",
            "-i",
            "testsrc=duration=5:size=320x240:rate=30",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=5",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=880:duration=5",
            "-map",
            "0:v",
            "-map",
            "1:a",
            "-map",
            "2:a",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-g",
            "30",
            "-keyint_min",
            "30",
            "-sc_threshold",
            "0",
            "-c:a",
            "aac",
        ],
    )
}

/// Chaptered mp4 (asserts -map_chapters -1 strips them on export).
pub fn chaptered_mp4() -> H264Fixture {
    let base = H264Fixture::with_audio();
    let dir = TempDir::new().expect("tempdir");
    let meta = dir.path().join("meta.txt");
    std::fs::write(&meta, ";FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=2000\ntitle=One\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=2000\nEND=5000\ntitle=Two\n").unwrap();
    let path = dir.path().join("chaptered.mp4");
    let status = Command::new(ffmpeg_bin())
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            base.path.to_str().unwrap(),
            "-i",
            meta.to_str().unwrap(),
            "-map_metadata",
            "1",
            "-map",
            "0",
            "-c",
            "copy",
            path.to_str().unwrap(),
        ])
        .status()
        .expect("ffmpeg not found: set EASYCLIP_TEST_FFMPEG or put ffmpeg on $PATH");
    assert!(status.success());
    H264Fixture { dir, path }
}

// ---- L3 helpers (spec §9.2: framehash + ffprobe-JSON assertions) ----

/// Per-frame MD5 lines from the framemd5 muxer (video stream 0),
/// copy-domain: hashes the encoded packet bytes (`-c copy`).
///
/// Use for SINGLE-PASS identity checks (one trim vs one reference cut,
/// where both outputs went through the same mux path). Do NOT use across
/// a concat remux: the concat demuxer rewrites in-band SPS/PPS parameter
/// sets at EVERY keyframe under stream-copy (empirically verified), so
/// copy-domain hashes diverge at each keyframe even when the video
/// content is identical — use `framehash_decoded` for those comparisons.
pub fn framehash(path: &std::path::Path) -> Vec<String> {
    framehash_inner(path, true)
}

/// Per-frame MD5 lines of the DECODED pixels (no `-c copy` — ffmpeg
/// decodes and hashes raw frames). Deterministic for the friendly-CFR
/// h264 fixtures used here.
///
/// Use for cross-remux comparisons (e.g. concat join vs its source
/// segments) where the concat demuxer's per-keyframe SPS/PPS rewrite
/// makes copy-domain hashes diverge despite identical content.
pub fn framehash_decoded(path: &std::path::Path) -> Vec<String> {
    framehash_inner(path, false)
}

fn framehash_inner(path: &std::path::Path, copy: bool) -> Vec<String> {
    let mut args: Vec<&str> = vec![
        "-hide_banner",
        "-nostdin",
        "-i",
        path.to_str().unwrap(),
        "-map",
        "0:v:0",
    ];
    if copy {
        args.extend(["-c", "copy"]);
    }
    args.extend(["-f", "framemd5", "-"]);
    let out = Command::new(ffmpeg_bin())
        .args(&args)
        .output()
        .expect("ffmpeg not found");
    assert!(
        out.status.success(),
        "framehash failed for {}",
        path.display()
    );
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter(|l| !l.starts_with('#'))
        .map(|l| l.split(',').next_back().unwrap_or("").trim().to_string())
        .collect()
}

pub fn ffprobe_json(path: &std::path::Path) -> serde_json::Value {
    let out = Command::new(ffprobe_bin())
        .args([
            "-v",
            "error",
            "-show_format",
            "-show_streams",
            "-show_chapters",
            "-of",
            "json",
            path.to_str().unwrap(),
        ])
        .output()
        .expect("ffprobe not found: set EASYCLIP_TEST_FFPROBE or put ffprobe on $PATH");
    assert!(out.status.success());
    serde_json::from_slice(&out.stdout).expect("ffprobe json")
}

pub fn duration_of(path: &std::path::Path) -> f64 {
    ffprobe_json(path)["format"]["duration"]
        .as_str()
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(0.0)
}
