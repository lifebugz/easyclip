//! Path validators — the single security boundary that user-controlled paths
//! must cross before reaching FFmpeg argv. Returning `PathBuf` from the
//! validator (rather than `&str`) lets downstream argv builders rely on the
//! type signature as proof the value has been checked.
//!
//! **Important:** the proof holds for paths originating from `&str` (the Tauri
//! IPC layer delivers UTF-8 strings only). Constructing a `PathBuf` from raw
//! bytes elsewhere and passing it directly to a Phase 3 orchestrator would
//! bypass this check — don't do that. All caller paths must go through one of
//! the `validate_*` functions before the value reaches any `&Path` argument.

use crate::error::AppError;
use std::path::{Path, PathBuf};

pub fn validate_media_path(input: &str) -> Result<PathBuf, AppError> {
    validate_no_control_chars(input).map_err(|_| AppError::InputPathInvalid {
        path: input.to_string(),
    })?;
    let p = PathBuf::from(input);
    if !p.exists() || !p.is_file() {
        return Err(AppError::InputPathInvalid {
            path: input.to_string(),
        });
    }
    Ok(p)
}

/// Validate a destination path AND reject writing over the source file.
///
/// `input` must already have passed `validate_media_path` (it exists). The
/// output leaf does NOT exist yet, so `fs::canonicalize(output)` would
/// ENOENT — instead: canonicalize the output's parent (exists per the check
/// below), join the leaf back on, and compare against the canonical input.
/// The leaf comparison is case-insensitive on every platform: APFS and NTFS
/// are case-insensitive by default, and rejecting `CLIP.mp4` vs `clip.mp4`
/// on Linux too is an accepted false positive. Without this check the final
/// rename would clobber the source — "Original file is never modified" is a
/// product promise.
pub fn validate_output_path(output: &str, input: &str) -> Result<PathBuf, AppError> {
    validate_no_control_chars(output).map_err(|_| AppError::OutputPathInvalid {
        path: output.to_string(),
    })?;
    validate_not_reserved_windows_name(output).map_err(|_| AppError::OutputPathInvalid {
        path: output.to_string(),
    })?;
    let p = PathBuf::from(output);
    // Reject Windows-illegal characters in the LEAF filename only (not the whole
    // path: a directory legitimately contains `:` for a Windows drive letter and
    // `\` / `/` as separators). `< > : " | ? *` are invalid in NTFS filenames on
    // every Windows version, so a name carrying one passes shell-safe argv but
    // fails the final rename with an opaque OS error — surface it pre-flight as the
    // friendly OutputPathInvalid instead, mirroring the frontend validateSaveName.
    if let Some(leaf) = p.file_name().and_then(|os| os.to_str()) {
        validate_no_windows_illegal_name_chars(leaf).map_err(|_| AppError::OutputPathInvalid {
            path: output.to_string(),
        })?;
    }
    let parent = p.parent().ok_or_else(|| AppError::OutputPathInvalid {
        path: output.to_string(),
    })?;
    if !parent.exists() || !parent.is_dir() {
        return Err(AppError::OutputPathInvalid {
            path: output.to_string(),
        });
    }

    let canon_input = std::fs::canonicalize(input).map_err(|_| AppError::InputPathInvalid {
        path: input.to_string(),
    })?;
    let canon_parent = std::fs::canonicalize(parent).map_err(|_| AppError::OutputPathInvalid {
        path: output.to_string(),
    })?;
    let out_leaf = p.file_name().ok_or_else(|| AppError::OutputPathInvalid {
        path: output.to_string(),
    })?;
    let same_dir = canon_input.parent() == Some(canon_parent.as_path());
    let same_leaf = canon_input
        .file_name()
        .map(|inp| {
            inp.to_string_lossy().to_lowercase() == out_leaf.to_string_lossy().to_lowercase()
        })
        .unwrap_or(false);
    if same_dir && same_leaf {
        return Err(AppError::OutputSameAsInput {
            path: output.to_string(),
        });
    }

    Ok(p)
}

/// Returns `Err(())` on rejection — callers map to the appropriate AppError variant.
///
/// Rejects only characters that are genuinely unsafe in a path string:
/// - NUL (`\0`) truncates the argv entry handed to the sidecar child process.
/// - CR/LF (`\n`/`\r`) are control characters: pathological in a path and
///   invalid in Windows filenames.
///
/// It deliberately does NOT reject shell metacharacters (`; | & $ ` `). The
/// sidecar is spawned via argv (`tauri_plugin_shell::sidecar(...).spawn()` /
/// `std::process::Command`), NOT through a shell, so those characters cannot be
/// interpreted — and they are common, valid filename characters (e.g. a folder
/// named "Mom & Dad"). Rejecting them broke real, safe user paths for no benefit.
fn validate_no_control_chars(s: &str) -> Result<(), ()> {
    if s.is_empty() {
        return Err(());
    }
    for ch in ['\0', '\n', '\r'] {
        if s.contains(ch) {
            return Err(());
        }
    }
    Ok(())
}

/// Returns `Err(())` on rejection — callers map to the appropriate AppError variant.
///
/// Rejects the characters that are illegal in a Windows (NTFS) FILENAME: any of
/// `< > : " | ? *`. These differ from shell metacharacters — they are not a
/// spawn-safety concern (the sidecar runs via argv) but they cannot appear in a
/// filename on Windows, so a name containing one passes validation yet fails the
/// final file write/rename with an opaque OS error. Apply only to a leaf
/// filename, never a full path (a path legitimately contains `:` for a drive
/// letter and `\`/`/` as separators). Mirrors validate-output.ts::validateSaveName.
fn validate_no_windows_illegal_name_chars(leaf: &str) -> Result<(), ()> {
    for ch in ['<', '>', ':', '"', '|', '?', '*'] {
        if leaf.contains(ch) {
            return Err(());
        }
    }
    Ok(())
}

/// Returns `Err(())` on rejection — callers map to the appropriate AppError variant.
fn validate_not_reserved_windows_name(s: &str) -> Result<(), ()> {
    let stem = Path::new(s)
        .file_stem()
        .and_then(|os| os.to_str())
        .unwrap_or("")
        .to_ascii_uppercase();
    const RESERVED: &[&str] = &[
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    if RESERVED.iter().any(|r| *r == stem) {
        Err(())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::{NamedTempFile, TempDir};

    fn make_input(dir: &TempDir, name: &str) -> String {
        let p = dir.path().join(name);
        std::fs::write(&p, b"x").unwrap();
        p.to_string_lossy().to_string()
    }

    #[test]
    fn validate_media_path_accepts_existing_file() {
        let mut f = NamedTempFile::new().unwrap();
        writeln!(f, "x").unwrap();
        let path_str = f.path().to_string_lossy().to_string();
        assert!(validate_media_path(&path_str).is_ok());
    }

    #[test]
    fn validate_media_path_rejects_missing_file() {
        let r = validate_media_path("/this/path/does/not/exist.mp4");
        assert!(matches!(r, Err(AppError::InputPathInvalid { .. })));
    }

    #[test]
    fn validate_media_path_rejects_empty() {
        assert!(matches!(
            validate_media_path(""),
            Err(AppError::InputPathInvalid { .. })
        ));
    }

    #[test]
    fn validate_media_path_rejects_control_chars() {
        // Control characters are genuinely unsafe in a path string: NUL truncates
        // the argv entry handed to the sidecar child; CR/LF are pathological and
        // invalid in Windows filenames. Shell metacharacters are NOT here — the
        // sidecar is spawned via argv, not a shell (see invoker.rs).
        for bad in ["a\nb", "a\rb", "a\0b"] {
            assert!(
                matches!(
                    validate_media_path(bad),
                    Err(AppError::InputPathInvalid { .. })
                ),
                "expected rejection for {:?}",
                bad
            );
        }
    }

    #[test]
    fn validate_media_path_accepts_shell_punctuation_in_real_filenames() {
        // ffmpeg/ffprobe run via argv (no shell), so &, $, ;, ` are harmless and
        // are valid filename chars on Windows AND Unix. A real file named e.g.
        // "Mom & Dad.mp4" must be openable, not rejected as an "injection".
        let d = TempDir::new().unwrap();
        for name in [
            "Mom & Dad.mp4",
            "a$b.mp4",
            "a;b.mp4",
            "back`tick.mp4",
            "100% done.mp4",
        ] {
            let input = make_input(&d, name);
            assert!(
                validate_media_path(&input).is_ok(),
                "expected acceptance for {:?}",
                name
            );
        }
    }

    #[test]
    fn validate_media_path_rejects_directory() {
        let d = TempDir::new().unwrap();
        let r = validate_media_path(d.path().to_str().unwrap());
        assert!(matches!(r, Err(AppError::InputPathInvalid { .. })));
    }

    #[test]
    fn validate_output_path_accepts_writable_dir_with_clean_name() {
        let d = TempDir::new().unwrap();
        let input = make_input(&d, "source.mp4");
        let out = d.path().join("clip.mp4");
        let r = validate_output_path(out.to_str().unwrap(), &input);
        assert!(r.is_ok(), "got {:?}", r);
    }

    #[test]
    fn validate_output_path_rejects_missing_parent_dir() {
        let d = TempDir::new().unwrap();
        let input = make_input(&d, "source.mp4");
        let r = validate_output_path("/no/such/parent/clip.mp4", &input);
        assert!(matches!(r, Err(AppError::OutputPathInvalid { .. })));
    }

    #[test]
    fn validate_output_path_rejects_windows_reserved_names() {
        let d = TempDir::new().unwrap();
        let input = make_input(&d, "source.mp4");
        for name in ["CON.mp4", "PRN.mov", "nul.mp4", "com1.mkv", "LPT5.mp4"] {
            let p = d.path().join(name);
            let r = validate_output_path(p.to_str().unwrap(), &input);
            assert!(
                matches!(r, Err(AppError::OutputPathInvalid { .. })),
                "expected rejection for {:?}",
                name
            );
        }
    }

    #[test]
    fn validate_output_path_rejects_control_chars() {
        let d = TempDir::new().unwrap();
        let input = make_input(&d, "source.mp4");
        for bad in ["a\nb.mp4", "a\rb.mp4", "a\0b.mp4"] {
            let p = d.path().join(bad);
            assert!(
                matches!(
                    validate_output_path(p.to_str().unwrap(), &input),
                    Err(AppError::OutputPathInvalid { .. })
                ),
                "expected rejection for {:?}",
                bad
            );
        }
    }

    #[test]
    fn validate_output_path_rejects_windows_illegal_name_chars() {
        // `< > : " | ? *` are illegal in Windows (NTFS) filenames. They are
        // shell-safe (argv spawn) but cannot be written as a filename, so the
        // validator must reject them pre-flight rather than let the final rename
        // fail with an opaque OS error. Mirrors validate-output.ts::validateSaveName.
        let d = TempDir::new().unwrap();
        let input = make_input(&d, "source.mp4");
        for name in [
            "a|b.mp4", "a?b.mp4", "a*b.mp4", "a<b.mp4", "a>b.mp4", "a\"b.mp4", "a:b.mp4",
        ] {
            let p = d.path().join(name);
            assert!(
                matches!(
                    validate_output_path(p.to_str().unwrap(), &input),
                    Err(AppError::OutputPathInvalid { .. })
                ),
                "expected rejection for Windows-illegal name {:?}",
                name
            );
        }
    }

    #[test]
    fn validate_output_path_accepts_shell_punctuation() {
        // Same rationale as the input side: argv spawn means &, $, ;, ` in the
        // destination name are safe and common (e.g. "Mom & Dad").
        let d = TempDir::new().unwrap();
        let input = make_input(&d, "source.mp4");
        for name in ["Mom & Dad.mp4", "a$b.mp4", "a;b.mp4", "back`tick.mp4"] {
            let out = d.path().join(name);
            assert!(
                validate_output_path(out.to_str().unwrap(), &input).is_ok(),
                "expected acceptance for {:?}",
                name
            );
        }
    }

    #[test]
    fn validate_output_path_rejects_output_equal_to_input() {
        let d = TempDir::new().unwrap();
        let input = make_input(&d, "clip.mp4");
        let r = validate_output_path(&input, &input);
        assert!(
            matches!(r, Err(AppError::OutputSameAsInput { .. })),
            "got {r:?}"
        );
    }

    #[test]
    fn validate_output_path_rejects_case_folded_same_path() {
        let d = TempDir::new().unwrap();
        let input = make_input(&d, "clip.mp4");
        let upper = d.path().join("CLIP.MP4");
        let r = validate_output_path(upper.to_str().unwrap(), &input);
        assert!(
            matches!(r, Err(AppError::OutputSameAsInput { .. })),
            "got {r:?}"
        );
    }

    #[test]
    fn validate_output_path_rejects_dot_segment_disguise() {
        let d = TempDir::new().unwrap();
        let input = make_input(&d, "clip.mp4");
        let disguised = format!("{}/./clip.mp4", d.path().to_string_lossy());
        let r = validate_output_path(&disguised, &input);
        assert!(
            matches!(r, Err(AppError::OutputSameAsInput { .. })),
            "got {r:?}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn validate_output_path_rejects_symlinked_parent_disguise() {
        let d = TempDir::new().unwrap();
        let input = make_input(&d, "clip.mp4");
        let link = d.path().join("alias");
        std::os::unix::fs::symlink(d.path(), &link).unwrap();
        let via_link = link.join("clip.mp4");
        let r = validate_output_path(via_link.to_str().unwrap(), &input);
        assert!(
            matches!(r, Err(AppError::OutputSameAsInput { .. })),
            "got {r:?}"
        );
    }

    #[test]
    fn validate_output_path_accepts_different_name_same_dir() {
        let d = TempDir::new().unwrap();
        let input = make_input(&d, "clip.mp4");
        let out = d.path().join("clip-trimmed.mp4");
        assert!(validate_output_path(out.to_str().unwrap(), &input).is_ok());
    }
}
