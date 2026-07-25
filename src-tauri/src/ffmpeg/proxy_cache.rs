//! Preview-proxy cache naming + LRU sweep (pure-ish: filesystem only, no
//! process spawn). Proxies live under the app cache dir in
//! `preview-proxies/easyclip-proxy-<16hex>.<mp4|m4a>`; the hash key covers the
//! source identity (path, size, mtime) AND the proxy method, so a source edit
//! or a remux→transcode retry never collides with a stale artifact.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use crate::ffmpeg::proxy::ProxyMethod;

/// Cache filename for a source file's proxy. `size`/`mtime` come from the
/// source's metadata at build time: any change to the source produces a new
/// key, so stale proxies simply age out via the sweep instead of being served.
/// DefaultHasher is fine here - the key is a cache identity, not a security
/// boundary, and 64 bits keeps the name short.
pub fn proxy_cache_filename(
    source: &Path,
    size: u64,
    mtime: SystemTime,
    method: ProxyMethod,
    ext: &str,
) -> String {
    let mut h = DefaultHasher::new();
    source.hash(&mut h);
    size.hash(&mut h);
    // Duration-since-epoch is Hash; a pre-epoch mtime (clock weirdness) maps
    // to the epoch itself rather than failing the whole build.
    mtime
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .hash(&mut h);
    // The method is part of the identity so a forced-transcode retry after a
    // failed remux writes a DIFFERENT file and can't hit the bad artifact.
    matches!(method, ProxyMethod::Transcode).hash(&mut h);
    format!("easyclip-proxy-{:016x}.{ext}", h.finish())
}

/// Age below which a `.part` file is considered a live in-flight build and is
/// never swept (a crashed build's orphan ages past this and gets collected).
const YOUNG_PART_AGE: Duration = Duration::from_secs(60 * 60);

/// Default cache cap: 2 GiB.
pub const PROXY_CACHE_CAP_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/// Evict least-recently-modified proxies until the directory's total size is
/// within `cap_bytes`. Only touches names this module could have written
/// (`easyclip-proxy-*`), skips `.part` files younger than an hour, and NEVER
/// errors: the sweep is best-effort hygiene ahead of a new build - a failure
/// to evict must not block the preview.
pub fn sweep_proxy_cache(dir: &Path, cap_bytes: u64) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let now = SystemTime::now();
    let mut files: Vec<(PathBuf, u64, SystemTime)> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !name.starts_with("easyclip-proxy-") {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let mtime = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        if name.ends_with(".part") {
            let age = now.duration_since(mtime).unwrap_or(Duration::ZERO);
            if age < YOUNG_PART_AGE {
                continue; // live in-flight build - never sweep
            }
            // Orphaned .part from a crashed build: delete outright, it is
            // useless regardless of the cap.
            let _ = std::fs::remove_file(&path);
            continue;
        }
        files.push((path, meta.len(), mtime));
    }

    let mut total: u64 = files.iter().map(|(_, len, _)| len).sum();
    if total <= cap_bytes {
        return;
    }
    // Oldest-modified first = least recently produced/refreshed. Cache hits
    // in the orchestrator re-touch the file's mtime to keep hot entries alive.
    files.sort_by_key(|(_, _, mtime)| *mtime);
    for (path, len, _) in files {
        if total <= cap_bytes {
            break;
        }
        if std::fs::remove_file(&path).is_ok() {
            total = total.saturating_sub(len);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write(dir: &Path, name: &str, bytes: usize) -> PathBuf {
        let p = dir.join(name);
        fs::write(&p, vec![0u8; bytes]).unwrap();
        p
    }

    fn set_mtime(p: &Path, secs_ago: u64) {
        let t = SystemTime::now() - Duration::from_secs(secs_ago);
        let f = fs::File::options().append(true).open(p).unwrap();
        f.set_modified(t).unwrap();
    }

    #[test]
    fn filename_is_stable_and_method_scoped() {
        let src = Path::new("/media/clip.mkv");
        let t = SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        let a = proxy_cache_filename(src, 1234, t, ProxyMethod::Remux, "mp4");
        let b = proxy_cache_filename(src, 1234, t, ProxyMethod::Remux, "mp4");
        assert_eq!(a, b, "same inputs must be deterministic");
        assert!(
            a.starts_with("easyclip-proxy-") && a.ends_with(".mp4"),
            "{a}"
        );
        // 16 hex chars between prefix and extension.
        let hex = &a["easyclip-proxy-".len()..a.len() - ".mp4".len()];
        assert_eq!(hex.len(), 16);
        assert!(hex.chars().all(|c| c.is_ascii_hexdigit()));

        let transcoded = proxy_cache_filename(src, 1234, t, ProxyMethod::Transcode, "mp4");
        assert_ne!(a, transcoded, "method must be part of the cache key");
        let resized = proxy_cache_filename(src, 9999, t, ProxyMethod::Remux, "mp4");
        assert_ne!(a, resized, "source size must be part of the cache key");
        let touched = proxy_cache_filename(
            src,
            1234,
            t + Duration::from_secs(1),
            ProxyMethod::Remux,
            "mp4",
        );
        assert_ne!(a, touched, "source mtime must be part of the cache key");
    }

    #[test]
    fn sweep_evicts_oldest_first_until_under_cap() {
        let dir = tempfile::tempdir().unwrap();
        let old = write(dir.path(), "easyclip-proxy-aaaaaaaaaaaaaaaa.mp4", 100);
        let mid = write(dir.path(), "easyclip-proxy-bbbbbbbbbbbbbbbb.mp4", 100);
        let new = write(dir.path(), "easyclip-proxy-cccccccccccccccc.mp4", 100);
        set_mtime(&old, 3000);
        set_mtime(&mid, 2000);
        set_mtime(&new, 1000);
        sweep_proxy_cache(dir.path(), 250);
        assert!(!old.exists(), "oldest must be evicted first");
        assert!(mid.exists());
        assert!(new.exists());
    }

    #[test]
    fn sweep_is_noop_under_cap_and_ignores_foreign_files() {
        let dir = tempfile::tempdir().unwrap();
        let ours = write(dir.path(), "easyclip-proxy-aaaaaaaaaaaaaaaa.mp4", 100);
        let foreign = write(dir.path(), "user-file.mp4", 10_000);
        sweep_proxy_cache(dir.path(), 150);
        assert!(
            ours.exists(),
            "under-cap (foreign files don't count) - no eviction"
        );
        assert!(foreign.exists(), "never touch names we didn't write");
    }

    #[test]
    fn sweep_skips_young_part_but_collects_orphaned_part() {
        let dir = tempfile::tempdir().unwrap();
        let young = write(dir.path(), "easyclip-proxy-aaaaaaaaaaaaaaaa.mp4.part", 10);
        let orphan = write(dir.path(), "easyclip-proxy-bbbbbbbbbbbbbbbb.mp4.part", 10);
        set_mtime(&orphan, 2 * 60 * 60);
        sweep_proxy_cache(dir.path(), u64::MAX);
        assert!(young.exists(), "in-flight .part must survive");
        assert!(!orphan.exists(), "crashed build's .part must be collected");
    }

    #[test]
    fn sweep_missing_dir_never_errors() {
        sweep_proxy_cache(Path::new("/definitely/not/a/dir"), 0);
    }
}
