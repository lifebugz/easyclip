//! Layer 1 integration tests for the probe_media flow.
//!
//! These tests run the orchestrator against the system `ffprobe` on $PATH
//! (PathInvoker) using lavfi-generated fixtures. They are the
//! ground-truth assertions that probe_media works end-to-end against a
//! real binary.

mod common;

use easyclip_lib::ffmpeg::invoker::{FfmpegInvoker, MockInvoker, PathInvoker};
use easyclip_lib::ffmpeg::probe::ProbeCommand;
use easyclip_lib::ffmpeg::MAX_KF;
use std::sync::Arc;

#[tokio::test]
async fn probe_real_lavfi_h264_returns_expected_media_info() {
    let f = common::H264Fixture::with_audio();
    let invoker: Arc<dyn FfmpegInvoker> = Arc::new(PathInvoker);
    let mi = ProbeCommand::run(invoker.as_ref(), &f.path)
        .await
        .expect("probe");
    assert!(
        (mi.duration - 5.0).abs() < 0.2,
        "duration ~5s, got {}",
        mi.duration
    );
    assert!(mi.container.contains("mp4"));
    assert_eq!(mi.codec, "h264");
    assert_eq!(mi.ext, "mp4");
    assert!(mi.has_audio);
    // Forced GOP 30 at 30fps → keyframes at 0, 1, 2, 3, 4 (and possibly 5).
    assert!(
        mi.keyframes.len() >= 5,
        "expected ≥5 keyframes from forced GOP, got {:?}",
        mi.keyframes
    );
    assert!(
        mi.keyframes.windows(2).all(|w| w[1] > w[0]),
        "keyframes must be ascending"
    );
}

#[tokio::test]
async fn probe_real_lavfi_video_only_reports_has_audio_false() {
    let f = common::H264Fixture::video_only();
    let invoker: Arc<dyn FfmpegInvoker> = Arc::new(PathInvoker);
    let mi = ProbeCommand::run(invoker.as_ref(), &f.path)
        .await
        .expect("probe");
    assert!(!mi.has_audio);
    assert_eq!(mi.codec, "h264");
}

#[tokio::test]
async fn probe_returns_empty_keyframes_when_over_cap_via_mock_invoker() {
    // Use MockInvoker to feed an over-cap packet list without generating a
    // pathological real fixture (which would take minutes to create).
    let json = r#"{
        "format": { "duration": "1.0", "format_name": "matroska,webm" },
        "streams": [{ "codec_type": "video", "codec_name": "h264" }]
    }"#;
    let mut kf = String::new();
    for i in 0..(MAX_KF + 1) {
        kf.push_str(&format!("{}.0,K__\n", i));
    }
    let invoker: Arc<dyn FfmpegInvoker> = Arc::new(MockInvoker::ok(json, kf));
    let mi = ProbeCommand::run(invoker.as_ref(), std::path::Path::new("/tmp/over.mkv"))
        .await
        .expect("probe");
    assert!(
        mi.keyframes.is_empty(),
        "over-cap MUST return empty (snap disabled)"
    );
}
