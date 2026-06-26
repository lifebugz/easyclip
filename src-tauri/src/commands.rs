//! Tauri commands. Each command validates input at the boundary, fetches
//! the FfmpegInvoker from app state, and dispatches the orchestrator.

use crate::error::AppError;
use crate::ffmpeg::invoker::FfmpegInvoker;
use crate::ffmpeg::probe::ProbeCommand;
use crate::ffmpeg::MediaInfo;
use crate::processing::plan::{build_plan, KeptRange};
use crate::processing::{run_processing, ProcessingEvent, ProcessingResult, ProcessingState};
use crate::validation::validate_media_path;
use std::path::Path;
use std::sync::Arc;
use tauri::ipc::Channel;

/// Handle stored in Tauri state. Erased trait object so we can swap in
/// SidecarInvoker (prod) vs PathInvoker (L1 tests) at builder time.
pub type FfmpegInvokerHandle = Arc<dyn FfmpegInvoker>;

/// Session-scoped: the last successfully-produced output path. The opener
/// commands only operate on this exact path (defense in depth — the webview
/// never gets arbitrary-path open/reveal).
pub struct LastOutput(pub std::sync::Mutex<Option<String>>);

fn guard_last_output(path: &str, last: &LastOutput) -> Result<(), AppError> {
    let ok = last.0.lock().unwrap().as_deref() == Some(path);
    if ok {
        Ok(())
    } else {
        Err(AppError::Unknown {
            details: "path is not the session's last output".into(),
        })
    }
}

#[tauri::command]
pub async fn probe_media(
    path: String,
    state: tauri::State<'_, FfmpegInvokerHandle>,
) -> Result<MediaInfo, AppError> {
    let validated = validate_media_path(&path)?;
    let invoker: &dyn FfmpegInvoker = state.inner().as_ref();
    ProbeCommand::run(invoker, &validated as &Path).await
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanDurationResult {
    /// Σ of planned segment weights — the duration the export targets. Not the
    /// post-export re-probed final_duration (impossible before exporting).
    pub planned_duration: f64,
    /// True iff build_plan would abort SelectionTooNarrow for this selection.
    pub would_be_too_narrow: bool,
}

/// Pure preview: run the real build_plan (no ffmpeg, no IO) so the editor's
/// FINAL readout matches the export's forward-snap policy exactly. Synchronous —
/// the JS invoke promise resolves immediately. SelectionTooNarrow is mapped to
/// a flag (the editor shows a too-narrow state), never propagated as a reject.
#[tauri::command]
pub fn plan_duration(
    kept_ranges: Vec<KeptRange>,
    keyframes: Vec<f64>,
    duration: f64,
) -> Result<PlanDurationResult, AppError> {
    match build_plan(&kept_ranges, &keyframes, duration) {
        Ok(plan) => Ok(PlanDurationResult {
            planned_duration: plan.total_weight,
            would_be_too_narrow: false,
        }),
        Err(AppError::SelectionTooNarrow { .. }) => Ok(PlanDurationResult {
            planned_duration: 0.0,
            would_be_too_narrow: true,
        }),
        Err(e) => Err(e),
    }
}

#[tauri::command]
pub async fn process_media(
    input: String,
    output: String,
    kept_ranges: Vec<KeptRange>,
    on_event: Channel<ProcessingEvent>,
    invoker: tauri::State<'_, FfmpegInvokerHandle>,
    job: tauri::State<'_, ProcessingState>,
    last: tauri::State<'_, LastOutput>,
) -> Result<ProcessingResult, AppError> {
    let emit = move |ev: ProcessingEvent| {
        // Sends after webview teardown error harmlessly (spec §5.1).
        let _ = on_event.send(ev);
    };
    let result = run_processing(
        invoker.inner().as_ref(),
        job.inner(),
        &input,
        &output,
        &kept_ranges,
        &emit,
    )
    .await?;
    *last.0.lock().unwrap() = Some(result.output_path.clone());
    Ok(result)
}

/// Idempotent: no active job → flag set + no kill = harmless no-op (the
/// next claim resets the flag — spec §6/B3).
#[tauri::command]
pub fn cancel_processing(job: tauri::State<'_, ProcessingState>) {
    let kill = {
        let mut j = job.lock().unwrap();
        j.cancel_requested = true;
        j.kill.take()
    };
    if let Some(k) = kill {
        k();
    }
}

#[tauri::command]
pub fn reveal_output(
    path: String,
    app: tauri::AppHandle,
    last: tauri::State<'_, LastOutput>,
) -> Result<(), AppError> {
    use tauri_plugin_opener::OpenerExt;
    guard_last_output(&path, &last)?;
    app.opener()
        .reveal_item_in_dir(&path)
        .map_err(|e| AppError::Unknown {
            details: format!("reveal: {e}"),
        })
}

#[tauri::command]
pub fn open_output(
    path: String,
    app: tauri::AppHandle,
    last: tauri::State<'_, LastOutput>,
) -> Result<(), AppError> {
    use tauri_plugin_opener::OpenerExt;
    guard_last_output(&path, &last)?;
    app.opener()
        .open_path(&path, None::<&str>)
        .map_err(|e| AppError::Unknown {
            details: format!("open: {e}"),
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ffmpeg::invoker::MockInvoker;
    use std::io::Write;
    use tempfile::NamedTempFile;

    #[test]
    fn opener_guard_rejects_paths_other_than_last_output() {
        let last = LastOutput(std::sync::Mutex::new(Some("/ok/out.mp4".into())));
        assert!(guard_last_output("/ok/out.mp4", &last).is_ok());
        assert!(matches!(
            guard_last_output("/evil/other.mp4", &last),
            Err(AppError::Unknown { .. })
        ));
        let empty = LastOutput(std::sync::Mutex::new(None));
        assert!(guard_last_output("/ok/out.mp4", &empty).is_err());
    }

    fn build_mock_handle(json: &str, kf: &str) -> FfmpegInvokerHandle {
        Arc::new(MockInvoker::ok(json, kf))
    }

    #[tokio::test]
    async fn probe_media_returns_media_info_on_happy_path() {
        let mut f = NamedTempFile::new().unwrap();
        write!(f, "fake-but-existing").unwrap();
        let path_str = f.path().to_string_lossy().to_string();

        // We exercise the command body directly: validate_media_path needs
        // a real file (the tempfile), and the orchestrator runs against the
        // mock invoker.
        let json = r#"{
            "format": { "duration": "1.0", "format_name": "mov,mp4" },
            "streams": [{ "codec_type": "video", "codec_name": "h264" }]
        }"#;
        let handle = build_mock_handle(json, "0.0,K__\n");
        let invoker: &dyn FfmpegInvoker = handle.as_ref();

        let validated = validate_media_path(&path_str).unwrap();
        let mi = ProbeCommand::run(invoker, &validated).await.unwrap();
        assert!((mi.duration - 1.0).abs() < 1e-9);
        assert_eq!(mi.codec, "h264");
        assert!(!mi.has_audio);
    }

    #[tokio::test]
    async fn probe_media_rejects_missing_input_path() {
        // No tempfile — path does not exist. The command-body path validator
        // fires before the orchestrator runs.
        let r = validate_media_path("/this/does/not/exist.mp4");
        assert!(matches!(r, Err(AppError::InputPathInvalid { .. })));
    }
}

#[cfg(test)]
mod plan_duration_tests {
    use super::*;
    use crate::processing::plan::KeptRange;

    #[test]
    fn serializes_to_camel_case() {
        let v = serde_json::to_value(PlanDurationResult {
            planned_duration: 1.5,
            would_be_too_narrow: false,
        })
        .unwrap();
        assert!(v.get("plannedDuration").is_some());
        assert!(v.get("wouldBeTooNarrow").is_some());
    }

    #[test]
    fn empty_keyframes_returns_unsnapped_sum() {
        // No keyframes → snap_forward passes start through verbatim → weight = end - start.
        let r = plan_duration(
            vec![KeptRange {
                start: 1.0,
                end: 5.0,
            }],
            vec![],
            10.0,
        )
        .unwrap();
        assert!(!r.would_be_too_narrow);
        assert!((r.planned_duration - 4.0).abs() < 1e-9);
    }

    #[test]
    fn collapsing_range_maps_to_would_be_too_narrow() {
        // [3.9,4.1) snaps start fwd to kf 4.0 → 0.1s survivor < MIN_CUT_DUR; requested
        // width 0.2 < MIN_CUT_DUR → silent drop → empty plan → SelectionTooNarrow.
        let r = plan_duration(
            vec![KeptRange {
                start: 3.9,
                end: 4.1,
            }],
            vec![0.0, 2.0, 4.0, 6.0],
            10.0,
        )
        .unwrap();
        assert!(r.would_be_too_narrow);
        assert_eq!(r.planned_duration, 0.0);
    }
}
