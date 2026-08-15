//! Layer 1 integration test for the preview-proxy ladder: every proxy the
//! planner can decide on is actually BUILT by the real ffmpeg sidecar.
//!
//! ## The bug class this closes
//!
//! `proxy.rs` unit-tests each half of the command separately - `choose_table`
//! pins WHICH method a codec pair gets, and the argv tests pin WHAT flags each
//! builder emits - but nothing composed the two into a command and handed it to
//! ffmpeg. Three separate defects lived in exactly that gap. Every one of them
//! was green under the unit tests and fatal in the shipped app:
//!
//! 1. **`.part` muxer** - the orchestrator writes `<name>.mp4.part`, so ffmpeg
//!    chose its container from the `.part` extension and died at muxer init
//!    ("Unable to choose an output format", exit 234). Fixed by the explicit `-f`.
//! 2. **mp3 + `ipod`** - `mp3` is remux-safe, but ffmpeg's M4A muxer has no
//!    codec tag for it, so every audio-only MP3 remux died ("Could not find tag
//!    for codec mp3", exit 234, 0-byte output).
//! 3. **odd width** - `scale=w='min(1280,iw)':h=-2` forced only the HEIGHT even,
//!    so libx264 + `yuv420p` refused a 321-wide source ("width not divisible by
//!    2", exit 187) - and because Transcode is the ladder's LAST rung, the
//!    preview was stuck on poster forever.
//!
//! Each fix is one line. The gap that hid all three is the real defect, so this
//! test is deliberately built to close it rather than to restate the fixes.
//!
//! ## Why it goes through `run_proxy`
//!
//! The test never builds argv and never picks an output path. It calls
//! `run_proxy`, which probes the source, chooses the method, derives the cache
//! filename, appends `.part`, builds the argv, and spawns the sidecar. The
//! output path - the very thing defect 1 hid behind - is chosen by production
//! code. A test that called `build_remux_args(input, my_own_path, …)` would
//! decide for itself whether the path ends in `.part`, and would have sailed
//! straight past defect 1 exactly as the unit tests did.
//!
//! Assertions go past "exit 0": a remux must have COPIED its streams (proxy
//! codec == source codec) and a transcode must have re-encoded to WebKit-safe
//! H.264/AAC with even, capped dimensions. Exit 0 alone would accept a proxy
//! that silently dropped the audio or re-encoded when it promised a copy.
//!
//! Binary selection matches the other Layer 1 tests: `EASYCLIP_TEST_FFMPEG` /
//! `EASYCLIP_TEST_FFPROBE` override $PATH (CI points them at the sidecars).

mod common;

use easyclip_lib::error::AppError;
use easyclip_lib::ffmpeg::invoker::PathInvoker;
use easyclip_lib::ffmpeg::proxy::REMUX_SAFE_AUDIO;
use easyclip_lib::ffmpeg::proxy_run::{run_proxy, ProxyEvent, ProxyResult, ProxyState};
use std::path::{Path, PathBuf};
use std::process::Command;
use tempfile::TempDir;

/// A generated source file, kept alive by the TempDir it lives in.
struct Fixture {
    /// Never read - dropping it deletes the directory holding `path`.
    _dir: TempDir,
    path: PathBuf,
}

/// Generate one lavfi source. A missing encoder fails LOUDLY here rather than
/// skipping the case: a silently-skipped row turns this regression pin into a
/// no-op on precisely the runner where it matters.
fn lavfi(name: &str, args: &[&str]) -> Fixture {
    let dir = TempDir::new().expect("tempdir");
    let path = dir.path().join(name);
    let mut argv: Vec<String> = args.iter().map(|s| (*s).to_string()).collect();
    argv.push(path.to_string_lossy().to_string());
    ffmpeg(name, &argv);
    Fixture { _dir: dir, path }
}

/// Run the sidecar for fixture generation, failing LOUDLY on a bad exit.
fn ffmpeg(what: &str, args: &[String]) {
    let mut argv: Vec<String> = ["-hide_banner", "-loglevel", "error", "-y"]
        .iter()
        .map(|s| (*s).to_string())
        .collect();
    argv.extend_from_slice(args);
    let out = Command::new(common::ffmpeg_bin())
        .args(&argv)
        .output()
        .expect("ffmpeg not found: set EASYCLIP_TEST_FFMPEG or put ffmpeg on $PATH");
    assert!(
        out.status.success(),
        "fixture {what} failed to generate ({}): {}",
        out.status,
        String::from_utf8_lossy(&out.stderr)
    );
}

/// An MP3 carrying embedded cover art - by far the commonest MP3 in the wild,
/// and the input shape the audio-only `-vn` branch exists for. `has_real_video`
/// is false for an attached_pic stream, so this must still take the audio-only
/// path (and therefore the mp3 muxer exception) rather than the video one.
///
/// Built in two passes on purpose: muxing the cover in the same command as the
/// lavfi encode truncates the audio to the single video frame (measured: 0.026 s
/// instead of 2 s), which would leave the case technically passing while
/// exercising almost no audio.
fn mp3_with_cover_art() -> Fixture {
    let dir = TempDir::new().expect("tempdir");
    let audio = dir.path().join("audio-only.mp3");
    let art = dir.path().join("art.png");
    let path = dir.path().join("with-cover.mp3");

    ffmpeg(
        "cover-art mp3 (audio pass)",
        &[
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=2",
            "-c:a",
            "libmp3lame",
        ]
        .iter()
        .map(|s| (*s).to_string())
        .chain([audio.to_string_lossy().to_string()])
        .collect::<Vec<_>>(),
    );
    ffmpeg(
        "cover-art mp3 (art pass)",
        &[
            "-f",
            "lavfi",
            "-i",
            "color=c=red:s=64x64:d=1",
            "-frames:v",
            "1",
        ]
        .iter()
        .map(|s| (*s).to_string())
        .chain([art.to_string_lossy().to_string()])
        .collect::<Vec<_>>(),
    );
    ffmpeg(
        "cover-art mp3 (mux)",
        &[
            "-i".to_string(),
            audio.to_string_lossy().to_string(),
            "-i".to_string(),
            art.to_string_lossy().to_string(),
            "-map".to_string(),
            "0:a".to_string(),
            "-map".to_string(),
            "1:v".to_string(),
            "-c:a".to_string(),
            "copy".to_string(),
            "-c:v".to_string(),
            "mjpeg".to_string(),
            "-disposition:v".to_string(),
            "attached_pic".to_string(),
            "-id3v2_version".to_string(),
            "3".to_string(),
            path.to_string_lossy().to_string(),
        ],
    );
    Fixture { _dir: dir, path }
}

/// Encoder + container for a `REMUX_SAFE_AUDIO` entry.
///
/// The `panic!` is the point: adding a codec to the allowlist is a claim that
/// `-c copy` of it produces a file the audio muxer accepts, and this test is
/// what checks that claim. Growing the list without a fixture would otherwise
/// widen the allowlist while silently shrinking the coverage.
fn audio_recipe(codec: &str) -> (&'static str, &'static str) {
    match codec {
        "aac" => ("aac", "m4a"),
        "mp3" => ("libmp3lame", "mp3"),
        "alac" => ("alac", "m4a"),
        other => panic!(
            "REMUX_SAFE_AUDIO gained {other:?} with no fixture recipe - add one \
             so the real sidecar covers it (that is the whole point of this test)"
        ),
    }
}

struct Case {
    label: String,
    fixture: Fixture,
    want_method: &'static str,
    want_ext: &'static str,
    /// Expected video codec in the proxy; `None` for an audio-only proxy.
    want_video_codec: Option<&'static str>,
    /// Expected audio codec in the proxy; `None` for a silent source.
    want_audio_codec: Option<String>,
    /// Expected ftyp major brand - the only thing that actually OBSERVES which
    /// muxer ran, since `ipod` and `mp4` share one ffprobe `format_name`
    /// ("mov,mp4,m4a,3gp,3g2,mj2"). `ipod` stamps `M4A `, `mp4` stamps `isom`.
    /// `None` skips the check.
    want_major_brand: Option<&'static str>,
    /// Assert the scaler produced even, 1280-capped dimensions.
    check_scaled_dims: bool,
}

async fn build_proxy(source: &Path, cache: &Path) -> Result<ProxyResult, AppError> {
    let state = ProxyState::default();
    let emit = |_: ProxyEvent| {};
    run_proxy(
        &PathInvoker,
        &state,
        &source.to_string_lossy(),
        cache,
        false,
        &emit,
    )
    .await
}

fn stream_of<'a>(json: &'a serde_json::Value, kind: &str) -> Option<&'a serde_json::Value> {
    json["streams"]
        .as_array()?
        .iter()
        .find(|s| s["codec_type"] == kind)
}

/// Run one case end to end. Returns every problem found rather than the first,
/// so a single slow run reports the whole broken set.
async fn check(case: &Case) -> Vec<String> {
    let mut bad = Vec::new();
    let cache = match TempDir::new() {
        Ok(d) => d,
        Err(e) => return vec![format!("{}: cache tempdir: {e}", case.label)],
    };

    let res = match build_proxy(&case.fixture.path, cache.path()).await {
        Ok(r) => r,
        Err(e) => {
            // The whole point of the test: the argv the code emits must be one
            // the real sidecar accepts.
            return vec![format!("{}: run_proxy failed: {e}", case.label)];
        }
    };

    if res.method != case.want_method {
        bad.push(format!(
            "{}: method {:?}, want {:?}",
            case.label, res.method, case.want_method
        ));
    }

    let proxy = PathBuf::from(&res.proxy_path);
    if !proxy.is_file() {
        bad.push(format!(
            "{}: proxy missing at {}",
            case.label, res.proxy_path
        ));
        return bad;
    }
    match std::fs::metadata(&proxy).map(|m| m.len()) {
        Ok(0) => {
            // Defects 1-3 all produced exactly this: a header-write failure
            // leaves a 0-byte file behind.
            bad.push(format!("{}: proxy is 0 bytes", case.label));
            return bad;
        }
        Err(e) => {
            bad.push(format!("{}: stat proxy: {e}", case.label));
            return bad;
        }
        _ => {}
    }
    if proxy.extension().and_then(|e| e.to_str()) != Some(case.want_ext) {
        bad.push(format!(
            "{}: proxy ext {:?}, want {:?}",
            case.label,
            proxy.extension(),
            case.want_ext
        ));
    }

    // A leftover `.part` means PartGuard did not disarm - the rename step
    // silently failed even though the build reported success.
    if let Ok(entries) = std::fs::read_dir(cache.path()) {
        for e in entries.flatten() {
            if e.file_name().to_string_lossy().ends_with(".part") {
                bad.push(format!(
                    "{}: leftover .part {:?}",
                    case.label,
                    e.file_name()
                ));
            }
        }
    }

    // The proxy must be readable media, not just a non-empty file.
    let json = common::ffprobe_json(&proxy);
    let video = stream_of(&json, "video");
    let audio = stream_of(&json, "audio");

    if let Some(want) = case.want_major_brand {
        let got = json["format"]["tags"]["major_brand"].as_str().unwrap_or("");
        if got != want {
            bad.push(format!(
                "{}: ftyp major_brand {got:?}, want {want:?} (wrong muxer ran)",
                case.label
            ));
        }
    }

    match (case.want_video_codec, video) {
        (Some(want), Some(v)) => {
            let got = v["codec_name"].as_str().unwrap_or("");
            if got != want {
                bad.push(format!(
                    "{}: video codec {got:?}, want {want:?}",
                    case.label
                ));
            }
            if case.check_scaled_dims {
                let w = v["width"].as_i64().unwrap_or(0);
                let h = v["height"].as_i64().unwrap_or(0);
                // Pin the CLASS, not the number: yuv420p chroma subsampling
                // needs BOTH dimensions even, and the ladder caps width at 1280.
                if w <= 0 || h <= 0 || w % 2 != 0 || h % 2 != 0 || w > 1280 {
                    bad.push(format!(
                        "{}: transcoded to {w}x{h}; want both even, width 1..=1280",
                        case.label
                    ));
                }
                let pix = v["pix_fmt"].as_str().unwrap_or("");
                if pix != "yuv420p" {
                    bad.push(format!("{}: pix_fmt {pix:?}, want \"yuv420p\"", case.label));
                }
            }
        }
        (Some(want), None) => bad.push(format!("{}: no video stream, want {want:?}", case.label)),
        (None, Some(v)) => bad.push(format!(
            "{}: unexpected video stream {:?}",
            case.label, v["codec_name"]
        )),
        (None, None) => {}
    }

    match (case.want_audio_codec.as_deref(), audio) {
        (Some(want), Some(a)) => {
            let got = a["codec_name"].as_str().unwrap_or("");
            if got != want {
                bad.push(format!(
                    "{}: audio codec {got:?}, want {want:?}",
                    case.label
                ));
            }
        }
        (Some(want), None) => bad.push(format!("{}: no audio stream, want {want:?}", case.label)),
        (None, Some(a)) => bad.push(format!(
            "{}: unexpected audio stream {:?}",
            case.label, a["codec_name"]
        )),
        (None, None) => {}
    }

    bad
}

fn cases() -> Vec<Case> {
    let mut cases = vec![
        // ── Video, Remux ── h264+aac in MKV: the flagship case. The codecs are
        // WebKit-safe; only the CONTAINER is rejected, so `-c copy` into mp4 is
        // the whole fix. Both stream codecs must survive unchanged.
        Case {
            label: "video/remux h264+aac.mkv".into(),
            fixture: lavfi(
                "remuxable.mkv",
                &[
                    "-f",
                    "lavfi",
                    "-i",
                    "testsrc=duration=2:size=320x240:rate=15",
                    "-f",
                    "lavfi",
                    "-i",
                    "sine=frequency=440:duration=2",
                    "-c:v",
                    "libx264",
                    "-preset",
                    "ultrafast",
                    "-pix_fmt",
                    "yuv420p",
                    "-c:a",
                    "aac",
                ],
            ),
            want_method: "remux",
            want_ext: "mp4",
            want_video_codec: Some("h264"),
            want_audio_codec: Some("aac".into()),
            want_major_brand: Some("isom"),
            check_scaled_dims: false,
        },
        // ── Video, Transcode, ODD WIDTH (defect 3) ── 321x241 mpeg4+mp3 in AVI.
        // mpeg4 is not remux-safe, so this takes the ladder's last rung. libx264
        // itself refuses to ENCODE odd dimensions, so the fixture uses mpeg4 -
        // a native encoder present in every ffmpeg build (unlike libvpx or
        // libtheora), which also makes this a realistic "AVI world" source.
        Case {
            label: "video/transcode odd 321x241.avi".into(),
            fixture: lavfi(
                "odd-width.avi",
                &[
                    "-f",
                    "lavfi",
                    "-i",
                    "testsrc=duration=2:size=321x241:rate=15",
                    "-f",
                    "lavfi",
                    "-i",
                    "sine=frequency=440:duration=2",
                    "-c:v",
                    "mpeg4",
                    "-pix_fmt",
                    "yuv420p",
                    "-c:a",
                    "libmp3lame",
                ],
            ),
            want_method: "transcode",
            want_ext: "mp4",
            want_video_codec: Some("h264"),
            want_audio_codec: Some("aac".into()),
            want_major_brand: Some("isom"),
            check_scaled_dims: true,
        },
        // ── Video, Transcode, oversize AND odd, silent ── 1601x901 exercises the
        // 1280 cap and the evenness rule together (a fix that only special-cased
        // the sub-cap branch would pass the case above and fail here). Silent, so
        // it also proves the optional `-map 0:a:0?` survives a source with no audio.
        Case {
            label: "video/transcode oversize odd 1601x901.avi".into(),
            fixture: lavfi(
                "oversize-odd.avi",
                &[
                    "-f",
                    "lavfi",
                    "-i",
                    "testsrc=duration=1:size=1601x901:rate=10",
                    "-c:v",
                    "mpeg4",
                    "-pix_fmt",
                    "yuv420p",
                ],
            ),
            want_method: "transcode",
            want_ext: "mp4",
            want_video_codec: Some("h264"),
            want_audio_codec: None,
            want_major_brand: Some("isom"),
            check_scaled_dims: true,
        },
        // ── Audio, Transcode ── flac is deliberately NOT remux-safe, so the
        // audio-only bottom rung re-encodes to AAC.
        Case {
            label: "audio/transcode flac".into(),
            fixture: lavfi(
                "source.flac",
                &[
                    "-f",
                    "lavfi",
                    "-i",
                    "sine=frequency=440:duration=2",
                    "-c:a",
                    "flac",
                ],
            ),
            want_method: "transcode",
            want_ext: "m4a",
            want_video_codec: None,
            want_audio_codec: Some("aac".into()),
            // A transcode re-encodes to AAC, so it keeps the `ipod` muxer.
            want_major_brand: Some("M4A "),
            check_scaled_dims: false,
        },
    ];

    // ── Audio, Remux - EVERY entry in the allowlist (defect 2 is the mp3 row) ──
    // Driven off the real `REMUX_SAFE_AUDIO` rather than a copy of it, so a
    // codec added there is automatically run against the sidecar. The remux
    // must be lossless, so the proxy's codec has to equal the source's.
    for codec in REMUX_SAFE_AUDIO {
        let (encoder, ext) = audio_recipe(codec);
        cases.push(Case {
            label: format!("audio/remux {codec}"),
            fixture: lavfi(
                &format!("source.{ext}"),
                &[
                    "-f",
                    "lavfi",
                    "-i",
                    "sine=frequency=440:duration=2",
                    "-c:a",
                    encoder,
                ],
            ),
            want_method: "remux",
            want_ext: "m4a",
            want_video_codec: None,
            want_audio_codec: Some((*codec).to_string()),
            // mp3 cannot be tagged by `ipod`, so it muxes `mp4` (brand `isom`);
            // aac/alac keep `ipod` and its `M4A ` brand. This is the assertion
            // that actually OBSERVES which muxer ran.
            want_major_brand: Some(if *codec == "mp3" { "isom" } else { "M4A " }),
            check_scaled_dims: false,
        });
    }

    // ── Audio, Remux, MP3 WITH COVER ART ── the commonest real-world MP3, and
    // the shape the audio-only `-vn` branch exists for. An attached_pic stream
    // must NOT count as real video: if it did, the file would take the video
    // branch, get a `.mp4` proxy, and skip the mp3 muxer exception entirely.
    cases.push(Case {
        label: "audio/remux mp3 + cover art".into(),
        fixture: mp3_with_cover_art(),
        want_method: "remux",
        want_ext: "m4a",
        // `-vn` drops the cover, so the proxy carries audio only.
        want_video_codec: None,
        want_audio_codec: Some("mp3".into()),
        want_major_brand: Some("isom"),
        check_scaled_dims: false,
    });

    cases
}

/// Every planner decision, built by the real sidecar.
///
/// Single test on purpose: the cases run serially (no ffmpeg storm from
/// cargo's test threads) and every failure is collected, so one run names the
/// entire broken set instead of aborting on the first bad combination.
#[tokio::test]
async fn every_proxy_decision_builds_with_the_real_sidecar() {
    let cases = cases();

    let mut failures = Vec::new();
    for case in &cases {
        failures.extend(check(case).await);
    }

    assert!(
        failures.is_empty(),
        "{} of {} proxy builds broke:\n  - {}",
        failures.len(),
        cases.len(),
        failures.join("\n  - ")
    );
}
