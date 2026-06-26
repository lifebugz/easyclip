//! Layer 1 integration tests for the lossless processing engine.
//!
//! These tests run the full pipeline (`run_processing` + `PathInvoker`) against
//! real ffmpeg-generated fixtures. They validate trim accuracy, frame identity,
//! B-frame midpoint-rule correctness, audio-only precision, chapter stripping,
//! multi-stream preservation, VFR survival, and faststart atom ordering.
//!
//! Binary selection: `EASYCLIP_TEST_FFMPEG` / `EASYCLIP_TEST_FFPROBE` env vars
//! override $PATH (spec §9.2/B2 — CI points them at the fetched sidecars).

mod common;

use easyclip_lib::ffmpeg::invoker::PathInvoker;
use easyclip_lib::processing::plan::KeptRange;
use easyclip_lib::processing::{run_processing, ProcessingState};
use std::path::Path;

fn out_in(dir: &tempfile::TempDir, name: &str) -> String {
    dir.path().join(name).to_string_lossy().to_string()
}

async fn process(
    input: &Path,
    output: &str,
    ranges: &[KeptRange],
) -> Result<easyclip_lib::processing::ProcessingResult, easyclip_lib::error::AppError> {
    let job = ProcessingState::default();
    let emit = |_: easyclip_lib::processing::ProcessingEvent| {};
    run_processing(
        &PathInvoker,
        &job,
        &input.to_string_lossy(),
        output,
        ranges,
        &emit,
    )
    .await
}

#[tokio::test]
async fn version_floor_input_to_requires_ffmpeg_4() {
    let out =
        std::process::Command::new(easyclip_lib::ffmpeg::invoker::resolve_path_binary("ffmpeg"))
            .arg("-version")
            .output()
            .expect("ffmpeg not found: set EASYCLIP_TEST_FFMPEG or put ffmpeg on $PATH");
    let v = String::from_utf8_lossy(&out.stdout);
    // BtbN Windows builds prefix the version token with "n" ("n8.1.1-12-g…");
    // strip leading non-digits before parsing the major (mirrors smoke-sidecar.ts).
    let major: u32 = v
        .split_whitespace()
        .nth(2)
        .map(|s| s.trim_start_matches(|c: char| !c.is_ascii_digit()))
        .and_then(|s| s.split(['.', '-']).next())
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    assert!(major >= 4, "input-side -to needs ffmpeg >= 4.0, got: {v}");
}

#[tokio::test]
async fn single_range_trim_matches_a_reference_cut_framehash() {
    // with_audio(): 5s h264+aac, keyframes at 0,1,2,3,4 (g=30 @30fps = 1s GOP).
    // Range [1,4): snapped_start=1.0, seek=midpoint(1,2)=1.5, end=4.0.
    let fx = common::H264Fixture::with_audio();
    let out_dir = tempfile::TempDir::new().unwrap();
    let output = out_in(&out_dir, "out.mp4");
    let res = process(
        &fx.path,
        &output,
        &[KeptRange {
            start: 1.0,
            end: 4.0,
        }],
    )
    .await
    .unwrap();
    assert!(
        (res.final_duration - 3.0).abs() < 0.35,
        "got {}",
        res.final_duration
    );
    assert_eq!(res.segment_count, 1);

    // Reference cut with the SAME midpoint-seek semantics (seek between kf
    // 1.0 and 2.0 → 1.5) — byte-identical video frames expected.
    let reference = out_dir.path().join("ref.mp4");
    let st = std::process::Command::new(common::ffmpeg_bin())
        .args([
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-ss",
            "1.5",
            "-to",
            "4",
            "-i",
            fx.path.to_str().unwrap(),
            "-map",
            "0",
            "-ignore_unknown",
            "-map_chapters",
            "-1",
            "-c",
            "copy",
            "-avoid_negative_ts",
            "make_zero",
            reference.to_str().unwrap(),
        ])
        .status()
        .unwrap();
    assert!(st.success());
    assert_eq!(
        common::framehash(Path::new(&output)),
        common::framehash(&reference),
        "trim output must be frame-identical to the reference cut"
    );
}

#[tokio::test]
async fn multi_range_join_preserves_all_frames_from_both_segments() {
    // with_audio(): 5s, kf at 0,1,2,3,4.
    // [0,2): snapped=0, seek=None (starts at 0), end=2.
    // [3,5): snapped=3, seek=midpoint(3,4)=3.5, end=None (EOF).
    let fx = common::H264Fixture::with_audio();
    let out_dir = tempfile::TempDir::new().unwrap();
    let output = out_in(&out_dir, "joined.mp4");
    let res = process(
        &fx.path,
        &output,
        &[
            KeptRange {
                start: 0.0,
                end: 2.0,
            },
            KeptRange {
                start: 3.0,
                end: 5.0,
            },
        ],
    )
    .await
    .unwrap();
    assert_eq!(res.segment_count, 2);
    assert!(
        (res.final_duration - 4.0).abs() < 0.5,
        "got {}",
        res.final_duration
    );

    // Verify the join is the exact frame concatenation of the two reference
    // segments using DECODED framemd5 (raw pixel hashes). Copy-domain
    // framehash cannot be used across the concat remux: the concat demuxer
    // rewrites in-band SPS/PPS parameter sets at EVERY keyframe under
    // stream-copy (empirically verified — frames 0, 30, 60, 62, 92 differ
    // in this fixture), so encoded-packet hashes diverge at each keyframe
    // even though the video content is identical. Decoded hashes are
    // byte-identical (the fixture is friendly-CFR, so decode is
    // deterministic) — and would catch a corrupt join (e.g. swapped
    // segment order) that a bare frame-count check cannot.
    let s1 = out_dir.path().join("s1.mp4");
    let s2 = out_dir.path().join("s2.mp4");
    for (args, p) in [(vec!["-to", "2"], &s1), (vec!["-ss", "3.5"], &s2)] {
        let mut full = vec!["-nostdin", "-hide_banner", "-loglevel", "error", "-y"];
        full.extend(args);
        full.extend([
            "-i",
            fx.path.to_str().unwrap(),
            "-map",
            "0",
            "-ignore_unknown",
            "-map_chapters",
            "-1",
            "-c",
            "copy",
            "-avoid_negative_ts",
            "make_zero",
            p.to_str().unwrap(),
        ]);
        assert!(std::process::Command::new(common::ffmpeg_bin())
            .args(&full)
            .status()
            .unwrap()
            .success());
    }
    let joined = common::framehash_decoded(Path::new(&output));
    let mut expected = common::framehash_decoded(&s1);
    expected.extend(common::framehash_decoded(&s2));
    assert_eq!(
        joined.len(),
        expected.len(),
        "join must contain exactly the same total frame count as both reference segments"
    );
    assert_eq!(
        joined, expected,
        "join must be the exact decoded-frame concatenation of the reference segments"
    );
}

#[tokio::test]
async fn b_frame_cut_does_not_land_a_gop_early() {
    for fx in [common::b_frames_mp4(), common::b_frames_mkv()] {
        let out_dir = tempfile::TempDir::new().unwrap();
        let ext = fx.path.extension().unwrap().to_string_lossy().to_string();
        let output = out_in(&out_dir, &format!("out.{ext}"));
        // kf at 0,2,4,6,8 (g=60 @30fps). Cut [2,4): a whole-GOP-early landing
        // (the exact-PTS-seek failure) would yield ~4s instead of ~2s.
        let res = process(
            &fx.path,
            &output,
            &[KeptRange {
                start: 2.0,
                end: 4.0,
            }],
        )
        .await
        .unwrap();
        assert!(
            (res.final_duration - 2.0).abs() < 0.4,
            "{ext}: midpoint rule violated — duration {}",
            res.final_duration
        );
    }
}

#[tokio::test]
async fn audio_only_trim_is_packet_accurate() {
    let fx = common::audio_only_m4a();
    let out_dir = tempfile::TempDir::new().unwrap();
    let output = out_in(&out_dir, "out.m4a");
    let res = process(
        &fx.path,
        &output,
        &[KeptRange {
            start: 1.0,
            end: 4.0,
        }],
    )
    .await
    .unwrap();
    // Packet-granular cuts land on AAC frame boundaries (~23ms each at
    // 44.1kHz), so ±60ms ≈ 2-3 packets of slack.
    assert!(
        (res.final_duration - 3.0).abs() < 0.06,
        "got {}",
        res.final_duration
    );
}

#[tokio::test]
async fn chapters_are_stripped_from_exports() {
    let fx = common::chaptered_mp4();
    let out_dir = tempfile::TempDir::new().unwrap();
    let output = out_in(&out_dir, "out.mp4");
    process(
        &fx.path,
        &output,
        &[KeptRange {
            start: 1.0,
            end: 4.0,
        }],
    )
    .await
    .unwrap();
    let chapters = &common::ffprobe_json(Path::new(&output))["chapters"];
    assert_eq!(
        chapters.as_array().map(|a| a.len()),
        Some(0),
        "chapters must be dropped"
    );
}

#[tokio::test]
async fn map_0_keeps_both_audio_streams() {
    let fx = common::two_audio_mp4();
    let out_dir = tempfile::TempDir::new().unwrap();
    let output = out_in(&out_dir, "out.mp4");
    process(
        &fx.path,
        &output,
        &[KeptRange {
            start: 1.0,
            end: 4.0,
        }],
    )
    .await
    .unwrap();
    let streams = common::ffprobe_json(Path::new(&output))["streams"].clone();
    let audio = streams
        .as_array()
        .unwrap()
        .iter()
        .filter(|s| s["codec_type"] == "audio")
        .count();
    assert_eq!(audio, 2);
}

#[tokio::test]
async fn vfr_trim_survives_with_sane_duration() {
    let fx = common::vfr_mp4();
    let out_dir = tempfile::TempDir::new().unwrap();
    let output = out_in(&out_dir, "out.mp4");
    let res = process(
        &fx.path,
        &output,
        &[KeptRange {
            start: 1.0,
            end: 6.0,
        }],
    )
    .await
    .unwrap();
    // The setpts warp shifts the second half by +0.5s and VFR duration
    // accounting varies by container math — only a sanity window is assertable.
    assert!(
        res.final_duration > 3.0 && res.final_duration < 8.0,
        "got {}",
        res.final_duration
    );
}

#[tokio::test]
async fn faststart_final_has_moov_before_mdat() {
    let fx = common::H264Fixture::with_audio();
    let out_dir = tempfile::TempDir::new().unwrap();
    let output = out_in(&out_dir, "out.mp4");
    process(
        &fx.path,
        &output,
        &[KeptRange {
            start: 0.0,
            end: 5.0,
        }],
    )
    .await
    .unwrap();
    let bytes = std::fs::read(&output).unwrap();
    let moov = bytes.windows(4).position(|w| w == b"moov").unwrap();
    let mdat = bytes.windows(4).position(|w| w == b"mdat").unwrap();
    assert!(moov < mdat, "+faststart must put moov before mdat");
}
