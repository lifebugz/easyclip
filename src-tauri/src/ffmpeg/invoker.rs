//! FfmpegInvoker trait + three impls: SidecarInvoker (prod), PathInvoker
//! (real-binary L1 tests), MockInvoker (unit-test canned outputs).
//!
//! The trait is intentionally narrow: take an &Path to probe; return a
//! ProcessOutput. The orchestrator (probe.rs) chooses which argv to issue.

use crate::error::AppError;
use async_trait::async_trait;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessOutput {
    pub stdout: String,
    pub stderr: String,
    /// `None` if the process was terminated by a signal (e.g. SIGKILL).
    pub status: Option<i32>,
}

impl ProcessOutput {
    pub fn success(&self) -> bool {
        self.status == Some(0)
    }
}

/// Consuming kill — wraps `CommandChild::kill(self)` (SIGKILL on unix,
/// TerminateProcess exit-1 on Windows). Safe to invoke after natural exit
/// (shared_child makes it a no-op).
pub type KillHandle = Box<dyn FnOnce() + Send>;

/// One spawned ffmpeg run. Trait invariants (every impl): exactly one
/// terminal `Terminated`, ordered after all output events; `kill` is safe
/// after exit; the consumer must not block between `recv`s (the sidecar
/// plugin's internal channel has capacity 1). `Stdout` payloads are raw
/// text, possibly partial — producers append `\n` where line boundaries are
/// known; the progress parser buffers across chunks.
#[derive(Debug, Clone, PartialEq)]
pub enum RunEvent {
    Stdout(String),
    Stderr(String),
    Terminated {
        code: Option<i32>,
        signal: Option<i32>,
    },
}

pub struct FfmpegRun {
    pub events: tauri::async_runtime::Receiver<RunEvent>,
    pub kill: KillHandle,
}

/// What the orchestrator wants to ask ffprobe.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProbePass {
    /// First pass: -v error -show_format -show_streams -of json <file>
    Json,
    /// Second pass: -v error -select_streams V:0 -show_entries packet=pts_time,flags -of csv=p=0 <file>
    /// `V:0` selects the FIRST video stream that is NOT an attached picture / cover
    /// art / thumbnail (capital `V` excludes those; `:0` keeps the original "first
    /// stream only" contract). So a cover-art stream indexed before the real video
    /// can't shadow it (plain `v:0` would select stream-index 0, i.e. the cover).
    KeyframePackets,
}

/// Env applied to EVERY ffmpeg/ffprobe spawn whose stderr can reach
/// classify_stderr: macOS never localizes errno strings and Windows FFmpeg
/// builds hardcode English, so this is zero-cost insurance for Linux glibc
/// (spec §8/S7).
const SPAWN_ENV: [(&str, &str); 1] = [("LC_ALL", "C")];

/// L1/PathInvoker binary resolution: env override first (CI points these at
/// the fetched arch-suffixed sidecars — spec §9.2/B2), bare $PATH name as
/// the local fallback.
pub fn resolve_path_binary(which: &str) -> String {
    let var = if which == "ffmpeg" {
        "EASYCLIP_TEST_FFMPEG"
    } else {
        "EASYCLIP_TEST_FFPROBE"
    };
    std::env::var(var).unwrap_or_else(|_| which.to_string())
}

#[async_trait]
pub trait FfmpegInvoker: Send + Sync + 'static {
    async fn probe(&self, pass: ProbePass, file: &Path) -> Result<ProcessOutput, AppError>;

    /// Spawn the ffmpeg binary with `args`. See `FfmpegRun` for invariants.
    async fn spawn_ffmpeg(&self, args: Vec<String>) -> Result<FfmpegRun, AppError>;
}

/// Production invoker — uses the bundled ffprobe sidecar via tauri-plugin-shell.
pub struct SidecarInvoker {
    app: tauri::AppHandle,
}

impl SidecarInvoker {
    pub fn new(app: tauri::AppHandle) -> Self {
        Self { app }
    }
}

#[async_trait]
impl FfmpegInvoker for SidecarInvoker {
    async fn probe(&self, pass: ProbePass, file: &Path) -> Result<ProcessOutput, AppError> {
        use tauri_plugin_shell::process::CommandEvent;
        use tauri_plugin_shell::ShellExt;

        let args = build_probe_args(pass, file);

        let (mut rx, _child) = self
            .app
            .shell()
            .sidecar("ffprobe")
            .map_err(|e| AppError::SidecarUnusable {
                os_hint: format!("sidecar handle: {e}"),
            })?
            .args(&args)
            .envs(
                SPAWN_ENV
                    .iter()
                    .map(|(k, v)| (k.to_string(), v.to_string()))
                    .collect::<std::collections::HashMap<_, _>>(),
            )
            .spawn()
            .map_err(|e| AppError::SidecarUnusable {
                os_hint: format!("spawn: {e}"),
            })?;

        let mut stdout = String::new();
        let mut stderr = String::new();
        let mut status: Option<i32> = None;
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => stdout.push_str(&String::from_utf8_lossy(&bytes)),
                CommandEvent::Stderr(bytes) => stderr.push_str(&String::from_utf8_lossy(&bytes)),
                CommandEvent::Terminated(payload) => {
                    status = payload.code;
                }
                CommandEvent::Error(e) => {
                    // A pipe read error can fire mid-stream even when the process exits
                    // cleanly. Accumulate it as stderr context and let the Terminated
                    // event surface the real exit code. Task 9's orchestrator routes
                    // non-zero exits through classify_stderr.
                    stderr.push_str(&format!("\n[sidecar pipe error: {e}]\n"));
                }
                _ => {}
            }
        }

        Ok(ProcessOutput {
            stdout,
            stderr,
            status,
        })
    }

    async fn spawn_ffmpeg(&self, args: Vec<String>) -> Result<FfmpegRun, AppError> {
        use tauri_plugin_shell::process::CommandEvent;
        use tauri_plugin_shell::ShellExt;

        let (mut rx, child) = self
            .app
            .shell()
            .sidecar("ffmpeg")
            .map_err(|e| AppError::SidecarUnusable {
                os_hint: format!("sidecar handle: {e}"),
            })?
            .args(&args)
            .envs(
                SPAWN_ENV
                    .iter()
                    .map(|(k, v)| (k.to_string(), v.to_string()))
                    .collect::<std::collections::HashMap<_, _>>(),
            )
            .spawn()
            .map_err(|e| AppError::SidecarUnusable {
                os_hint: format!("spawn: {e}"),
            })?;

        let (tx, out_rx) = tauri::async_runtime::channel::<RunEvent>(64);
        tauri::async_runtime::spawn(async move {
            while let Some(event) = rx.recv().await {
                let mapped = match event {
                    // Plugin line-mode strips newlines — re-append so the
                    // progress parser sees line boundaries.
                    CommandEvent::Stdout(bytes) => Some(RunEvent::Stdout(format!(
                        "{}\n",
                        String::from_utf8_lossy(&bytes)
                    ))),
                    CommandEvent::Stderr(bytes) => Some(RunEvent::Stderr(format!(
                        "{}\n",
                        String::from_utf8_lossy(&bytes)
                    ))),
                    CommandEvent::Terminated(p) => Some(RunEvent::Terminated {
                        code: p.code,
                        signal: p.signal,
                    }),
                    CommandEvent::Error(e) => {
                        Some(RunEvent::Stderr(format!("\n[sidecar pipe error: {e}]\n")))
                    }
                    _ => None, // CommandEvent is #[non_exhaustive]
                };
                if let Some(m) = mapped {
                    if tx.send(m).await.is_err() {
                        break; // consumer gone — stop draining
                    }
                }
            }
        });

        let kill: KillHandle = Box::new(move || {
            let _ = child.kill();
        });
        Ok(FfmpegRun {
            events: out_rx,
            kill,
        })
    }
}

/// L1-test invoker — spawns the system ffprobe on $PATH. Synchronous spawn
/// wrapped in spawn_blocking so the async trait method composes.
pub struct PathInvoker;

#[async_trait]
impl FfmpegInvoker for PathInvoker {
    async fn probe(&self, pass: ProbePass, file: &Path) -> Result<ProcessOutput, AppError> {
        let args = build_probe_args(pass, file);
        let bin = resolve_path_binary("ffprobe");
        let res = tokio::task::spawn_blocking(move || {
            std::process::Command::new(&bin)
                .args(&args)
                .envs(SPAWN_ENV)
                .output()
        })
        .await
        .map_err(|e| AppError::Unknown {
            details: format!("join error: {e}"),
        })?
        .map_err(|e| AppError::SidecarUnusable {
            os_hint: format!("spawn ffprobe: {e}"),
        })?;

        Ok(ProcessOutput {
            stdout: String::from_utf8_lossy(&res.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&res.stderr).into_owned(),
            status: res.status.code(),
        })
    }

    async fn spawn_ffmpeg(&self, args: Vec<String>) -> Result<FfmpegRun, AppError> {
        use std::io::Read;
        use std::process::Stdio;
        use std::sync::{Arc, Mutex};

        let bin = resolve_path_binary("ffmpeg");
        let mut child = std::process::Command::new(&bin)
            .args(&args)
            .envs(SPAWN_ENV)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| AppError::SidecarUnusable {
                os_hint: format!("spawn {bin}: {e}"),
            })?;

        let stdout = child.stdout.take().expect("piped stdout");
        let stderr = child.stderr.take().expect("piped stderr");
        let child = Arc::new(Mutex::new(child));
        let (tx, out_rx) = tauri::async_runtime::channel::<RunEvent>(64);

        // Reader threads stream raw chunks; the wait thread joins them
        // before sending the single terminal Terminated (trait invariant).
        let t_out = std::thread::spawn({
            let tx = tx.clone();
            move || {
                let mut r = stdout;
                let mut buf = [0u8; 4096];
                while let Ok(n) = r.read(&mut buf) {
                    if n == 0 {
                        break;
                    }
                    let chunk = String::from_utf8_lossy(&buf[..n]).into_owned();
                    if tx.blocking_send(RunEvent::Stdout(chunk)).is_err() {
                        break;
                    }
                }
            }
        });
        let t_err = std::thread::spawn({
            let tx = tx.clone();
            move || {
                let mut r = stderr;
                let mut buf = [0u8; 4096];
                while let Ok(n) = r.read(&mut buf) {
                    if n == 0 {
                        break;
                    }
                    let chunk = String::from_utf8_lossy(&buf[..n]).into_owned();
                    if tx.blocking_send(RunEvent::Stderr(chunk)).is_err() {
                        break;
                    }
                }
            }
        });
        std::thread::spawn({
            let child = Arc::clone(&child);
            move || {
                let status = child.lock().unwrap().wait();
                let _ = t_out.join();
                let _ = t_err.join();
                let (code, signal) = match status {
                    Ok(s) => {
                        #[cfg(unix)]
                        let sig = std::os::unix::process::ExitStatusExt::signal(&s);
                        #[cfg(not(unix))]
                        let sig = None;
                        (s.code(), sig)
                    }
                    Err(_) => (None, None),
                };
                let _ = tx.blocking_send(RunEvent::Terminated { code, signal });
            }
        });

        let kill: KillHandle = Box::new(move || {
            let _ = child.lock().unwrap().kill();
        });
        Ok(FfmpegRun {
            events: out_rx,
            kill,
        })
    }
}

/// One scripted spawn_ffmpeg outcome: its ordered event stream, terminal
/// Terminated included. Kill is always a no-op.
pub struct ScriptedRun {
    pub events: Vec<RunEvent>,
}

/// Unit-test invoker — returns canned outputs keyed by ProbePass.
pub struct MockInvoker {
    pub json_stdout: String,
    pub json_stderr: String,
    pub json_status: Option<i32>,
    pub keyframes_stdout: String,
    pub keyframes_stderr: String,
    pub keyframes_status: Option<i32>,
    /// FIFO consumed one entry per spawn_ffmpeg call — independent of the
    /// probe-pass map, so multi-segment orchestration is genuinely exercised.
    pub runs: std::sync::Mutex<std::collections::VecDeque<ScriptedRun>>,
    /// Optional per-call JSON-probe script (FIFO). Empty queue → the static
    /// json_* fields serve (existing behavior). Each entry is (stdout, status).
    pub probe_json_queue: std::sync::Mutex<std::collections::VecDeque<(String, Option<i32>)>>,
}

impl MockInvoker {
    /// Convenience constructor: happy-path stdout for both passes, empty
    /// stderr, exit 0.
    pub fn ok(json: impl Into<String>, keyframes: impl Into<String>) -> Self {
        Self {
            json_stdout: json.into(),
            json_stderr: String::new(),
            json_status: Some(0),
            keyframes_stdout: keyframes.into(),
            keyframes_stderr: String::new(),
            keyframes_status: Some(0),
            runs: std::sync::Mutex::new(std::collections::VecDeque::new()),
            probe_json_queue: std::sync::Mutex::new(std::collections::VecDeque::new()),
        }
    }

    pub fn push_run(&self, run: ScriptedRun) {
        self.runs.lock().unwrap().push_back(run);
    }

    /// Queue a scripted JSON-probe response. The first call's payload serves
    /// the first Json-pass probe, the second serves the second, and so on.
    /// When the queue is empty the static `json_stdout`/`json_status` fields
    /// are used (so all existing tests are unaffected).
    pub fn push_probe_json(&self, stdout: &str, status: Option<i32>) {
        self.probe_json_queue
            .lock()
            .unwrap()
            .push_back((stdout.to_string(), status));
    }
}

#[async_trait]
impl FfmpegInvoker for MockInvoker {
    async fn probe(&self, pass: ProbePass, _file: &Path) -> Result<ProcessOutput, AppError> {
        Ok(match pass {
            ProbePass::Json => {
                // Pop the per-call queue first; fall back to static fields.
                let queued = self.probe_json_queue.lock().unwrap().pop_front();
                match queued {
                    Some((stdout, status)) => ProcessOutput {
                        stdout,
                        stderr: String::new(),
                        status,
                    },
                    None => ProcessOutput {
                        stdout: self.json_stdout.clone(),
                        stderr: self.json_stderr.clone(),
                        status: self.json_status,
                    },
                }
            }
            ProbePass::KeyframePackets => ProcessOutput {
                stdout: self.keyframes_stdout.clone(),
                stderr: self.keyframes_stderr.clone(),
                status: self.keyframes_status,
            },
        })
    }

    async fn spawn_ffmpeg(&self, _args: Vec<String>) -> Result<FfmpegRun, AppError> {
        let run = self
            .runs
            .lock()
            .unwrap()
            .pop_front()
            .ok_or(AppError::Unknown {
                details: "MockInvoker: spawn_ffmpeg called with empty run queue".into(),
            })?;
        let (tx, rx) = tauri::async_runtime::channel::<RunEvent>(run.events.len().max(1));
        for ev in run.events {
            // Capacity == events.len(), so try_send never fails.
            let _ = tx.try_send(ev);
        }
        drop(tx); // close the channel so recv() returns None after the script
        Ok(FfmpegRun {
            events: rx,
            kill: Box::new(|| {}),
        })
    }
}

/// Build ffprobe argv for the given pass. The file path is appended LAST so
/// the orchestrator can be confident no user-controlled string ever lands
/// before a `&'static str` flag literal.
fn build_probe_args(pass: ProbePass, file: &Path) -> Vec<String> {
    // SAFETY: upstream validators (validation.rs) accept paths only via &str,
    // so any &Path that reaches us originated from a UTF-8 string. The
    // to_string_lossy fallback for non-UTF-8 paths is a defense-in-depth
    // safety net; in practice no replacement chars will be emitted.
    let path_arg = file.to_string_lossy().to_string();
    match pass {
        ProbePass::Json => vec![
            "-v".into(),
            "error".into(),
            "-show_format".into(),
            "-show_streams".into(),
            "-of".into(),
            "json".into(),
            path_arg,
        ],
        ProbePass::KeyframePackets => vec![
            "-v".into(),
            "error".into(),
            "-select_streams".into(),
            // `V:0` = the FIRST video stream excluding attached pictures / cover art /
            // thumbnails (capital `V` drops them; `v` includes them). `:0` preserves
            // the original single-stream contract so a multi-video file isn't
            // interleaved. Skips a cover-art stream indexed before the real video,
            // which plain `v:0` would wrongly select.
            "V:0".into(),
            "-show_entries".into(),
            "packet=pts_time,flags".into(),
            "-of".into(),
            "csv=p=0".into(),
            path_arg,
        ],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn mock_invoker_returns_canned_outputs_per_pass() {
        let m = MockInvoker::ok("JSON_HERE", "KF_HERE");
        let p = std::path::PathBuf::from("/tmp/x.mp4");
        let out = m.probe(ProbePass::Json, &p).await.unwrap();
        assert_eq!(out.stdout, "JSON_HERE");
        assert!(out.success());
        let out = m.probe(ProbePass::KeyframePackets, &p).await.unwrap();
        assert_eq!(out.stdout, "KF_HERE");
        assert!(out.success());
    }

    #[test]
    fn build_probe_args_for_json_pass_uses_show_format_show_streams_json() {
        let args = build_probe_args(ProbePass::Json, std::path::Path::new("/x.mp4"));
        assert_eq!(
            args[..6],
            [
                "-v",
                "error",
                "-show_format",
                "-show_streams",
                "-of",
                "json"
            ]
        );
        assert_eq!(args.last().unwrap(), "/x.mp4");
    }

    #[test]
    fn build_probe_args_for_keyframes_pass_uses_packet_pts_time_flags_csv() {
        let args = build_probe_args(ProbePass::KeyframePackets, std::path::Path::new("/x.mp4"));
        assert!(args.iter().any(|a| a == "packet=pts_time,flags"));
        assert!(args.iter().any(|a| a == "csv=p=0"));
        // `V:0` = first video stream excluding attached_pic/cover-art (see ProbePass::KeyframePackets).
        assert!(args.iter().any(|a| a == "V:0"));
        assert_eq!(args.last().unwrap(), "/x.mp4");
    }

    fn run_events(n_stdout: usize, code: Option<i32>) -> Vec<RunEvent> {
        let mut v: Vec<RunEvent> = (0..n_stdout)
            .map(|i| RunEvent::Stdout(format!("out_time_us={}\nprogress=continue\n", i * 1000)))
            .collect();
        v.push(RunEvent::Terminated { code, signal: None });
        v
    }

    #[tokio::test]
    async fn mock_invoker_replays_scripted_runs_fifo() {
        let m = MockInvoker::ok("{}", "");
        m.push_run(ScriptedRun {
            events: run_events(2, Some(0)),
        });
        m.push_run(ScriptedRun {
            events: run_events(1, Some(1)),
        });

        let mut run1 = m.spawn_ffmpeg(vec!["-i".into()]).await.unwrap();
        let mut got1 = Vec::new();
        while let Some(ev) = run1.events.recv().await {
            got1.push(ev);
        }
        assert_eq!(got1.len(), 3);
        assert!(matches!(
            got1.last(),
            Some(RunEvent::Terminated { code: Some(0), .. })
        ));

        let mut run2 = m.spawn_ffmpeg(vec!["-i".into()]).await.unwrap();
        let mut last = None;
        while let Some(ev) = run2.events.recv().await {
            last = Some(ev);
        }
        assert!(matches!(
            last,
            Some(RunEvent::Terminated { code: Some(1), .. })
        ));
    }

    #[tokio::test]
    async fn mock_invoker_errors_when_run_queue_is_empty() {
        let m = MockInvoker::ok("{}", "");
        let r = m.spawn_ffmpeg(vec![]).await;
        assert!(r.is_err(), "unscripted spawn must error, got Ok");
    }

    #[tokio::test]
    async fn mock_invoker_kill_is_safe_noop() {
        let m = MockInvoker::ok("{}", "");
        m.push_run(ScriptedRun {
            events: run_events(0, Some(0)),
        });
        let run = m.spawn_ffmpeg(vec![]).await.unwrap();
        (run.kill)(); // must not panic
    }

    #[test]
    fn resolve_path_binary_prefers_env_override() {
        std::env::set_var("EASYCLIP_TEST_FFPROBE", "/custom/ffprobe-bin");
        assert_eq!(resolve_path_binary("ffprobe"), "/custom/ffprobe-bin");
        std::env::remove_var("EASYCLIP_TEST_FFPROBE");
        assert_eq!(resolve_path_binary("ffprobe"), "ffprobe");
    }
}
