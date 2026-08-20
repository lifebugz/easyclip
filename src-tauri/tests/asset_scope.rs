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

/// Every extension the file dialog accepts, READ FROM the canonical list in
/// `src/lib/tauri/dialog.ts` instead of restated here.
///
/// A hand-copy cannot catch the drift this guard exists to warn about: add
/// `m4b` to dialog.ts and forget `tauri.conf.json`, and the picker offers a file
/// whose preview silently degrades to art while this test - and clippy, and every
/// e2e spec - stays green. Same trick as `allow_patterns()` above: `include_str!`
/// embeds the real source at compile time, so there is no runtime file IO and the
/// path resolves relative to THIS file rather than the test's working directory.
///
/// Borrowing `&'static str` out of the embedded source rather than allocating
/// `String`s: the slices point into a `'static` buffer, so they outlive any
/// caller for free.
fn media_exts() -> Vec<&'static str> {
    const DIALOG_TS: &str = include_str!("../../src/lib/tauri/dialog.ts");
    ["VIDEO_EXTENSIONS", "AUDIO_EXTENSIONS"]
        .iter()
        .flat_map(|name| {
            let decl = format!("const {name} = [");
            let start = DIALOG_TS.find(&decl).unwrap_or_else(|| {
                panic!("{name} not found in dialog.ts (renamed or reformatted?)")
            }) + decl.len();
            let len = DIALOG_TS[start..]
                .find(']')
                .unwrap_or_else(|| panic!("unterminated {name} array in dialog.ts"));
            DIALOG_TS[start..start + len]
                .split(',')
                .map(|tok| tok.trim().trim_matches('\''))
                .filter(|e| !e.is_empty())
                .collect::<Vec<_>>()
        })
        .collect()
}

/// Without this, a dialog.ts reformat that defeats the parser would yield an
/// EMPTY list, and the extension loop below would pass vacuously - a green test
/// asserting nothing at all.
#[test]
fn dialog_ts_extension_list_actually_parses() {
    let exts = media_exts();
    assert!(
        exts.len() >= 20,
        "parsed only {} extensions from dialog.ts; the parser broke on a reformat: {exts:?}",
        exts.len()
    );
    for must in ["mp4", "mov", "mkv", "ts", "mp3", "opus"] {
        assert!(exts.contains(&must), "expected {must:?} among {exts:?}");
    }
}

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
    for ext in media_exts() {
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

#[test]
fn allows_preview_proxy_outputs_and_denies_their_part_files() {
    // The preview-proxy feature swaps the <video> src to a cache-dir proxy —
    // `preview-proxies/easyclip-proxy-<16hex>.mp4|.m4a`. Those must load via
    // asset:// with NO config change (extension matching covers any depth).
    // The in-flight `.part` must stay unreadable: a half-written proxy served
    // to the webview would reproduce the exact hung-preview bug the proxy
    // exists to fix.
    let patterns = allow_patterns();
    let opts = scope_options();
    let cache = "/Users/me/Library/Caches/com.easyclip.app/preview-proxies";
    for ok in [
        format!("{cache}/easyclip-proxy-0123456789abcdef.mp4"),
        format!("{cache}/easyclip-proxy-0123456789abcdef.m4a"),
    ] {
        assert!(
            is_allowed(&ok, &patterns, &opts),
            "proxy output must be previewable via asset://: {ok}"
        );
    }
    for denied in [
        format!("{cache}/easyclip-proxy-0123456789abcdef.mp4.part"),
        format!("{cache}/easyclip-proxy-0123456789abcdef.m4a.part"),
    ] {
        assert!(
            !is_allowed(&denied, &patterns, &opts),
            "in-flight .part must be unreadable via asset://: {denied}"
        );
    }
}
