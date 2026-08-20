//! Poster-frame extraction: a single decoded frame at a given time, written
//! by the ffmpeg sidecar to a tempfile and returned base64-encoded (§5).
//!
//! Why a tempfile, not `pipe:1`: the sidecar runs in line mode and strips `\n`
//! from each stdout chunk (invoker.rs re-appends them for the progress parser).
//! A JPEG contains arbitrary `0x0A` bytes, so piping would corrupt it. ffmpeg
//! writing a tempfile is binary-correct and matches trim.rs's temp-output
//! pattern; the NamedTempFile is auto-deleted on drop.

use crate::error::{classify_stderr, AppError};
use crate::ffmpeg::invoker::{FfmpegInvoker, RunEvent};
use crate::ffmpeg::job::{self, SharedJob};
use crate::ffmpeg::trim::fmt_seconds;
use base64::Engine;
use std::path::Path;

/// Build the poster-extraction argv. Input-side `-ss` (before `-i`) for a fast
/// keyframe seek + decode-forward; `scale=640:-2` keeps the JPEG small (even
/// height); `-q:v 4` is good-enough quality. The output path is the LAST arg;
/// the only user-controlled string (`input`) is preceded by the `-i` literal.
pub fn build_poster_args(input: &Path, t: f64, out: &Path) -> Vec<String> {
    vec![
        "-nostdin".into(),
        "-hide_banner".into(),
        "-nostats".into(),
        "-v".into(),
        "error".into(),
        "-y".into(),
        "-ss".into(),
        // Clamp to a finite, non-negative seek. `NaN.max(0.0)` already yields 0.0,
        // but `+Infinity.max(0.0)` is Infinity → fmt_seconds emits "-ss inf", which
        // ffmpeg rejects. A non-finite playhead should never reach here, but guard
        // it so a pathological duration (ffprobe can report a literal "inf") can't
        // produce a malformed argv.
        fmt_seconds(if t.is_finite() { t.max(0.0) } else { 0.0 }),
        "-i".into(),
        input.to_string_lossy().to_string(),
        "-frames:v".into(),
        "1".into(),
        "-vf".into(),
        "scale=640:-2".into(),
        "-q:v".into(),
        "4".into(),
        "-f".into(),
        "mjpeg".into(),
        out.to_string_lossy().to_string(),
    ]
}

/// Drain an ffmpeg run to completion, returning its terminal exit code and the
/// accumulated stderr. Stdout is ignored (poster output goes to the tempfile).
async fn collect_outcome(run: &mut crate::ffmpeg::invoker::FfmpegRun) -> (Option<i32>, String) {
    let mut code: Option<i32> = None;
    let mut stderr = String::new();
    while let Some(ev) = run.events.recv().await {
        match ev {
            RunEvent::Stderr(s) => stderr.push_str(&s),
            RunEvent::Terminated { code: c, .. } => code = c,
            RunEvent::Stdout(_) => {}
        }
    }
    (code, stderr)
}

/// The poster-extraction job slot. A newtype, not an alias: see
/// `ffmpeg::job::SharedJob` for why each slot must be a distinct type.
///
/// Poster extraction was the only ffmpeg-spawning command with NO slot at all:
/// it published no kill handle, so nothing could stop it. During poster playback
/// the pump issues one roughly every 100 ms, and an extract on a large or
/// network-backed source can take seconds - which meant leaving the Edit step,
/// or quitting the app, left that child running (lib.rs's Exit hook could only
/// reach the processing and proxy slots), competing with the export for CPU.
///
/// One slot, so only the MOST RECENT extract is killable. Extracts are meant to
/// be one-at-a-time (both callers gate on `posterInFlight`), and killing the
/// latest is strictly better than killing none.
#[derive(Default)]
pub struct PosterState(pub SharedJob);

impl std::ops::Deref for PosterState {
    type Target = SharedJob;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

pub struct PosterCommand;

impl PosterCommand {
    /// Extract one frame at `time_seconds`, returning bare base64 JPEG.
    /// `file` MUST already have passed `validate_media_path` (the command
    /// wrapper enforces this, mirroring ProbeCommand::run).
    pub async fn run(
        invoker: &dyn FfmpegInvoker,
        job: &SharedJob,
        file: &Path,
        time_seconds: f64,
    ) -> Result<String, AppError> {
        let tmp = tempfile::Builder::new()
            .prefix(".easyclip-poster-")
            .suffix(".jpg")
            .tempfile()
            .map_err(|e| AppError::Unknown {
                details: format!("poster tempfile: {e}"),
            })?;

        let args = build_poster_args(file, time_seconds, tmp.path());
        let mut run = invoker.spawn_ffmpeg(args).await?;
        let self_killed = job::publish_kill(job, &mut run);
        let (code, stderr) = collect_outcome(&mut run).await;
        if job::take_verdict(job, self_killed) {
            return Err(AppError::OperationCancelled);
        }
        if code != Some(0) {
            return Err(classify_stderr(&stderr));
        }

        let bytes = std::fs::read(tmp.path()).map_err(|e| AppError::Unknown {
            details: format!("poster read: {e}"),
        })?;
        // ffmpeg can exit 0 yet write a 0-byte file when an input-side `-ss`
        // lands past the last decodable frame (end-of-clip scrub): no frame
        // reaches the mjpeg muxer. Encoding that empty buffer would resolve with
        // the content-less URL `data:image/jpeg;base64,`, which the frontend
        // would assign over a previously-good poster on its SUCCESS path —
        // bypassing the "any failure → keep previous poster / show art" contract.
        // Treat empty output as a failure so that contract's reject path handles it.
        if bytes.is_empty() {
            return Err(AppError::Unknown {
                details: "poster: ffmpeg wrote 0 bytes (seek past end?)".into(),
            });
        }
        Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
        // `tmp` drops here → the file is deleted.
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn build_poster_args_exact_order_and_flags() {
        let args = build_poster_args(Path::new("/in/clip.mkv"), 12.5, Path::new("/tmp/p.jpg"));
        let joined = args.join(" ");
        assert!(joined
            .starts_with("-nostdin -hide_banner -nostats -v error -y -ss 12.5 -i /in/clip.mkv"));
        assert!(joined.contains("-frames:v 1 -vf scale=640:-2 -q:v 4 -f mjpeg"));
        assert_eq!(args.last().unwrap(), "/tmp/p.jpg");
    }

    #[test]
    fn build_poster_args_clamps_negative_time_to_zero() {
        let args = build_poster_args(Path::new("/in/c.mp4"), -3.0, Path::new("/tmp/p.jpg"));
        // -ss value sits right after the "-ss" flag.
        let i = args.iter().position(|a| a == "-ss").unwrap();
        assert_eq!(args[i + 1], "0");
    }

    #[test]
    fn build_poster_args_clamps_non_finite_time_to_zero() {
        // A non-finite playhead must never reach ffmpeg as `-ss inf`/`-ss NaN`.
        // (NaN.max(0.0) is already 0.0, but +Infinity.max(0.0) is Infinity.)
        for t in [f64::INFINITY, f64::NEG_INFINITY, f64::NAN] {
            let args = build_poster_args(Path::new("/in/c.mp4"), t, Path::new("/tmp/p.jpg"));
            let i = args.iter().position(|a| a == "-ss").unwrap();
            assert_eq!(args[i + 1], "0", "non-finite t={t} must clamp to 0");
        }
    }

    use crate::ffmpeg::invoker::{MockInvoker, ScriptedRun};
    use std::path::PathBuf;
    use std::sync::Arc;

    fn terminated(code: Option<i32>) -> Vec<RunEvent> {
        vec![RunEvent::Terminated { code, signal: None }]
    }

    #[tokio::test]
    async fn collect_outcome_returns_code_and_stderr() {
        let m = MockInvoker::ok("{}", "");
        m.push_run(ScriptedRun {
            events: vec![
                RunEvent::Stderr("boom\n".into()),
                RunEvent::Terminated {
                    code: Some(1),
                    signal: None,
                },
            ],
        });
        let mut run = m.spawn_ffmpeg(vec![]).await.unwrap();
        let (code, stderr) = collect_outcome(&mut run).await;
        assert_eq!(code, Some(1));
        assert!(stderr.contains("boom"));
    }

    #[tokio::test]
    async fn run_maps_nonzero_exit_to_classified_error() {
        // A nonzero exit must surface as a classified AppError (the frontend
        // treats any error as "keep previous poster / show art").
        let m = Arc::new(MockInvoker::ok("{}", ""));
        m.push_run(ScriptedRun {
            events: vec![
                RunEvent::Stderr("moov atom not found\n".into()),
                RunEvent::Terminated {
                    code: Some(1),
                    signal: None,
                },
            ],
        });
        let r = PosterCommand::run(
            m.as_ref(),
            &SharedJob::default(),
            &PathBuf::from("/tmp/x.mp4"),
            1.0,
        )
        .await;
        assert!(
            matches!(r, Err(AppError::MediaCorrupted { .. })),
            "got {r:?}"
        );
    }

    #[tokio::test]
    async fn a_pending_cancel_stops_the_extract() {
        // Poster extraction used to publish no kill handle at all, so nothing
        // could stop it: leaving the Edit step or quitting the app left the child
        // running (the Exit hook could only reach the processing and proxy slots).
        // With a slot, a cancel that landed before the spawn self-kills here and
        // the caller learns it was cancelled rather than "failed".
        let m = Arc::new(MockInvoker::ok("{}", ""));
        m.push_run(ScriptedRun {
            events: terminated(Some(0)),
        });
        let job = SharedJob::default();
        job.lock().unwrap().cancel_requested = true;

        let r = PosterCommand::run(m.as_ref(), &job, &PathBuf::from("/tmp/x.mp4"), 0.0).await;

        assert!(
            matches!(r, Err(AppError::OperationCancelled)),
            "a pending cancel must stop the extract, got {r:?}"
        );
        assert!(
            job.lock().unwrap().kill.is_none(),
            "no stale handle may outlive the run"
        );
    }

    #[tokio::test]
    async fn run_rejects_exit_zero_with_empty_output() {
        // The mock's scripted run reports exit 0 but never writes the tempfile,
        // so PosterCommand::run reads 0 bytes. An exit-0-but-empty result (an
        // input-side `-ss` past the last frame) must be a FAILURE, not Ok(""):
        // resolving the empty base64 would let the frontend assign the
        // content-less `data:image/jpeg;base64,` URL over a previously-good
        // poster on its success path. This exercises the spawn → drain → read
        // control flow and pins the empty-output reject contract. Real bytes →
        // Task 11 UAT.
        let m = Arc::new(MockInvoker::ok("{}", ""));
        m.push_run(ScriptedRun {
            events: terminated(Some(0)),
        });
        let r = PosterCommand::run(
            m.as_ref(),
            &SharedJob::default(),
            &PathBuf::from("/tmp/x.mp4"),
            0.0,
        )
        .await;
        assert!(
            matches!(r, Err(AppError::Unknown { .. })),
            "exit-0 with 0-byte output must reject, got {r:?}"
        );
    }

    #[test]
    fn base64_roundtrip_of_known_bytes() {
        let encoded = base64::engine::general_purpose::STANDARD.encode([0xFF, 0xD8, 0xFF]);
        assert_eq!(encoded, "/9j/");
    }
}
