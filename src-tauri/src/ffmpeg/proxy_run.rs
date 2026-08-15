//! Preview-proxy orchestrator: claim → re-probe → decide → cache/sweep →
//! build (`.part` + publish-then-recheck kill + progress) → settle.
//!
//! Mirrors run_processing's locking protocol (spec §2.1, binding): the state
//! Mutex is held ONLY for short non-async sections, NEVER across an await;
//! publish-then-recheck closes the spawn/cancel race; ActiveGuard clears
//! `active`/`kill` on every exit path.

use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::error::{classify_stderr, AppError};
use crate::ffmpeg::invoker::{FfmpegInvoker, ProbePass, RunEvent};
use crate::ffmpeg::job::{self, JobState, SharedJob};
use crate::ffmpeg::probe::parse_probe_json;
use crate::ffmpeg::progress::ProgressParser;
use crate::ffmpeg::proxy::{
    build_remux_args, build_transcode_args, choose_proxy_method, proxy_ext, ProxyMethod,
};
use crate::ffmpeg::proxy_cache::{proxy_cache_filename, sweep_proxy_cache, PROXY_CACHE_CAP_BYTES};
use crate::processing::output::rename_with_retry;
use crate::validation::validate_media_path;

/// The preview-proxy job slot. A newtype, not an alias: see
/// `ffmpeg::job::SharedJob` for why the two slots must remain distinct types.
#[derive(Default)]
pub struct ProxyState(pub SharedJob);

impl std::ops::Deref for ProxyState {
    type Target = SharedJob;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

/// Progress event streamed to the frontend while the proxy builds.
/// `fraction: None` = indeterminate (non-finite source duration).
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyEvent {
    pub fraction: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyResult {
    pub proxy_path: String,
    /// "remux" | "transcode" - the frontend uses this only for telemetry/notes.
    pub method: &'static str,
}

/// How long a new build waits for a cancelled predecessor to release the
/// claim (its ActiveGuard drops as the stale task unwinds).
const CLAIM_WAIT: Duration = Duration::from_secs(2);
const CLAIM_POLL: Duration = Duration::from_millis(50);

/// Removes the `.part` unless disarmed (success path renames it first).
struct PartGuard {
    path: PathBuf,
    armed: bool,
}
impl Drop for PartGuard {
    fn drop(&mut self) {
        if self.armed {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

/// Claim the proxy slot, evicting a stale build. Unlike processing (which
/// refuses concurrent jobs), a NEW preview request always wins: the user has
/// moved on to another file, so the old build is cancelled + killed and we
/// wait (bounded) for its guard to release the claim.
async fn claim(state: &ProxyState) -> Result<(), AppError> {
    let deadline = std::time::Instant::now() + CLAIM_WAIT;
    loop {
        {
            let mut j = state.lock().unwrap();
            if !j.active {
                *j = JobState {
                    active: true,
                    kill: None,
                    cancel_requested: false,
                };
                return Ok(());
            }
            // Stale build: cancel + kill, then poll for its ActiveGuard.
            j.cancel_requested = true;
            if let Some(k) = j.kill.take() {
                drop(j);
                k();
            }
        }
        if std::time::Instant::now() >= deadline {
            return Err(AppError::ProcessingFailed {
                hint: "preview proxy: previous build did not release".into(),
            });
        }
        tokio::time::sleep(CLAIM_POLL).await;
    }
}

/// Best-effort mtime refresh so LRU sweeping keeps hot cache entries alive.
fn touch(path: &Path) {
    if let Ok(f) = std::fs::File::options().append(true).open(path) {
        let _ = f.set_modified(std::time::SystemTime::now());
    }
}

pub async fn run_proxy(
    invoker: &dyn FfmpegInvoker,
    state: &ProxyState,
    source: &str,
    cache_dir: &Path,
    force_transcode: bool,
    emit: &(dyn Fn(ProxyEvent) + Send + Sync),
) -> Result<ProxyResult, AppError> {
    claim(state).await?;
    let _active = job::ActiveGuard(state);

    let source_path = validate_media_path(source)?;

    // Re-probe - authoritative for the decision; the original UI probe stays
    // authoritative for everything the UI shows.
    let out = invoker.probe(ProbePass::Json, &source_path).await?;
    if !out.success() {
        return Err(classify_stderr(&out.stderr));
    }
    let fields = parse_probe_json(&out.stdout)?;

    let method = if force_transcode {
        ProxyMethod::Transcode
    } else {
        choose_proxy_method(
            fields.has_real_video,
            &fields.codec,
            fields.has_audio,
            &fields.audio_codec,
        )
    };
    let ext = proxy_ext(fields.has_real_video);

    std::fs::create_dir_all(cache_dir).map_err(|e| AppError::Unknown {
        details: format!("proxy cache dir: {e}"),
    })?;
    let meta = std::fs::metadata(&source_path).map_err(|e| AppError::Unknown {
        details: format!("source metadata: {e}"),
    })?;
    let name = proxy_cache_filename(
        &source_path,
        meta.len(),
        meta.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH),
        method,
        ext,
    );
    let final_path = cache_dir.join(&name);

    // Cache hit: no spawn at all (the mock test proves it - an unscripted
    // spawn_ffmpeg would error).
    if final_path.is_file()
        && std::fs::metadata(&final_path)
            .map(|m| m.len() > 0)
            .unwrap_or(false)
    {
        touch(&final_path);
        emit(ProxyEvent {
            fraction: Some(1.0),
        });
        return Ok(ProxyResult {
            proxy_path: final_path.to_string_lossy().into_owned(),
            method: method_name(method),
        });
    }

    sweep_proxy_cache(cache_dir, PROXY_CACHE_CAP_BYTES);

    let part_path = cache_dir.join(format!("{name}.part"));
    let mut part_guard = PartGuard {
        path: part_path.clone(),
        armed: true,
    };

    let args = match method {
        ProxyMethod::Remux => build_remux_args(
            &source_path,
            &part_path,
            fields.has_real_video,
            &fields.codec,
            &fields.audio_codec,
        ),
        ProxyMethod::Transcode => {
            build_transcode_args(&source_path, &part_path, fields.has_real_video)
        }
    };

    let mut run = invoker.spawn_ffmpeg(args).await?;
    let self_killed = job::publish_kill(state, &mut run);

    let span_us = if fields.duration.is_finite() && fields.duration > 0.0 {
        Some(fields.duration * 1_000_000.0)
    } else {
        None
    };
    let mut parser = ProgressParser::new();
    let mut stderr = String::new();
    let mut code: Option<i32> = None;
    let mut last_fraction = 0.0_f64;

    while let Some(ev) = run.events.recv().await {
        match ev {
            RunEvent::Stdout(chunk) => {
                for block in parser.feed(&chunk) {
                    let fraction = match (span_us, block.out_time_us) {
                        (Some(span), Some(us)) => {
                            // Monotonic, capped below 1.0 until settle.
                            last_fraction = last_fraction.max((us as f64 / span).clamp(0.0, 0.99));
                            Some(last_fraction)
                        }
                        _ => None,
                    };
                    emit(ProxyEvent { fraction });
                }
            }
            RunEvent::Stderr(chunk) => stderr.push_str(&chunk),
            RunEvent::Terminated { code: c, .. } => code = c,
        }
    }

    let cancelled = job::take_verdict(state, self_killed);

    if cancelled {
        return Err(AppError::OperationCancelled); // PartGuard removes the .part
    }
    if code != Some(0) {
        return Err(classify_stderr(&stderr));
    }
    // 0-byte guard: ffmpeg can exit 0 having written nothing useful (e.g. an
    // immediately-empty stream selection); an empty proxy must not be cached.
    let produced = std::fs::metadata(&part_path).map(|m| m.len()).unwrap_or(0);
    if produced == 0 {
        return Err(AppError::ProcessingFailed {
            hint: "preview proxy: ffmpeg produced no output".into(),
        });
    }
    rename_with_retry(&part_path, &final_path)?;
    part_guard.armed = false; // renamed away - nothing to clean

    emit(ProxyEvent {
        fraction: Some(1.0),
    });
    Ok(ProxyResult {
        proxy_path: final_path.to_string_lossy().into_owned(),
        method: method_name(method),
    })
}

fn method_name(m: ProxyMethod) -> &'static str {
    match m {
        ProxyMethod::Remux => "remux",
        ProxyMethod::Transcode => "transcode",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ffmpeg::invoker::{MockInvoker, ScriptedRun};
    use std::sync::{Arc, Mutex};
    use std::time::SystemTime;

    const PROBE_MKV_H264_AAC: &str = r#"{
      "format": { "duration": "10.0", "format_name": "matroska,webm" },
      "streams": [
        { "codec_type": "video", "codec_name": "h264" },
        { "codec_type": "audio", "codec_name": "aac" }
      ]
    }"#;

    struct Fixture {
        dir: tempfile::TempDir,
        source: PathBuf,
        state: ProxyState,
        events: Arc<Mutex<Vec<ProxyEvent>>>,
    }

    impl Fixture {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let source = dir.path().join("clip.mkv");
            std::fs::write(&source, b"not-really-media-but-exists").unwrap();
            Self {
                dir,
                source,
                state: ProxyState::default(),
                events: Arc::new(Mutex::new(Vec::new())),
            }
        }

        fn cache_dir(&self) -> PathBuf {
            self.dir.path().join("cache")
        }

        /// The final path run_proxy will compute for this fixture + method.
        fn expected_final(&self, method: ProxyMethod) -> PathBuf {
            let meta = std::fs::metadata(&self.source).unwrap();
            let name = proxy_cache_filename(
                &self.source,
                meta.len(),
                meta.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                method,
                "mp4",
            );
            self.cache_dir().join(name)
        }

        fn emit(&self) -> impl Fn(ProxyEvent) + Send + Sync {
            let events = Arc::clone(&self.events);
            move |e| events.lock().unwrap().push(e)
        }

        async fn run(&self, m: &MockInvoker, force: bool) -> Result<ProxyResult, AppError> {
            run_proxy(
                m,
                &self.state,
                self.source.to_str().unwrap(),
                &self.cache_dir(),
                force,
                &self.emit(),
            )
            .await
        }
    }

    fn mock_with_probe() -> MockInvoker {
        MockInvoker::ok(PROBE_MKV_H264_AAC, "")
    }

    #[tokio::test]
    async fn cache_hit_short_circuits_without_spawn() {
        let f = Fixture::new();
        let expected = f.expected_final(ProxyMethod::Transcode);
        std::fs::create_dir_all(f.cache_dir()).unwrap();
        std::fs::write(&expected, b"cached proxy bytes").unwrap();

        // Empty run queue: any spawn_ffmpeg would error - the Ok proves no spawn.
        let m = mock_with_probe();
        let r = f.run(&m, true).await.unwrap();
        assert_eq!(r.proxy_path, expected.to_string_lossy());
        assert_eq!(r.method, "transcode");
        let evs = f.events.lock().unwrap();
        assert_eq!(
            evs.as_slice(),
            &[ProxyEvent {
                fraction: Some(1.0)
            }]
        );
    }

    #[tokio::test]
    async fn success_renames_part_and_emits_terminal_fraction() {
        let f = Fixture::new();
        let expected = f.expected_final(ProxyMethod::Transcode);
        let part = f.cache_dir().join(format!(
            "{}.part",
            expected.file_name().unwrap().to_string_lossy()
        ));

        // The mock's ffmpeg writes nothing - pre-create the .part the way a
        // real run would, BEFORE run_proxy (the mock consumes its whole event
        // script synchronously, so there is no mid-run hook).
        std::fs::create_dir_all(f.cache_dir()).unwrap();
        std::fs::write(&part, b"proxy payload").unwrap();

        let m = mock_with_probe();
        m.push_run(ScriptedRun {
            events: vec![
                RunEvent::Stdout("out_time_us=5000000\nprogress=continue\n".into()),
                RunEvent::Stdout("out_time_us=10000000\nprogress=end\n".into()),
                RunEvent::Terminated {
                    code: Some(0),
                    signal: None,
                },
            ],
        });
        let r = f.run(&m, true).await.unwrap();
        assert_eq!(r.proxy_path, expected.to_string_lossy());
        assert!(expected.is_file(), "part must be renamed to the final name");
        assert!(!part.exists(), "no .part left behind");
        let evs = f.events.lock().unwrap();
        // 0.5 progress block, capped 0.99 block, terminal 1.0.
        assert_eq!(evs[0].fraction, Some(0.5));
        assert_eq!(evs.last().unwrap().fraction, Some(1.0));
    }

    #[tokio::test]
    async fn failure_removes_part_and_classifies_stderr() {
        let f = Fixture::new();
        let expected = f.expected_final(ProxyMethod::Transcode);
        let part = f.cache_dir().join(format!(
            "{}.part",
            expected.file_name().unwrap().to_string_lossy()
        ));
        std::fs::create_dir_all(f.cache_dir()).unwrap();
        std::fs::write(&part, b"half-written").unwrap();

        let m = mock_with_probe();
        m.push_run(ScriptedRun {
            events: vec![
                RunEvent::Stderr("Invalid data found when processing input\n".into()),
                RunEvent::Terminated {
                    code: Some(1),
                    signal: None,
                },
            ],
        });
        let r = f.run(&m, true).await;
        assert!(r.is_err());
        assert!(!part.exists(), "failed build must remove its .part");
        assert!(!expected.exists());
    }

    #[tokio::test]
    async fn zero_byte_part_is_an_error_not_a_cached_proxy() {
        let f = Fixture::new();
        let expected = f.expected_final(ProxyMethod::Transcode);
        let part = f.cache_dir().join(format!(
            "{}.part",
            expected.file_name().unwrap().to_string_lossy()
        ));
        std::fs::create_dir_all(f.cache_dir()).unwrap();
        std::fs::write(&part, b"").unwrap();

        let m = mock_with_probe();
        m.push_run(ScriptedRun {
            events: vec![RunEvent::Terminated {
                code: Some(0),
                signal: None,
            }],
        });
        let r = f.run(&m, true).await;
        assert!(matches!(r, Err(AppError::ProcessingFailed { .. })), "{r:?}");
        assert!(!part.exists());
        assert!(!expected.exists(), "an empty proxy must never be cached");
    }

    #[tokio::test]
    async fn probe_failure_is_classified_and_no_spawn_happens() {
        let f = Fixture::new();
        let m = MockInvoker {
            json_status: Some(1),
            json_stderr: "moov atom not found".into(),
            ..MockInvoker::ok("", "")
        };
        let r = f.run(&m, true).await;
        assert!(r.is_err());
    }

    #[tokio::test]
    async fn non_finite_duration_emits_indeterminate_progress() {
        let f = Fixture::new();
        let expected = f.expected_final(ProxyMethod::Transcode);
        let part = f.cache_dir().join(format!(
            "{}.part",
            expected.file_name().unwrap().to_string_lossy()
        ));
        std::fs::create_dir_all(f.cache_dir()).unwrap();
        std::fs::write(&part, b"payload").unwrap();

        let m = MockInvoker::ok(
            r#"{
              "format": { "duration": "inf", "format_name": "matroska,webm" },
              "streams": [ { "codec_type": "video", "codec_name": "h264" } ]
            }"#,
            "",
        );
        m.push_run(ScriptedRun {
            events: vec![
                RunEvent::Stdout("out_time_us=5000000\nprogress=continue\n".into()),
                RunEvent::Terminated {
                    code: Some(0),
                    signal: None,
                },
            ],
        });
        let r = f.run(&m, true).await.unwrap();
        assert!(expected.is_file());
        let evs = f.events.lock().unwrap();
        assert_eq!(
            evs[0].fraction, None,
            "non-finite duration → indeterminate progress"
        );
        assert_eq!(evs.last().unwrap().fraction, Some(1.0));
        drop(evs);
        let _ = r;
    }

    /// Decision-integrated path: with force_transcode=false and an h264+aac
    /// probe, choose_proxy_method must pick Remux - the cache filename (and
    /// the returned method) prove which branch ran. Goes green when
    /// choose_proxy_method is implemented per its table tests.
    #[tokio::test]
    async fn h264_aac_in_mkv_routes_to_remux() {
        let f = Fixture::new();
        let expected = f.expected_final(ProxyMethod::Remux);
        let part = f.cache_dir().join(format!(
            "{}.part",
            expected.file_name().unwrap().to_string_lossy()
        ));
        std::fs::create_dir_all(f.cache_dir()).unwrap();
        std::fs::write(&part, b"remuxed payload").unwrap();

        let m = mock_with_probe();
        m.push_run(ScriptedRun {
            events: vec![RunEvent::Terminated {
                code: Some(0),
                signal: None,
            }],
        });
        let r = f.run(&m, false).await.unwrap();
        assert_eq!(r.method, "remux");
        assert_eq!(r.proxy_path, expected.to_string_lossy());
    }
}
