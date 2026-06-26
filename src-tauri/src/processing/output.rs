//! Output safety (spec §7): the final artifact is written to a temp-named
//! sibling IN the destination dir (same volume → atomic rename; real ext
//! last for muxer inference), renamed only on success. The sibling is a
//! NAME ONLY: the creating fd is closed before ffmpeg spawns (a held handle
//! can block ffmpeg's -y open on Windows) and tempfile's unlink-on-Drop is
//! disarmed (it would delete the finished artifact under the rename). The
//! ORCHESTRATOR owns deletion on failure/cancel — never tempfile's Drop.

use crate::error::AppError;
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const PARTIAL_PREFIX: &str = ".easyclip-partial-";

/// Tunable defaults (review-2 N27): sized for transient Windows AV/indexer
/// holds (~600ms worst-case added latency); pinned by the tests above.
const RENAME_ATTEMPTS: u32 = 4;
const RENAME_BACKOFF: Duration = Duration::from_millis(150);

/// Default sweep age (spec §7.2): intra-process reasoning only — a second
/// instance with a >1h in-flight partial in the same folder could in theory
/// be swept; near-unreachable at -c copy throughput, and the sweep is
/// best-effort by design.
pub const SWEEP_MIN_AGE: Duration = Duration::from_secs(3600);

/// Reserve a sibling name via tempfile's CSPRNG generator (no new deps,
/// no hand-rolled PID schemes — review-2 S5), then immediately disarm.
pub fn create_sibling(dest_dir: &Path, ext: &str) -> Result<PathBuf, AppError> {
    let named = tempfile::Builder::new()
        .prefix(PARTIAL_PREFIX)
        .suffix(&format!(".{ext}"))
        .tempfile_in(dest_dir)
        .map_err(|e| AppError::OutputPathInvalid {
            path: format!("{}: {e}", dest_dir.display()),
        })?;
    // into_temp_path() closes the fd; keep() disarms unlink-on-Drop.
    let temp_path = named.into_temp_path();
    temp_path.keep().map_err(|e| AppError::OutputPathInvalid {
        path: format!("{}: {e}", dest_dir.display()),
    })
}

pub fn rename_with_retry(from: &Path, to: &Path) -> Result<(), AppError> {
    let mut last_err: Option<std::io::Error> = None;
    for attempt in 0..RENAME_ATTEMPTS {
        if attempt > 0 {
            std::thread::sleep(RENAME_BACKOFF);
        }
        match std::fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) => last_err = Some(e),
        }
    }
    Err(AppError::ProcessingFailed {
        hint: format!(
            "rename {} -> {} failed after {RENAME_ATTEMPTS} attempts: {}",
            from.display(),
            to.display(),
            last_err.map(|e| e.to_string()).unwrap_or_default()
        ),
    })
}

/// Best-effort: remove aged `.easyclip-partial-*` orphans (crash leftovers)
/// from the destination dir. All errors swallowed by design.
pub fn sweep_stale_partials(dest_dir: &Path, min_age: Duration) {
    let Ok(entries) = std::fs::read_dir(dest_dir) else {
        return;
    };
    let now = std::time::SystemTime::now();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if !name.starts_with(PARTIAL_PREFIX) {
            continue;
        }
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        let Ok(modified) = meta.modified() else {
            continue;
        };
        let aged = now
            .duration_since(modified)
            .map(|age| age >= min_age)
            .unwrap_or(false)
            || min_age.is_zero();
        if aged {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tempfile::TempDir;

    #[test]
    fn create_sibling_yields_closed_named_file_with_ext_last() {
        let d = TempDir::new().unwrap();
        let p = create_sibling(d.path(), "mp4").unwrap();
        let name = p.file_name().unwrap().to_string_lossy().to_string();
        assert!(name.starts_with(PARTIAL_PREFIX), "got {name}");
        assert!(
            name.ends_with(".mp4"),
            "muxer inference needs the real ext last"
        );
        assert!(p.exists(), "placeholder exists so the name is reserved");
        // The file must be writable by a fresh open (no held handle).
        std::fs::write(&p, b"x").unwrap();
    }

    #[test]
    fn rename_with_retry_succeeds_when_source_appears_within_budget() {
        let d = TempDir::new().unwrap();
        let from = d.path().join(format!("{PARTIAL_PREFIX}abc.mp4"));
        let to = d.path().join("final.mp4");
        let from2 = from.clone();
        // Simulate a transient hold: the source materialises ~200ms in.
        let t = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(200));
            std::fs::write(&from2, b"data").unwrap();
        });
        let r = rename_with_retry(&from, &to);
        t.join().unwrap();
        assert!(r.is_ok(), "got {r:?}");
        assert!(to.exists());
    }

    #[test]
    fn rename_with_retry_exhausts_to_processing_failed() {
        let d = TempDir::new().unwrap();
        let from = d.path().join("never-exists.mp4");
        let to = d.path().join("final.mp4");
        let r = rename_with_retry(&from, &to);
        assert!(
            matches!(r, Err(crate::error::AppError::ProcessingFailed { .. })),
            "got {r:?}"
        );
    }

    #[test]
    fn sweep_removes_only_aged_partials_with_matching_prefix() {
        let d = TempDir::new().unwrap();
        let partial = d.path().join(format!("{PARTIAL_PREFIX}old.mp4"));
        let unrelated = d.path().join("keep-me.mp4");
        std::fs::write(&partial, b"x").unwrap();
        std::fs::write(&unrelated, b"x").unwrap();

        // min_age = 1h: the fresh partial survives.
        sweep_stale_partials(d.path(), Duration::from_secs(3600));
        assert!(partial.exists());

        // min_age = 0: the partial goes; the unrelated file never does.
        sweep_stale_partials(d.path(), Duration::ZERO);
        assert!(!partial.exists());
        assert!(unrelated.exists());
    }
}
