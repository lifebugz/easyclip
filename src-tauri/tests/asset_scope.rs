//! Guards the asset-protocol scope allowlist in `tauri.conf.json`.
//!
//! At runtime the webview may only `asset://`-load a file whose canonicalized path
//! matches one of these glob patterns (see `tauri::scope::fs::Scope::is_allowed`,
//! matched with `case_sensitive: true` + `require_literal_separator: true` and our
//! `requireLiteralLeadingDot: false`). Canonicalization can rewrite the *directory*
//! portion but never the filename/extension, and every pattern is `**/*.<ext>`, so
//! extension matching is what actually decides access.
//!
//! That scope is invisible to every other gate — a wrong pattern silently degrades
//! the preview to poster/art with green CI — so this test pins the invariant the
//! `["**"]`→media-only narrowing depends on:
//!   * every supported media extension (any case, any depth, incl. hidden dirs and
//!     camera `.MOV`/`.MP4`) stays previewable; and
//!   * non-media / sensitive files (`~/.ssh/id_rsa`, `.env`, source, …) are NOT
//!     readable via `asset://` — the entire point of dropping the whole-disk scope.

use glob::{MatchOptions, Pattern};
use std::path::Path;

/// The exact options `tauri::scope::fs::Scope` matches with, for our config.
/// Mirrors tauri-2.x `src/scope/fs.rs`: `require_literal_separator: true`,
/// `require_literal_leading_dot` from config (we set it false), and `case_sensitive`
/// left at the `glob` crate default (`true`).
fn scope_options() -> MatchOptions {
    MatchOptions {
        case_sensitive: true,
        require_literal_separator: true,
        require_literal_leading_dot: false,
    }
}

/// Parse the REAL `tauri.conf.json` (embedded at compile time so this test can
/// never drift from the shipped config) and compile its allow patterns.
fn allow_patterns() -> Vec<Pattern> {
    let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json"))
        .expect("tauri.conf.json is valid JSON");
    conf["app"]["security"]["assetProtocol"]["scope"]["allow"]
        .as_array()
        .expect("app.security.assetProtocol.scope.allow is an array")
        .iter()
        .map(|v| {
            Pattern::new(v.as_str().expect("each allow entry is a string"))
                .expect("each allow entry is a valid glob pattern")
        })
        .collect()
}

fn is_allowed(path: &str, patterns: &[Pattern], opts: &MatchOptions) -> bool {
    patterns
        .iter()
        .any(|p| p.matches_path_with(Path::new(path), *opts))
}

/// Every extension the file dialog accepts — mirrors VIDEO_EXTENSIONS +
/// AUDIO_EXTENSIONS in `src/lib/tauri/dialog.ts`. If a format is added there, add
/// it here and to the allowlist, or its preview silently breaks.
const MEDIA_EXTS: &[&str] = &[
    "mp4", "mov", "m4v", "mkv", "webm", "avi", "wmv", "flv", "mpg", "mpeg", "ts", "3gp", "3g2",
    "mts", "m2ts", "mp3", "m4a", "aac", "wav", "flac", "ogg", "opus",
];

fn mixed_case(s: &str) -> String {
    s.char_indices()
        .map(|(i, c)| {
            if i % 2 == 0 {
                c.to_ascii_uppercase()
            } else {
                c.to_ascii_lowercase()
            }
        })
        .collect()
}

#[test]
fn allows_every_supported_media_extension_in_any_case_and_depth() {
    let patterns = allow_patterns();
    let opts = scope_options();
    for ext in MEDIA_EXTS {
        // lowercase (clip.mp4), UPPERCASE (camera CLIP.MOV/.MP4), and mixed (Mp4).
        for cased in [ext.to_string(), ext.to_uppercase(), mixed_case(ext)] {
            for path in [
                format!("/Users/me/Movies/clip.{cased}"),
                // hidden directory segment — reachable because requireLiteralLeadingDot:false
                format!("/Users/me/.archived clips/clip.{cased}"),
                // realistic deep camera path
                format!("/Volumes/SD/DCIM/100GOPRO/GX010001.{cased}"),
            ] {
                assert!(
                    is_allowed(&path, &patterns, &opts),
                    "supported media file must remain previewable: {path}"
                );
            }
        }
    }
}

#[test]
fn denies_non_media_and_sensitive_files() {
    let patterns = allow_patterns();
    let opts = scope_options();
    for path in [
        "/Users/me/.ssh/id_rsa",
        "/Users/me/.ssh/id_rsa.pub",
        "/Users/me/.aws/credentials",
        "/Users/me/project/.env",
        "/Users/me/Documents/passwords.txt",
        "/Users/me/Documents/taxes.pdf",
        "/Users/me/code/src/main.rs",
        "/Users/me/config.json",
        "/etc/passwd",
        // extension is the LAST segment (.txt) — a media infix must not leak it
        "/Users/me/Movies/clip.mp4.txt",
    ] {
        assert!(
            !is_allowed(path, &patterns, &opts),
            "non-media / sensitive file must be unreadable via asset://: {path}"
        );
    }
}
