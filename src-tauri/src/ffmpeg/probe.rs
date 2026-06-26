//! Pure parsers for ffprobe output. The orchestrator (Task 9) calls these
//! with stdout strings from the FfmpegInvoker; tests exercise the parsers
//! directly with embedded fixture strings — no process spawn required.

use crate::error::AppError;
use crate::ffmpeg::MAX_KF;
use serde::Deserialize;

/// Subset of ffprobe JSON output we consume from the first probe pass.
#[derive(Debug, Clone, PartialEq)]
pub struct ProbedFields {
    pub duration: f64,
    pub container: String,
    pub codec: String,
    pub has_audio: bool,
    /// True iff a non-attached_pic video stream is present. Attached-picture
    /// streams (MP3/M4A/FLAC cover art) are reported by ffprobe as `video`
    /// but are NOT decodable timelines — they must not enable `canSnap` or
    /// route the file to video/poster mode (§3.1).
    pub has_real_video: bool,
}

#[derive(Debug, Deserialize)]
struct ProbeJson {
    format: ProbeFormat,
    #[serde(default)]
    streams: Vec<ProbeStream>,
}

#[derive(Debug, Deserialize)]
struct ProbeFormat {
    #[serde(default)]
    duration: Option<String>,
    #[serde(default)]
    format_name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ProbeStream {
    codec_type: Option<String>,
    codec_name: Option<String>,
    #[serde(default)]
    disposition: Option<Disposition>,
}

#[derive(Debug, Deserialize)]
struct Disposition {
    #[serde(default)]
    attached_pic: i64,
}

pub fn parse_probe_json(stdout: &str) -> Result<ProbedFields, AppError> {
    let parsed: ProbeJson = serde_json::from_str(stdout).map_err(|e| AppError::Unknown {
        details: format!("ffprobe JSON parse error: {e}"),
    })?;

    let duration: f64 = parsed
        .format
        .duration
        .as_deref()
        .ok_or_else(|| AppError::Unknown {
            details: "ffprobe output missing format.duration".to_string(),
        })?
        .parse()
        .map_err(|e| AppError::Unknown {
            details: format!("ffprobe format.duration not a number: {e}"),
        })?;

    let container = parsed.format.format_name.unwrap_or_default();

    let mut codec = String::new();
    let mut has_audio = false;
    let mut has_real_video = false;
    for s in &parsed.streams {
        let is_attached_pic = s
            .disposition
            .as_ref()
            .map(|d| d.attached_pic == 1)
            .unwrap_or(false);
        match s.codec_type.as_deref() {
            Some("video") if !is_attached_pic => {
                has_real_video = true;
                // Take the FIRST real video's codec, but if that stream omits
                // codec_name (ffprobe can report a `video` stream with no codec_name
                // for an unidentifiable codec), recover from a later real-video
                // stream rather than latching codec="" — matching the pre-V:0
                // `codec.is_empty()` loop. has_real_video still latches on the first
                // real video so the keyframe pass (gated on it) runs regardless.
                if codec.is_empty() {
                    codec = s.codec_name.clone().unwrap_or_default();
                }
            }
            Some("audio") => {
                has_audio = true;
            }
            _ => {}
        }
    }

    Ok(ProbedFields {
        duration,
        container,
        codec,
        has_audio,
        has_real_video,
    })
}

/// Parse the second ffprobe pass: `-select_streams V:0 -show_entries
/// packet=pts_time,flags -of csv=p=0` (capital `V:0` = first video stream skipping
/// attached_pic/cover art).
///
/// Each row is `<pts_time>,<flags>`; keyframes have a `K` in their flags. If
/// the keyframe count exceeds MAX_KF, returns an empty vec (cap behaviour
/// per amendment §3.5).
pub fn parse_keyframes_packets(stdout: &str) -> Vec<f64> {
    let mut kfs: Vec<f64> = Vec::with_capacity(1024);
    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let mut parts = line.splitn(2, ',');
        let Some(pts) = parts.next() else { continue };
        let Some(flags) = parts.next() else { continue };
        if !flags.contains('K') {
            continue;
        }
        let Ok(t) = pts.parse::<f64>() else { continue };
        if kfs.len() >= MAX_KF {
            // We have already seen MAX_KF keyframes and now have one more — cap fires.
            return Vec::new();
        }
        kfs.push(t);
    }
    kfs
}

use crate::ffmpeg::invoker::{FfmpegInvoker, ProbePass};
use crate::ffmpeg::{derive_ext, MediaInfo};
use std::path::Path;

pub struct ProbeCommand;

impl ProbeCommand {
    /// Probe `file` via two ffprobe passes (basic JSON + keyframe packets).
    /// Returns assembled `MediaInfo` with the MAX_KF cap applied.
    pub async fn run(invoker: &dyn FfmpegInvoker, file: &Path) -> Result<MediaInfo, AppError> {
        // Pass 1: structural probe.
        let out1 = invoker.probe(ProbePass::Json, file).await?;
        if !out1.success() {
            return Err(crate::error::classify_stderr(&out1.stderr));
        }
        let fields = parse_probe_json(&out1.stdout)?;

        // Pass 2: keyframes — ONLY when pass 1 found a real (non-attached_pic)
        // video stream. The argv uses `-select_streams V:0` (capital) so ffprobe
        // itself skips attached_pic/cover-art streams and selects the first real
        // video regardless of stream index (§3.1). This guard is still kept so a
        // cover-art-only audio file (no real video) skips pass 2 entirely and
        // leaves `keyframes` empty → `canSnap` stays false.
        let keyframes = if fields.has_real_video {
            let out2 = invoker.probe(ProbePass::KeyframePackets, file).await?;
            if !out2.success() {
                return Err(crate::error::classify_stderr(&out2.stderr));
            }
            parse_keyframes_packets(&out2.stdout)
        } else {
            Vec::new()
        };

        Ok(MediaInfo {
            path: file.to_string_lossy().into_owned(),
            duration: fields.duration,
            container: fields.container,
            codec: fields.codec,
            ext: derive_ext(file),
            has_real_video: fields.has_real_video,
            has_audio: fields.has_audio,
            keyframes,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const JSON_HAPPY: &str = r#"{
      "format": { "duration": "10.500000", "format_name": "mov,mp4,m4a,3gp,3g2,mj2" },
      "streams": [
        { "codec_type": "video", "codec_name": "h264" },
        { "codec_type": "audio", "codec_name": "aac" }
      ]
    }"#;

    const JSON_VIDEO_ONLY: &str = r#"{
      "format": { "duration": "3.0", "format_name": "matroska,webm" },
      "streams": [{ "codec_type": "video", "codec_name": "vp9" }]
    }"#;

    #[test]
    fn parse_probe_json_extracts_duration_container_codec_has_audio() {
        let p = parse_probe_json(JSON_HAPPY).unwrap();
        assert!((p.duration - 10.5).abs() < 1e-9);
        assert_eq!(p.container, "mov,mp4,m4a,3gp,3g2,mj2");
        assert_eq!(p.codec, "h264");
        assert!(p.has_audio);
    }

    #[test]
    fn parse_probe_json_handles_video_only() {
        let p = parse_probe_json(JSON_VIDEO_ONLY).unwrap();
        assert!(!p.has_audio);
        assert_eq!(p.codec, "vp9");
    }

    #[test]
    fn parse_probe_json_rejects_garbage() {
        let r = parse_probe_json("not json");
        assert!(matches!(r, Err(AppError::Unknown { .. })));
    }

    #[test]
    fn parse_probe_json_rejects_missing_duration() {
        let r = parse_probe_json(r#"{"format":{"format_name":"x"},"streams":[]}"#);
        assert!(matches!(r, Err(AppError::Unknown { .. })));
    }

    #[test]
    #[allow(non_snake_case)]
    fn parse_keyframes_packets_extracts_K_flagged_rows() {
        let s = "\
0.000000,K__\n\
0.033333,___\n\
0.066667,___\n\
1.000000,K__\n\
1.033333,___\n\
2.000000,K__\n";
        let kfs = parse_keyframes_packets(s);
        assert_eq!(kfs, vec![0.0, 1.0, 2.0]);
    }

    #[test]
    fn parse_keyframes_packets_returns_empty_for_no_keyframes() {
        let s = "0.0,___\n0.5,___\n";
        assert!(parse_keyframes_packets(s).is_empty());
    }

    #[test]
    fn parse_keyframes_packets_handles_empty_input() {
        assert!(parse_keyframes_packets("").is_empty());
    }

    #[test]
    fn parse_keyframes_packets_caps_at_max_kf() {
        let mut s = String::new();
        for i in 0..MAX_KF {
            s.push_str(&format!("{}.0,K__\n", i));
        }
        let kfs = parse_keyframes_packets(&s);
        assert_eq!(kfs.len(), MAX_KF, "exactly MAX_KF should be retained");
    }

    #[test]
    fn parse_keyframes_packets_returns_empty_when_over_cap() {
        let mut s = String::new();
        for i in 0..(MAX_KF + 1) {
            s.push_str(&format!("{}.0,K__\n", i));
        }
        let kfs = parse_keyframes_packets(&s);
        assert!(
            kfs.is_empty(),
            "over-cap input must return empty vec (snap disabled)"
        );
    }

    #[test]
    fn parse_keyframes_packets_skips_malformed_lines() {
        let s = "0.0,K__\nmalformed line\nnot_a_number,K__\n1.0,K__\n";
        let kfs = parse_keyframes_packets(s);
        assert_eq!(kfs, vec![0.0, 1.0]);
    }

    use crate::ffmpeg::invoker::MockInvoker;
    use std::path::PathBuf;
    use std::sync::Arc;

    fn typical_kf_csv() -> String {
        "0.0,K__\n0.5,___\n1.0,K__\n2.0,K__\n".into()
    }

    #[tokio::test]
    async fn run_assembles_media_info_from_two_passes() {
        let json = r#"{
            "format": { "duration": "10.0", "format_name": "mov,mp4" },
            "streams": [
                { "codec_type": "video", "codec_name": "h264" },
                { "codec_type": "audio", "codec_name": "aac" }
            ]
        }"#;
        let mock = Arc::new(MockInvoker::ok(json, typical_kf_csv()));
        let mi = ProbeCommand::run(mock.as_ref(), &PathBuf::from("/tmp/clip.mp4"))
            .await
            .unwrap();
        assert_eq!(mi.path, "/tmp/clip.mp4");
        assert!((mi.duration - 10.0).abs() < 1e-9);
        assert_eq!(mi.container, "mov,mp4");
        assert_eq!(mi.codec, "h264");
        assert_eq!(mi.ext, "mp4");
        assert!(mi.has_audio);
        assert_eq!(mi.keyframes, vec![0.0, 1.0, 2.0]);
    }

    #[tokio::test]
    async fn run_returns_empty_keyframes_when_over_max_kf() {
        let json = r#"{
            "format": { "duration": "1.0", "format_name": "matroska,webm" },
            "streams": [{ "codec_type": "video", "codec_name": "h264" }]
        }"#;
        let mut kf = String::new();
        for i in 0..(crate::ffmpeg::MAX_KF + 1) {
            kf.push_str(&format!("{}.0,K__\n", i));
        }
        let mock = Arc::new(MockInvoker::ok(json, kf));
        let mi = ProbeCommand::run(mock.as_ref(), &PathBuf::from("/tmp/x.mkv"))
            .await
            .unwrap();
        assert!(mi.keyframes.is_empty(), "over-cap MUST return empty");
        assert_eq!(mi.ext, "mkv");
        assert!(!mi.has_audio);
    }

    #[test]
    fn parse_probe_json_excludes_attached_pic_cover_art() {
        // MP3 with an embedded JPEG cover: ffprobe reports it as a video stream
        // with disposition.attached_pic == 1. It must NOT count as a real video.
        let json = r#"{
          "format": { "duration": "180.0", "format_name": "mp3" },
          "streams": [
            { "codec_type": "video", "codec_name": "mjpeg", "disposition": { "attached_pic": 1 } },
            { "codec_type": "audio", "codec_name": "mp3" }
          ]
        }"#;
        let p = parse_probe_json(json).unwrap();
        assert_eq!(p.codec, "", "attached_pic must not populate codec");
        assert!(!p.has_real_video, "attached_pic is not a real video stream");
        assert!(p.has_audio);
    }

    #[test]
    fn parse_probe_json_prefers_real_video_over_attached_pic() {
        // A real video stream plus a cover thumbnail: the real one wins.
        let json = r#"{
          "format": { "duration": "5.0", "format_name": "mov,mp4" },
          "streams": [
            { "codec_type": "video", "codec_name": "mjpeg", "disposition": { "attached_pic": 1 } },
            { "codec_type": "video", "codec_name": "h264" }
          ]
        }"#;
        let p = parse_probe_json(json).unwrap();
        assert_eq!(p.codec, "h264");
        assert!(p.has_real_video);
    }

    #[test]
    fn parse_probe_json_recovers_codec_when_first_real_video_omits_codec_name() {
        // ffprobe can report a `video` stream with no codec_name (unidentifiable
        // codec). When it is the FIRST real (non-attached_pic) video and a LATER
        // real video carries a codec_name, codec must recover from the later
        // stream rather than latching "" — preserving the pre-`V:0` `codec.is_empty()`
        // behaviour. has_real_video still latches on the first real video so the
        // keyframe pass runs.
        let json = r#"{
          "format": { "duration": "5.0", "format_name": "mov,mp4" },
          "streams": [
            { "codec_type": "video" },
            { "codec_type": "video", "codec_name": "h264" }
          ]
        }"#;
        let p = parse_probe_json(json).unwrap();
        assert_eq!(
            p.codec, "h264",
            "codec must recover from the later real video"
        );
        assert!(p.has_real_video);
    }

    #[test]
    fn parse_probe_json_real_video_without_codec_name_keeps_has_real_video() {
        // The codec-less video is the ONLY video stream, so there is nothing to
        // recover from and codec stays "". has_real_video must still be true: the
        // file genuinely HAS a real video stream. This is exactly why the wire must
        // carry has_real_video rather than letting the frontend infer video from
        // codec != "" — that heuristic would misroute this real video to audio.
        let json = r#"{
          "format": { "duration": "5.0", "format_name": "mov,mp4" },
          "streams": [
            { "codec_type": "video" },
            { "codec_type": "audio", "codec_name": "aac" }
          ]
        }"#;
        let p = parse_probe_json(json).unwrap();
        assert_eq!(p.codec, "", "no codec_name anywhere ⇒ codec stays empty");
        assert!(
            p.has_real_video,
            "a real video stream exists even when its codec is unidentifiable"
        );
        assert!(p.has_audio);
    }

    #[tokio::test]
    async fn run_excludes_attached_pic_and_disables_keyframes_end_to_end() {
        // Cover-art MP3: pass 1 reports an attached_pic video + audio. Because
        // has_real_video is false, pass 2 is skipped entirely; this mock returns a
        // keyframe row to prove that even if pass 2 DID run, its output is discarded.
        // The assembled MediaInfo must report BOTH codec=="" AND keyframes==[] so
        // the `canSnap` closure (keyframes.length > 0) stays false (§3.1).
        let json = r#"{
          "format": { "duration": "180.0", "format_name": "mp3" },
          "streams": [
            { "codec_type": "video", "codec_name": "mjpeg", "disposition": { "attached_pic": 1 } },
            { "codec_type": "audio", "codec_name": "mp3" }
          ]
        }"#;
        let mock = Arc::new(MockInvoker::ok(json, "0.0,K__\n")); // pass-2 has a keyframe
        let mi = ProbeCommand::run(mock.as_ref(), &PathBuf::from("/tmp/song.mp3"))
            .await
            .unwrap();
        assert_eq!(mi.codec, "", "cover-art file reports no video codec");
        assert!(
            mi.keyframes.is_empty(),
            "keyframe pass must be discarded when there is no real video stream"
        );
        assert!(mi.has_audio);
    }

    #[tokio::test]
    async fn run_classifies_nonzero_exit_via_stderr() {
        let mut mock = MockInvoker::ok("", "");
        mock.json_status = Some(1);
        mock.json_stderr =
            "[mov,mp4,m4a,3gp,3g2,mj2 @ 0x1] moov atom not found\n/x: Invalid data found"
                .to_string();
        let mock = Arc::new(mock);
        let r = ProbeCommand::run(mock.as_ref(), &PathBuf::from("/x.mp4")).await;
        assert!(matches!(
            r,
            Err(crate::error::AppError::MediaCorrupted { .. })
        ));
    }
}
