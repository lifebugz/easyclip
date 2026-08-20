//! Shared cancel/kill protocol for long-running ffmpeg jobs.
//!
//! `processing::run_stage` (export) and `ffmpeg::proxy_run::run_proxy` (preview
//! proxies) both spawn ffmpeg, publish a kill handle, drain the event stream and
//! decide a cancel verdict. Those copies are near-identical, and spec §2.1 is
//! binding for BOTH - so a future fix applied to one copy and not the other is a
//! silent divergence in cancellation behaviour. The protocol lives here once.
//!
//! `lock().unwrap()` throughout, matching the rest of the codebase: a poisoned
//! mutex means a panic already unwound while holding job state, and there is no
//! meaningful recovery from that.

use crate::ffmpeg::invoker::{FfmpegRun, KillHandle};

/// State shared by every ffmpeg-backed feature. `ProcessingJob` and `ProxyJob`
/// were field-for-field identical, which is what forced each helper below to be
/// written twice.
#[derive(Default)]
pub struct JobState {
    pub active: bool,
    pub kill: Option<KillHandle>,
    pub cancel_requested: bool,
}

/// One feature's job slot. Each feature wraps this in its OWN newtype rather
/// than aliasing it directly: Tauri's `manage`/`try_state` are keyed by `TypeId`,
/// so two `type XState = SharedJob` aliases would be the same type - the second
/// `manage()` would collide with the first, and cancelling a preview proxy would
/// reach into the export job. See `ProcessingState` / `ProxyState`.
pub type SharedJob = std::sync::Mutex<JobState>;

/// Publish `run`'s kill handle so a concurrent cancel can reach the child - or,
/// if a cancel ALREADY landed, kill immediately and report that.
///
/// Returns `true` when this call self-killed. The caller must OR that into the
/// final verdict: the kill races the child's own exit, so `cancel_requested` can
/// read false by the time the stream drains (spec §6/N10 - a killed ffmpeg on
/// Windows reports exit code 1, indistinguishable from a genuine failure).
///
/// Locking protocol (spec §2.1, BINDING): the mutex is held only for short
/// non-async sections, NEVER across an await, and the guard must be released
/// before `kill()` runs.
pub fn publish_kill(job: &SharedJob, run: &mut FfmpegRun) -> bool {
    let mut j = job.lock().unwrap();
    let kill = std::mem::replace(&mut run.kill, Box::new(|| {}));
    if j.cancel_requested {
        drop(j);
        kill();
        return true;
    }
    j.kill = Some(kill);
    false
}

/// Clear the handle and decide the verdict. Cancel WINS over a coincident exit
/// code, which is why `self_killed` is threaded back in here.
pub fn take_verdict(job: &SharedJob, self_killed: bool) -> bool {
    let mut j = job.lock().unwrap();
    j.kill = None;
    j.cancel_requested || self_killed
}

/// Clears `active` + `kill` on every exit path (success, error, panic).
pub struct ActiveGuard<'a>(pub &'a SharedJob);

impl Drop for ActiveGuard<'_> {
    fn drop(&mut self) {
        let mut j = self.0.lock().unwrap();
        j.active = false;
        j.kill = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run_with_kill(flag: std::sync::Arc<std::sync::atomic::AtomicBool>) -> FfmpegRun {
        let (_tx, rx) = tauri::async_runtime::channel(1);
        FfmpegRun {
            events: rx,
            kill: Box::new(move || flag.store(true, std::sync::atomic::Ordering::SeqCst)),
        }
    }

    #[test]
    fn publishes_the_handle_when_no_cancel_is_pending() {
        let killed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let job: SharedJob = SharedJob::new(JobState::default());
        let mut run = run_with_kill(killed.clone());

        let self_killed = publish_kill(&job, &mut run);

        assert!(!self_killed, "nothing was cancelled, so nothing self-kills");
        assert!(!killed.load(std::sync::atomic::Ordering::SeqCst));
        assert!(
            job.lock().unwrap().kill.is_some(),
            "the handle must be reachable by a later cancel"
        );
    }

    #[test]
    fn self_kills_when_a_cancel_already_landed() {
        let killed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let job: SharedJob = SharedJob::new(JobState {
            active: true,
            kill: None,
            cancel_requested: true,
        });
        let mut run = run_with_kill(killed.clone());

        let self_killed = publish_kill(&job, &mut run);

        assert!(
            self_killed,
            "a pending cancel must be reported to the caller"
        );
        assert!(
            killed.load(std::sync::atomic::Ordering::SeqCst),
            "the child must actually be killed, not just flagged"
        );
        assert!(
            job.lock().unwrap().kill.is_none(),
            "a self-killed run must not leave a stale handle behind"
        );
    }

    #[test]
    fn verdict_prefers_cancel_over_a_clean_exit() {
        let job: SharedJob = SharedJob::new(JobState::default());
        assert!(
            take_verdict(&job, true),
            "self-kill alone decides cancelled"
        );
        let job2: SharedJob = SharedJob::new(JobState {
            active: true,
            kill: None,
            cancel_requested: true,
        });
        assert!(take_verdict(&job2, false));
        assert!(job2.lock().unwrap().kill.is_none());
    }
}
