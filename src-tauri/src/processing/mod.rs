//! Lossless processing engine: plan derivation (plan.rs), output safety
//! (output.rs — Task 8), and the orchestrator (this file — Tasks 9/10).

pub mod output;
pub mod plan;

use crate::error::AppError;
use crate::ffmpeg::invoker::{FfmpegInvoker, KillHandle, RunEvent};
use crate::ffmpeg::progress::ProgressParser;

// ── Shared contract types (Tasks 10/11 depend on exact shapes) ──────────────

#[derive(Default)]
pub struct ProcessingJob {
    pub active: bool,
    pub kill: Option<KillHandle>,
    pub cancel_requested: bool,
}

pub type ProcessingState = std::sync::Mutex<ProcessingJob>;

#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Stage {
    Single,
    Segment,
    Concat,
    Finalizing,
}

#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessingEvent {
    pub stage: Stage,
    pub segment_index: u32, // 1-based
    pub segment_count: u32,
    pub fraction: f64, // overall, monotonic, capped at 0.99
    pub eta_seconds: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessingResult {
    pub output_path: String,
    pub final_duration: f64,
    pub removed_duration: f64,
    pub segment_count: u32,
}

// ── Constants ────────────────────────────────────────────────────────────────

pub const FASTSTART_MARKER: &str = "Starting second pass: moving the moov atom";

// ── Progress aggregator ───────────────────────────────────────────────────────

/// Overall-fraction aggregator: monotonic, capped at 0.99 (100% only on
/// terminal success — spec §5.1). Weights are media-seconds; ETA derives
/// from remaining media / speed.
pub struct ProgressAgg {
    total_work: f64,
    completed: f64,
    floor: f64,
}

impl ProgressAgg {
    pub fn new(total_work: f64) -> Self {
        Self {
            total_work,
            completed: 0.0,
            floor: 0.0,
        }
    }

    fn overall(&mut self, stage_fraction: f64, weight: f64) -> f64 {
        let raw = (self.completed + stage_fraction * weight) / self.total_work;
        self.floor = self.floor.max(raw.clamp(0.0, 0.99));
        self.floor
    }

    fn eta(&self, stage_fraction: f64, weight: f64, speed: Option<f64>) -> Option<f64> {
        let remaining = self.total_work - (self.completed + stage_fraction * weight);
        speed
            .filter(|s| s.is_finite() && *s > 0.0)
            .map(|s| (remaining / s).max(0.0))
    }

    /// Stage success: finalize at FULL weight regardless of the last block
    /// (spec §4.1 hardening — make_zero offsets cannot strand the bar).
    fn complete_stage(&mut self, weight: f64) {
        self.completed += weight;
    }
}

// ── Stage runner ─────────────────────────────────────────────────────────────

pub struct StageCtx {
    pub stage: Stage,
    pub seg_index: u32,
    pub seg_count: u32,
    pub span: f64,   // E − seek: the out_time_us denominator (S1)
    pub weight: f64, // E − S: the cross-stage contribution
    pub watch_faststart: bool,
}

pub struct StageOutcome {
    pub code: Option<i32>,
    pub stderr: String,
    pub cancelled: bool,
}

/// Run one ffmpeg stage. Locking protocol (spec §2.1, binding):
/// std::sync::Mutex, held ONLY for short non-async sections, NEVER across
/// an await. Publish-then-recheck closes the spawn/cancel race: after
/// storing the kill handle we re-read cancel_requested under the same lock
/// and self-kill if set.
pub async fn run_stage(
    invoker: &dyn FfmpegInvoker,
    job: &ProcessingState,
    args: Vec<String>,
    ctx: &StageCtx,
    agg: &mut ProgressAgg,
    emit: &(dyn Fn(ProcessingEvent) + Send + Sync),
) -> Result<StageOutcome, AppError> {
    let mut run = invoker.spawn_ffmpeg(args).await?;

    // Publish the kill handle — or self-kill if a cancel already landed.
    let mut self_killed = false;
    {
        let mut j = job.lock().unwrap();
        let kill: KillHandle = std::mem::replace(&mut run.kill, Box::new(|| {}));
        if j.cancel_requested {
            drop(j); // release the lock before calling kill (sync + fast)
            kill();
            self_killed = true;
        } else {
            j.kill = Some(kill);
        }
    }

    let mut parser = ProgressParser::new();
    let mut stderr = String::new();
    let mut last_fraction = 0.0_f64;
    let mut last_speed: Option<f64> = None;
    let mut code: Option<i32> = None;
    let mut finalizing = false;

    while let Some(ev) = run.events.recv().await {
        match ev {
            RunEvent::Stdout(chunk) => {
                for block in parser.feed(&chunk) {
                    if let Some(us) = block.out_time_us {
                        let sf = (us as f64 / (ctx.span * 1_000_000.0)).clamp(0.0, 1.0);
                        last_fraction = last_fraction.max(sf); // keep-last, never regress
                    }
                    if block.speed.is_some() {
                        last_speed = block.speed;
                    }
                    emit(ProcessingEvent {
                        stage: if finalizing {
                            Stage::Finalizing
                        } else {
                            ctx.stage
                        },
                        segment_index: ctx.seg_index,
                        segment_count: ctx.seg_count,
                        fraction: agg.overall(last_fraction, ctx.weight),
                        eta_seconds: if finalizing {
                            None
                        } else {
                            agg.eta(last_fraction, ctx.weight, last_speed)
                        },
                    });
                }
            }
            RunEvent::Stderr(chunk) => {
                stderr.push_str(&chunk);
                if ctx.watch_faststart && !finalizing && chunk.contains(FASTSTART_MARKER) {
                    finalizing = true;
                    emit(ProcessingEvent {
                        stage: Stage::Finalizing,
                        segment_index: ctx.seg_index,
                        segment_count: ctx.seg_count,
                        fraction: agg.overall(1.0, ctx.weight),
                        eta_seconds: None, // silent rewrite — no honest ETA
                    });
                }
            }
            RunEvent::Terminated { code: c, .. } => {
                code = c;
            }
        }
    }

    // Clear the handle (N5) and read the cancel verdict — cancel WINS over
    // a coincident exit code (spec §6/N10; Windows kill reports code 1).
    let cancelled = {
        let mut j = job.lock().unwrap();
        j.kill = None;
        j.cancel_requested || self_killed
    };

    if !cancelled && code == Some(0) {
        agg.complete_stage(ctx.weight);
        emit(ProcessingEvent {
            stage: ctx.stage,
            segment_index: ctx.seg_index,
            segment_count: ctx.seg_count,
            fraction: agg.overall(0.0, 0.0),
            eta_seconds: agg.eta(0.0, 0.0, last_speed),
        });
    }

    Ok(StageOutcome {
        code,
        stderr,
        cancelled,
    })
}

// ── run_processing pipeline ──────────────────────────────────────────────────

use crate::error::classify_stderr;
use crate::ffmpeg::concat::{list_file_contents, ConcatCommand};
use crate::ffmpeg::probe::ProbeCommand;
use crate::ffmpeg::trim::TrimCommand;
use crate::processing::output::{
    create_sibling, rename_with_retry, sweep_stale_partials, SWEEP_MIN_AGE,
};
use crate::processing::plan::{build_plan, KeptRange};
use crate::validation::{validate_media_path, validate_output_path};
use std::path::PathBuf;

/// Clears `active` + `kill` on every exit path (success, error, panic).
struct ActiveGuard<'a>(&'a ProcessingState);
impl Drop for ActiveGuard<'_> {
    fn drop(&mut self) {
        let mut j = self.0.lock().unwrap();
        j.active = false;
        j.kill = None;
    }
}

/// Deletes the partial sibling unless disarmed (success path renames first).
struct SiblingGuard {
    path: PathBuf,
    armed: bool,
}
impl Drop for SiblingGuard {
    fn drop(&mut self) {
        if self.armed {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

fn checkpoint(job: &ProcessingState) -> Result<(), AppError> {
    if job.lock().unwrap().cancel_requested {
        Err(AppError::OperationCancelled)
    } else {
        Ok(())
    }
}

fn validate_ranges(ranges: &[KeptRange], duration: f64) -> Result<(), AppError> {
    if ranges.is_empty() {
        return Err(AppError::ProcessingFailed {
            hint: "empty keptRanges".into(),
        });
    }
    let mut prev_end = f64::NEG_INFINITY;
    for r in ranges {
        if !(r.start.is_finite() && r.end.is_finite()) || r.start >= r.end {
            return Err(AppError::ProcessingFailed {
                hint: format!("malformed range [{}, {})", r.start, r.end),
            });
        }
        if r.start < prev_end {
            return Err(AppError::ProcessingFailed {
                hint: "overlapping/unsorted keptRanges".into(),
            });
        }
        if r.start < 0.0 || r.end > duration + 1e-6 {
            return Err(AppError::ProcessingFailed {
                hint: format!("range [{}, {}) outside [0, {duration}]", r.start, r.end),
            });
        }
        prev_end = r.end;
    }
    Ok(())
}

pub async fn run_processing(
    invoker: &dyn FfmpegInvoker,
    job: &ProcessingState,
    input: &str,
    output: &str,
    ranges: &[KeptRange],
    emit: &(dyn Fn(ProcessingEvent) + Send + Sync),
) -> Result<ProcessingResult, AppError> {
    // Step 0 — claim atomically: active CAS + reset cancel_requested (B3) +
    // kill=None, one short lock (spec §2 step 0).
    {
        let mut j = job.lock().unwrap();
        if j.active {
            return Err(AppError::ProcessingFailed {
                hint: "processing already in progress".into(),
            });
        }
        *j = ProcessingJob {
            active: true,
            kill: None,
            cancel_requested: false,
        };
    }
    let _active = ActiveGuard(job);

    // Step 1 — validate paths (ranges complete after the probe).
    let input_path = validate_media_path(input)?;
    let output_path = validate_output_path(output, input)?;
    checkpoint(job)?;

    // Step 2 — probe input: authoritative duration + keyframes. Probe
    // errors keep their own classification here (this is the INPUT —
    // MediaCorrupted etc. are correct verdicts; N2 applies to the verify
    // probe below).
    let info = ProbeCommand::run(invoker, &input_path).await?;
    validate_ranges(ranges, info.duration)?;
    checkpoint(job)?;

    // Step 3 — plan (snap/collapse/abort live in plan.rs).
    let plan = build_plan(ranges, &info.keyframes, info.duration)?;
    let seg_count = plan.segments.len() as u32;

    // Step 4 — output prep.
    let dest_dir = output_path
        .parent()
        .expect("validated parent")
        .to_path_buf();
    sweep_stale_partials(&dest_dir, SWEEP_MIN_AGE);
    let ext = crate::ffmpeg::derive_ext(&output_path);
    let sibling = create_sibling(&dest_dir, &ext)?;
    let mut sibling_guard = SiblingGuard {
        path: sibling.clone(),
        armed: true,
    };

    let multi = plan.segments.len() > 1;
    let total_work = if multi {
        plan.total_weight * 2.0
    } else {
        plan.total_weight
    };
    let mut agg = ProgressAgg::new(total_work);

    if !multi {
        let seg = &plan.segments[0];
        let ctx = StageCtx {
            stage: Stage::Single,
            seg_index: 1,
            seg_count: 1,
            span: seg.span,
            weight: seg.weight,
            watch_faststart: crate::ffmpeg::wants_faststart_ext(&ext),
        };
        checkpoint(job)?;
        let args = TrimCommand::for_single_range(&input_path, &sibling, seg);
        let out = run_stage(invoker, job, args, &ctx, &mut agg, emit).await?;
        settle_stage(invoker, job, out, &ctx, &mut agg, emit, || {
            TrimCommand::for_single_range_restricted(&input_path, &sibling, seg)
        })
        .await?;
    } else {
        let tmp = tempfile::tempdir().map_err(|e| AppError::ProcessingFailed {
            hint: format!("tempdir: {e}"),
        })?;
        let mut seg_paths: Vec<PathBuf> = Vec::new();
        for (i, seg) in plan.segments.iter().enumerate() {
            checkpoint(job)?;
            let seg_path = tmp.path().join(format!("seg_{i}.{ext}"));
            let ctx = StageCtx {
                stage: Stage::Segment,
                seg_index: (i + 1) as u32,
                seg_count,
                span: seg.span,
                weight: seg.weight,
                watch_faststart: false,
            };
            let args = TrimCommand::for_segment(&input_path, &seg_path, seg);
            let out = run_stage(invoker, job, args, &ctx, &mut agg, emit).await?;
            settle_stage(invoker, job, out, &ctx, &mut agg, emit, || {
                TrimCommand::for_segment_restricted(&input_path, &seg_path, seg)
            })
            .await?;
            seg_paths.push(seg_path);
        }

        checkpoint(job)?;
        let list_path = tmp.path().join("list.txt");
        std::fs::write(&list_path, list_file_contents(&seg_paths)).map_err(|e| {
            AppError::ProcessingFailed {
                hint: format!("concat list: {e}"),
            }
        })?;
        let ctx = StageCtx {
            stage: Stage::Concat,
            seg_index: 1,
            seg_count,
            span: plan.total_weight,
            weight: plan.total_weight,
            watch_faststart: crate::ffmpeg::wants_faststart_ext(&ext),
        };
        let args = ConcatCommand::build(&list_path, &sibling);
        let out = run_stage(invoker, job, args, &ctx, &mut agg, emit).await?;
        // No map-fallback on the join: segments are clean ffmpeg output.
        if out.cancelled {
            return Err(AppError::OperationCancelled);
        }
        if out.code != Some(0) {
            return Err(classify_stderr(&out.stderr));
        }
        // tmp (TempDir) drops here → segments + list cleaned.
    }

    // Step 5 — verify-probe. ANY failure wraps into ProcessingFailed (N2).
    checkpoint(job)?;
    let final_info =
        ProbeCommand::run(invoker, &sibling)
            .await
            .map_err(|e| AppError::ProcessingFailed {
                hint: format!("output verify-probe: {e}"),
            })?;
    if !(final_info.duration.is_finite() && final_info.duration > 0.0) {
        return Err(AppError::ProcessingFailed {
            hint: format!(
                "output verify-probe: non-positive duration {}",
                final_info.duration
            ),
        });
    }
    checkpoint(job)?;

    // Step 6 — rename into place; disarm the guard only after success.
    rename_with_retry(&sibling, &output_path)?;
    sibling_guard.armed = false;

    // Step 7 — result.
    Ok(ProcessingResult {
        output_path: output.to_string(),
        final_duration: final_info.duration,
        removed_duration: (info.duration - final_info.duration).max(0.0),
        segment_count: seg_count,
    })
}

/// Shared post-stage settle for the trim stages: cancel wins; the
/// muxer-tag signature triggers EXACTLY one restricted retry (N3 — never
/// on I/O signatures); anything else classifies.
async fn settle_stage(
    invoker: &dyn FfmpegInvoker,
    job: &ProcessingState,
    out: StageOutcome,
    ctx: &StageCtx,
    agg: &mut ProgressAgg,
    emit: &(dyn Fn(ProcessingEvent) + Send + Sync),
    restricted_args: impl Fn() -> Vec<String>,
) -> Result<(), AppError> {
    if out.cancelled {
        return Err(AppError::OperationCancelled);
    }
    if out.code == Some(0) {
        return Ok(());
    }
    if out.stderr.contains("Could not find tag for codec") {
        let retry = run_stage(invoker, job, restricted_args(), ctx, agg, emit).await?;
        if retry.cancelled {
            return Err(AppError::OperationCancelled);
        }
        if retry.code == Some(0) {
            return Ok(());
        }
        return Err(classify_stderr(&retry.stderr));
    }
    Err(classify_stderr(&out.stderr))
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ffmpeg::invoker::{MockInvoker, RunEvent, ScriptedRun};
    use std::sync::{Arc, Mutex};

    fn collector() -> (
        Arc<Mutex<Vec<ProcessingEvent>>>,
        impl Fn(ProcessingEvent) + Send + Sync,
    ) {
        let store = Arc::new(Mutex::new(Vec::new()));
        let s2 = Arc::clone(&store);
        (store, move |ev: ProcessingEvent| {
            s2.lock().unwrap().push(ev)
        })
    }

    fn stdout(s: &str) -> RunEvent {
        RunEvent::Stdout(s.to_string())
    }
    fn done(code: i32) -> RunEvent {
        RunEvent::Terminated {
            code: Some(code),
            signal: None,
        }
    }

    #[tokio::test]
    async fn stage_fraction_uses_span_not_weight() {
        // Review-2 S1: out_time counts from the SEEK point. span=3 (E−seek),
        // weight=4 (E−S). At out_time_us=3_000_000 the stage is COMPLETE:
        // fraction must reach completed-weight levels, not freeze at 3/4.
        let m = MockInvoker::ok("{}", "");
        m.push_run(ScriptedRun {
            events: vec![
                stdout("out_time_us=1500000\nspeed=2x\nprogress=continue\n"),
                stdout("out_time_us=3000000\nspeed=2x\nprogress=end\n"),
                done(0),
            ],
        });
        let job = ProcessingState::default();
        let (store, emit) = collector();
        let mut agg = ProgressAgg::new(4.0); // total work = the one stage's weight
        let ctx = StageCtx {
            stage: Stage::Single,
            seg_index: 1,
            seg_count: 1,
            span: 3.0,
            weight: 4.0,
            watch_faststart: false,
        };
        let out = run_stage(&m, &job, vec![], &ctx, &mut agg, &emit)
            .await
            .unwrap();
        assert_eq!(out.code, Some(0));
        assert!(!out.cancelled);
        let evs = store.lock().unwrap();
        // halfway block: stage_fraction = 1.5/3 = 0.5 → overall 0.5*4/4 = 0.5
        assert!(
            (evs[0].fraction - 0.5).abs() < 1e-9,
            "got {}",
            evs[0].fraction
        );
        // stage finalizes at FULL weight on exit-0 (spec §4.1 hardening)
        let last = evs.last().unwrap();
        assert!(
            (last.fraction - 0.99).abs() < 1e-9,
            "capped at 0.99, got {}",
            last.fraction
        );
    }

    #[tokio::test]
    async fn fraction_is_monotonic_even_when_out_time_regresses() {
        let m = MockInvoker::ok("{}", "");
        m.push_run(ScriptedRun {
            events: vec![
                stdout("out_time_us=2000000\nprogress=continue\n"),
                stdout("out_time_us=N/A\nprogress=continue\n"), // N/A keeps last
                stdout("out_time_us=-100\nprogress=continue\n"), // clamp low
                done(0),
            ],
        });
        let job = ProcessingState::default();
        let (store, emit) = collector();
        let mut agg = ProgressAgg::new(4.0);
        let ctx = StageCtx {
            stage: Stage::Single,
            seg_index: 1,
            seg_count: 1,
            span: 4.0,
            weight: 4.0,
            watch_faststart: false,
        };
        run_stage(&m, &job, vec![], &ctx, &mut agg, &emit)
            .await
            .unwrap();
        let evs = store.lock().unwrap();
        let mut prev = 0.0;
        for e in evs.iter() {
            assert!(
                e.fraction + 1e-12 >= prev,
                "regressed: {} < {prev}",
                e.fraction
            );
            prev = e.fraction;
        }
    }

    #[tokio::test]
    async fn eta_is_none_until_finite_speed_arrives() {
        let m = MockInvoker::ok("{}", "");
        m.push_run(ScriptedRun {
            events: vec![
                stdout("out_time_us=1000000\nspeed=N/A\nprogress=continue\n"),
                stdout("out_time_us=2000000\nspeed=2x\nprogress=continue\n"),
                done(0),
            ],
        });
        let job = ProcessingState::default();
        let (store, emit) = collector();
        let mut agg = ProgressAgg::new(4.0);
        let ctx = StageCtx {
            stage: Stage::Single,
            seg_index: 1,
            seg_count: 1,
            span: 4.0,
            weight: 4.0,
            watch_faststart: false,
        };
        run_stage(&m, &job, vec![], &ctx, &mut agg, &emit)
            .await
            .unwrap();
        let evs = store.lock().unwrap();
        assert_eq!(evs[0].eta_seconds, None);
        // remaining media = 4 - 2 = 2s at speed 2 → ~1s
        assert!((evs[1].eta_seconds.unwrap() - 1.0).abs() < 1e-9);
    }

    #[tokio::test]
    async fn faststart_marker_emits_finalizing_stage() {
        let m = MockInvoker::ok("{}", "");
        m.push_run(ScriptedRun {
            events: vec![
                stdout("out_time_us=4000000\nprogress=continue\n"),
                RunEvent::Stderr(
                    "[out#0/mp4 @ 0x1] Starting second pass: moving the moov atom to the beginning of the file\n"
                        .into(),
                ),
                done(0),
            ],
        });
        let job = ProcessingState::default();
        let (store, emit) = collector();
        let mut agg = ProgressAgg::new(4.0);
        let ctx = StageCtx {
            stage: Stage::Single,
            seg_index: 1,
            seg_count: 1,
            span: 4.0,
            weight: 4.0,
            watch_faststart: true,
        };
        run_stage(&m, &job, vec![], &ctx, &mut agg, &emit)
            .await
            .unwrap();
        let evs = store.lock().unwrap();
        assert!(
            evs.iter().any(|e| e.stage == Stage::Finalizing),
            "no finalizing event in {evs:?}"
        );
    }

    #[tokio::test]
    async fn cancel_set_before_publish_self_kills_and_reports_cancelled() {
        // Spec §2.1/S2: a cancel landing in the spawn gap takes effect at
        // publish time — the runner re-reads the flag under the lock.
        let m = MockInvoker::ok("{}", "");
        m.push_run(ScriptedRun {
            events: vec![done(0)],
        }); // exits "fine"…
        let job = ProcessingState::default();
        job.lock().unwrap().cancel_requested = true; // …but cancel was first
        let (_store, emit) = collector();
        let mut agg = ProgressAgg::new(4.0);
        let ctx = StageCtx {
            stage: Stage::Single,
            seg_index: 1,
            seg_count: 1,
            span: 4.0,
            weight: 4.0,
            watch_faststart: false,
        };
        let out = run_stage(&m, &job, vec![], &ctx, &mut agg, &emit)
            .await
            .unwrap();
        assert!(out.cancelled, "cancel wins over a clean exit (spec §6/N10)");
    }

    #[tokio::test]
    async fn kill_handle_is_cleared_after_natural_terminate() {
        let m = MockInvoker::ok("{}", "");
        m.push_run(ScriptedRun {
            events: vec![done(0)],
        });
        let job = ProcessingState::default();
        let (_s, emit) = collector();
        let mut agg = ProgressAgg::new(1.0);
        let ctx = StageCtx {
            stage: Stage::Single,
            seg_index: 1,
            seg_count: 1,
            span: 1.0,
            weight: 1.0,
            watch_faststart: false,
        };
        run_stage(&m, &job, vec![], &ctx, &mut agg, &emit)
            .await
            .unwrap();
        assert!(
            job.lock().unwrap().kill.is_none(),
            "stale handle left behind (N5)"
        );
    }

    #[tokio::test]
    async fn nonzero_exit_returns_accumulated_stderr_for_classification() {
        let m = MockInvoker::ok("{}", "");
        m.push_run(ScriptedRun {
            events: vec![
                RunEvent::Stderr("Error opening output /o/p.mp4: No space left on device\n".into()),
                done(228),
            ],
        });
        let job = ProcessingState::default();
        let (_s, emit) = collector();
        let mut agg = ProgressAgg::new(1.0);
        let ctx = StageCtx {
            stage: Stage::Single,
            seg_index: 1,
            seg_count: 1,
            span: 1.0,
            weight: 1.0,
            watch_faststart: false,
        };
        let out = run_stage(&m, &job, vec![], &ctx, &mut agg, &emit)
            .await
            .unwrap();
        assert_eq!(out.code, Some(228));
        assert!(out.stderr.contains("No space left on device"));
    }

    // ── run_processing tests ─────────────────────────────────────────────────

    use crate::processing::plan::KeptRange;
    use std::io::Write;

    const PROBE_JSON: &str = r#"{"format":{"duration":"10.0","format_name":"mov,mp4"},"streams":[{"codec_type":"video","codec_name":"h264"},{"codec_type":"audio","codec_name":"aac"}]}"#;
    const KF_CSV: &str = "0.0,K__\n2.0,K__\n4.0,K__\n6.0,K__\n8.0,K__\n";

    struct Rig {
        m: MockInvoker,
        job: ProcessingState,
        _in_file: tempfile::NamedTempFile,
        input: String,
        out_dir: tempfile::TempDir,
        output: String,
    }

    fn rig() -> Rig {
        let mut f = tempfile::NamedTempFile::with_suffix(".mp4").unwrap();
        write!(f, "fake").unwrap();
        let input = f.path().to_string_lossy().to_string();
        let out_dir = tempfile::TempDir::new().unwrap();
        let output = out_dir.path().join("out.mp4").to_string_lossy().to_string();
        Rig {
            m: MockInvoker::ok(PROBE_JSON, KF_CSV),
            job: ProcessingState::default(),
            _in_file: f,
            input,
            out_dir,
            output,
        }
    }

    fn ok_run() -> ScriptedRun {
        ScriptedRun {
            events: vec![
                stdout("out_time_us=1000000\nspeed=10x\nprogress=end\n"),
                done(0),
            ],
        }
    }

    #[tokio::test]
    async fn single_range_happy_path_renames_and_reports_probed_duration() {
        let r = rig();
        r.m.push_run(ok_run()); // one trim stage
        let (_s, emit) = collector();
        let res = run_processing(
            &r.m,
            &r.job,
            &r.input,
            &r.output,
            &[KeptRange {
                start: 0.0,
                end: 10.0,
            }],
            &emit,
        )
        .await
        .unwrap();
        assert!(
            std::path::Path::new(&r.output).exists(),
            "final file renamed in"
        );
        assert!(
            (res.final_duration - 10.0).abs() < 1e-9,
            "verify-probed duration"
        );
        assert!((res.removed_duration - 0.0).abs() < 1e-9);
        assert_eq!(res.segment_count, 1);
        assert!(!r.job.lock().unwrap().active, "active cleared on success");
        // No partial left behind:
        let leftovers: Vec<_> = std::fs::read_dir(r.out_dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with(".easyclip-partial-")
            })
            .collect();
        assert!(
            leftovers.is_empty(),
            "partial sibling not cleaned: {leftovers:?}"
        );
    }

    #[tokio::test]
    async fn multi_range_runs_n_segments_plus_join() {
        let r = rig();
        for _ in 0..3 {
            r.m.push_run(ok_run()); // 2 segments + 1 join
        }
        let (store, emit) = collector();
        let res = run_processing(
            &r.m,
            &r.job,
            &r.input,
            &r.output,
            &[
                KeptRange {
                    start: 0.0,
                    end: 3.0,
                },
                KeptRange {
                    start: 6.0,
                    end: 10.0,
                },
            ],
            &emit,
        )
        .await
        .unwrap();
        assert_eq!(res.segment_count, 2);
        let evs = store.lock().unwrap();
        assert!(evs.iter().any(|e| e.stage == Stage::Segment));
        assert!(evs.iter().any(|e| e.stage == Stage::Concat));
        let mut prev = 0.0;
        for e in evs.iter() {
            assert!(e.fraction + 1e-12 >= prev, "monotonic overall fraction");
            prev = e.fraction;
        }
    }

    #[tokio::test]
    async fn cancel_between_stages_cleans_up_and_returns_operation_cancelled() {
        let r = rig();
        // First segment "succeeds"; the boundary checkpoint before stage 2 must
        // fire. Push only one run; set the flag from the first completed-stage
        // event by wrapping emit (deterministic mid-pipeline cancel).
        r.m.push_run(ok_run());
        let (_s, emit) = collector();
        let job_ptr: &ProcessingState = &r.job;
        let flagging_emit = |ev: ProcessingEvent| {
            if ev.stage == Stage::Segment && ev.eta_seconds.is_some() {
                job_ptr.lock().unwrap().cancel_requested = true;
            }
            emit(ev);
        };
        let res = run_processing(
            &r.m,
            &r.job,
            &r.input,
            &r.output,
            &[
                KeptRange {
                    start: 0.0,
                    end: 3.0,
                },
                KeptRange {
                    start: 6.0,
                    end: 10.0,
                },
            ],
            &flagging_emit,
        )
        .await;
        assert!(
            matches!(res, Err(AppError::OperationCancelled)),
            "got {res:?}"
        );
        assert!(!std::path::Path::new(&r.output).exists());
        assert!(!r.job.lock().unwrap().active);
    }

    #[tokio::test]
    async fn run_after_cancel_starts_clean() {
        // B3: the claim resets cancel_requested.
        let r = rig();
        r.job.lock().unwrap().cancel_requested = true; // stale from a prior cancel
        r.m.push_run(ok_run());
        let (_s, emit) = collector();
        let res = run_processing(
            &r.m,
            &r.job,
            &r.input,
            &r.output,
            &[KeptRange {
                start: 0.0,
                end: 10.0,
            }],
            &emit,
        )
        .await;
        assert!(
            res.is_ok(),
            "stale cancel flag must not abort a new run: {res:?}"
        );
    }

    #[tokio::test]
    async fn concurrent_run_is_rejected_via_active_cas() {
        let r = rig();
        r.job.lock().unwrap().active = true; // a job is "running"
        let (_s, emit) = collector();
        let res = run_processing(
            &r.m,
            &r.job,
            &r.input,
            &r.output,
            &[KeptRange {
                start: 0.0,
                end: 10.0,
            }],
            &emit,
        )
        .await;
        assert!(
            matches!(res, Err(AppError::ProcessingFailed { .. })),
            "got {res:?}"
        );
    }

    #[tokio::test]
    async fn malformed_ranges_are_processing_failed() {
        let r = rig();
        let (_s, emit) = collector();
        for bad in [
            vec![], // empty
            vec![KeptRange {
                start: 5.0,
                end: 3.0,
            }], // inverted
            vec![
                KeptRange {
                    start: 0.0,
                    end: 6.0,
                },
                KeptRange {
                    start: 5.0,
                    end: 8.0,
                },
            ], // overlap
            vec![KeptRange {
                start: 0.0,
                end: 99.0,
            }], // out of bounds
        ] {
            let res = run_processing(&r.m, &r.job, &r.input, &r.output, &bad, &emit).await;
            assert!(
                matches!(res, Err(AppError::ProcessingFailed { .. })),
                "ranges {bad:?} → {res:?}"
            );
        }
    }

    #[tokio::test]
    async fn stage_failure_classifies_stderr_and_cleans_sibling() {
        let r = rig();
        r.m.push_run(ScriptedRun {
            events: vec![
                RunEvent::Stderr("Error opening output x: No space left on device\n".into()),
                done(228),
            ],
        });
        let (_s, emit) = collector();
        let res = run_processing(
            &r.m,
            &r.job,
            &r.input,
            &r.output,
            &[KeptRange {
                start: 0.0,
                end: 10.0,
            }],
            &emit,
        )
        .await;
        assert!(matches!(res, Err(AppError::DiskFull { .. })), "got {res:?}");
        assert!(!std::path::Path::new(&r.output).exists());
    }

    #[tokio::test]
    async fn muxer_tag_failure_retries_restricted_once_then_succeeds() {
        let r = rig();
        r.m.push_run(ScriptedRun {
            events: vec![
                RunEvent::Stderr(
                    "Could not find tag for codec subrip in stream #2, codec not currently supported in container\n"
                        .into(),
                ),
                done(234),
            ],
        });
        r.m.push_run(ok_run()); // the restricted retry
        let (_s, emit) = collector();
        let res = run_processing(
            &r.m,
            &r.job,
            &r.input,
            &r.output,
            &[KeptRange {
                start: 0.0,
                end: 10.0,
            }],
            &emit,
        )
        .await;
        assert!(res.is_ok(), "restricted retry should rescue: {res:?}");
    }

    #[tokio::test]
    async fn io_failure_does_not_trigger_the_map_fallback() {
        // N3: the retry gate is the muxer-tag signature, not any non-zero exit.
        let r = rig();
        r.m.push_run(ScriptedRun {
            events: vec![
                RunEvent::Stderr("Error opening output x: Permission denied\n".into()),
                done(243),
            ],
        });
        // NO second scripted run: a wrongly-fired retry would error with
        // "empty run queue" instead of OutputPathInvalid.
        let (_s, emit) = collector();
        let res = run_processing(
            &r.m,
            &r.job,
            &r.input,
            &r.output,
            &[KeptRange {
                start: 0.0,
                end: 10.0,
            }],
            &emit,
        )
        .await;
        assert!(
            matches!(res, Err(AppError::OutputPathInvalid { .. })),
            "got {res:?}"
        );
    }

    #[tokio::test]
    async fn output_equal_to_input_is_rejected_before_any_spawn() {
        let r = rig();
        let (_s, emit) = collector();
        let res = run_processing(
            &r.m,
            &r.job,
            &r.input,
            &r.input, // output == input
            &[KeptRange {
                start: 0.0,
                end: 10.0,
            }],
            &emit,
        )
        .await;
        assert!(
            matches!(res, Err(AppError::OutputSameAsInput { .. })),
            "got {res:?}"
        );
    }

    #[tokio::test]
    async fn verify_probe_failure_is_wrapped_into_processing_failed() {
        let r = rig();
        r.m.push_run(ok_run());
        // 1st JSON probe (input) fine; 2nd (verify) returns garbage →
        // the orchestrator must wrap into ProcessingFailed, never inherit
        // the probe path's classification (N2).
        r.m.push_probe_json(PROBE_JSON, Some(0));
        r.m.push_probe_json("not json", Some(0));
        let (_s, emit) = collector();
        let res = run_processing(
            &r.m,
            &r.job,
            &r.input,
            &r.output,
            &[KeptRange {
                start: 0.0,
                end: 10.0,
            }],
            &emit,
        )
        .await;
        assert!(
            matches!(res, Err(AppError::ProcessingFailed { .. })),
            "got {res:?}"
        );
    }
}
