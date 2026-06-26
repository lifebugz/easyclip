//! Typed application error.
//!
//! `AppError` is the single error type surfaced across the IPC boundary. Each
//! variant maps to a static i18n key that the frontend renders. The Serialize
//! impl produces a flat shape `{ kind, i18nKey, details }` so the frontend can
//! dispatch on `kind` and call `t(i18nKey)` directly.

use serde::ser::{Serialize, SerializeStruct, Serializer};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AppError {
    InputPathInvalid { path: String },
    OutputPathInvalid { path: String },
    MediaUnsupported { hint: String },
    MediaCorrupted { hint: String },
    ProcessingFailed { hint: String },
    SidecarUnusable { os_hint: String },
    DiskFull { hint: String },
    SelectionTooNarrow { hint: String },
    OutputSameAsInput { path: String },
    OperationCancelled,
    Unknown { details: String },
}

impl AppError {
    /// Stable kind tag for the IPC payload. Frontend dispatches on this.
    pub fn kind(&self) -> &'static str {
        match self {
            AppError::InputPathInvalid { .. } => "InputPathInvalid",
            AppError::OutputPathInvalid { .. } => "OutputPathInvalid",
            AppError::MediaUnsupported { .. } => "MediaUnsupported",
            AppError::MediaCorrupted { .. } => "MediaCorrupted",
            AppError::ProcessingFailed { .. } => "ProcessingFailed",
            AppError::SidecarUnusable { .. } => "SidecarUnusable",
            AppError::DiskFull { .. } => "DiskFull",
            AppError::SelectionTooNarrow { .. } => "SelectionTooNarrow",
            AppError::OutputSameAsInput { .. } => "OutputSameAsInput",
            AppError::OperationCancelled => "OperationCancelled",
            AppError::Unknown { .. } => "Unknown",
        }
    }

    /// i18n key the frontend will pass to `t()`. `None` for OperationCancelled
    /// (handled as a wizard transition, not an error display).
    pub fn i18n_key(&self) -> Option<&'static str> {
        match self {
            AppError::InputPathInvalid { .. } => Some("errors.input.invalid_path"),
            AppError::OutputPathInvalid { .. } => Some("errors.output.invalid_path"),
            AppError::MediaUnsupported { .. } => Some("errors.media.unsupported"),
            AppError::MediaCorrupted { .. } => Some("errors.media.corrupted"),
            AppError::ProcessingFailed { .. } => Some("errors.processing.failed"),
            AppError::SidecarUnusable { .. } => Some("errors.sidecar.unusable"),
            AppError::DiskFull { .. } => Some("errors.disk.full"),
            AppError::SelectionTooNarrow { .. } => Some("errors.selection.too_narrow"),
            AppError::OutputSameAsInput { .. } => Some("errors.output.same_as_input"),
            AppError::OperationCancelled => None,
            AppError::Unknown { .. } => Some("errors.unknown"),
        }
    }

    /// Diagnostic-only details. Logged but never rendered to the user.
    pub fn details(&self) -> Option<&str> {
        match self {
            AppError::InputPathInvalid { path }
            | AppError::OutputPathInvalid { path }
            | AppError::OutputSameAsInput { path } => Some(path.as_str()),
            AppError::MediaUnsupported { hint }
            | AppError::MediaCorrupted { hint }
            | AppError::ProcessingFailed { hint }
            | AppError::DiskFull { hint }
            | AppError::SelectionTooNarrow { hint } => Some(hint.as_str()),
            AppError::SidecarUnusable { os_hint } => Some(os_hint.as_str()),
            AppError::Unknown { details } => Some(details.as_str()),
            AppError::OperationCancelled => None,
        }
    }
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut s = serializer.serialize_struct("AppError", 3)?;
        s.serialize_field("kind", self.kind())?;
        s.serialize_field("i18nKey", &self.i18n_key())?;
        s.serialize_field("details", &self.details())?;
        s.end()
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}({})", self.kind(), self.details().unwrap_or(""))
    }
}

impl std::error::Error for AppError {}

/// Match canonical FFmpeg / OS-loader stderr signatures to an `AppError` variant.
///
/// Order matters: most-specific signatures first (loader failures before
/// FFmpeg-emitted errors), so a dyld-prefixed line is never misclassified as
/// a generic conversion failure.
pub fn classify_stderr(stderr: &str) -> AppError {
    let s = stderr;
    let hint = first_nonempty_line(s);

    // Sidecar / loader failures — these run BEFORE FFmpeg can write its own
    // structured stderr, so they are recognised by OS-loader-specific phrases.
    if s.contains("dyld[")
        || s.contains("dyld: Library not loaded")
        || s.contains("error while loading shared libraries")
        || s.contains(".dll was not found")
        || s.contains("LoadLibrary failed")
    {
        return AppError::SidecarUnusable { os_hint: hint };
    }

    // Disk full — strerror(ENOSPC) text is stable on macOS (no errno
    // localization) and Windows FFmpeg builds (hardcoded English table);
    // the spawn helper sets LC_ALL=C for Linux glibc. Checked early: it
    // co-occurs with "Conversion failed" lines that would otherwise win.
    if s.contains("No space left on device") {
        return AppError::DiskFull { hint };
    }

    // Corruption: container/index level damage.
    if s.contains("moov atom not found")
        || (s.contains("Invalid data found when processing input")
            && !s.contains("Conversion failed"))
    {
        return AppError::MediaCorrupted { hint };
    }

    // Unsupported codec/container — recognised by decoder lookup misses.
    // "not currently supported" alone is NOT sufficient: muxer tag-lookup
    // failures ("Could not find tag for codec ... not currently supported
    // in container") happen on fully-recognized files and must fall through
    // to the processing-failure arms (spec §8/S6).
    if s.contains("Unknown decoder")
        || s.contains("Decoder not found")
        || s.contains("Unsupported codec")
        || (s.contains("not currently supported") && !s.contains("Could not find tag for codec"))
    {
        return AppError::MediaUnsupported { hint };
    }

    // Output not writable — scope EACCES to the WRITE path: input-side
    // permission failures print "Error opening input files:" instead.
    if s.contains("Error opening output") && s.contains("Permission denied") {
        return AppError::OutputPathInvalid { path: hint };
    }

    // Known FFmpeg processing failure modes.
    if s.contains("Conversion failed")
        || s.contains("Could not find tag for codec")
        || s.contains("Error splitting the input into NAL units")
        || s.contains("Error while decoding stream")
    {
        return AppError::ProcessingFailed { hint };
    }

    AppError::Unknown { details: hint }
}

fn first_nonempty_line(s: &str) -> String {
    s.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;

    #[test]
    fn kind_is_stable_for_every_variant() {
        assert_eq!(
            AppError::InputPathInvalid { path: "p".into() }.kind(),
            "InputPathInvalid"
        );
        assert_eq!(
            AppError::OutputPathInvalid { path: "p".into() }.kind(),
            "OutputPathInvalid"
        );
        assert_eq!(
            AppError::MediaUnsupported { hint: "h".into() }.kind(),
            "MediaUnsupported"
        );
        assert_eq!(
            AppError::MediaCorrupted { hint: "h".into() }.kind(),
            "MediaCorrupted"
        );
        assert_eq!(
            AppError::ProcessingFailed { hint: "h".into() }.kind(),
            "ProcessingFailed"
        );
        assert_eq!(
            AppError::SidecarUnusable {
                os_hint: "h".into()
            }
            .kind(),
            "SidecarUnusable"
        );
        assert_eq!(AppError::OperationCancelled.kind(), "OperationCancelled");
        assert_eq!(
            AppError::Unknown {
                details: "d".into()
            }
            .kind(),
            "Unknown"
        );
    }

    #[test]
    fn i18n_key_maps_to_bootstrap_dictionary_keys() {
        assert_eq!(
            AppError::InputPathInvalid { path: "p".into() }.i18n_key(),
            Some("errors.input.invalid_path")
        );
        assert_eq!(
            AppError::MediaCorrupted { hint: "h".into() }.i18n_key(),
            Some("errors.media.corrupted")
        );
        assert_eq!(AppError::OperationCancelled.i18n_key(), None);
        assert_eq!(
            AppError::Unknown {
                details: "d".into()
            }
            .i18n_key(),
            Some("errors.unknown")
        );
    }

    #[test]
    fn serializes_to_kind_i18nkey_details_flat_shape() {
        let err = AppError::InputPathInvalid {
            path: "/bad/path".into(),
        };
        let json = serde_json::to_string(&err).expect("serialize");
        assert_eq!(
            json,
            r#"{"kind":"InputPathInvalid","i18nKey":"errors.input.invalid_path","details":"/bad/path"}"#
        );
    }

    #[test]
    fn cancelled_serializes_with_null_i18n_key_and_null_details() {
        let json = serde_json::to_string(&AppError::OperationCancelled).expect("serialize");
        assert_eq!(
            json,
            r#"{"kind":"OperationCancelled","i18nKey":null,"details":null}"#
        );
    }

    fn read_fixture(name: &str) -> String {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/stderr")
            .join(name);
        fs::read_to_string(&path).unwrap_or_else(|_| panic!("missing fixture {}", path.display()))
    }

    #[test]
    fn classify_stderr_recognises_unsupported_codec() {
        let s = read_fixture("unsupported_codec.txt");
        match classify_stderr(&s) {
            AppError::MediaUnsupported { hint } => {
                assert!(!hint.is_empty(), "hint must be non-empty");
            }
            other => panic!("expected MediaUnsupported, got {:?}", other),
        }
    }

    #[test]
    fn classify_stderr_recognises_corrupted_moov() {
        let s = read_fixture("corrupted_moov.txt");
        match classify_stderr(&s) {
            AppError::MediaCorrupted { hint } => {
                assert!(!hint.is_empty(), "hint must be non-empty");
            }
            other => panic!("expected MediaCorrupted, got {:?}", other),
        }
    }

    #[test]
    fn classify_stderr_recognises_processing_failed() {
        let s = read_fixture("processing_failed.txt");
        match classify_stderr(&s) {
            AppError::ProcessingFailed { hint } => {
                assert!(!hint.is_empty(), "hint must be non-empty");
            }
            other => panic!("expected ProcessingFailed, got {:?}", other),
        }
    }

    #[test]
    fn classify_stderr_recognises_sidecar_unusable_macos() {
        let s = read_fixture("sidecar_unusable_macos.txt");
        match classify_stderr(&s) {
            AppError::SidecarUnusable { os_hint } => {
                assert!(!os_hint.is_empty(), "os_hint must be non-empty");
            }
            other => panic!("expected SidecarUnusable, got {:?}", other),
        }
    }

    #[test]
    fn classify_stderr_recognises_sidecar_unusable_windows() {
        let s = read_fixture("sidecar_unusable_windows.txt");
        match classify_stderr(&s) {
            AppError::SidecarUnusable { os_hint } => {
                assert!(!os_hint.is_empty(), "os_hint must be non-empty");
            }
            other => panic!("expected SidecarUnusable, got {:?}", other),
        }
    }

    #[test]
    fn classify_stderr_recognises_sidecar_unusable_linux() {
        let s = read_fixture("sidecar_unusable_linux.txt");
        match classify_stderr(&s) {
            AppError::SidecarUnusable { os_hint } => {
                assert!(!os_hint.is_empty(), "os_hint must be non-empty");
            }
            other => panic!("expected SidecarUnusable, got {:?}", other),
        }
    }

    #[test]
    fn classify_stderr_falls_back_to_unknown_for_unrecognised_input() {
        match classify_stderr("some random unrelated text\nwith multiple lines\n") {
            AppError::Unknown { details } => {
                assert!(!details.is_empty(), "details must be non-empty");
            }
            other => panic!("expected Unknown, got {:?}", other),
        }
    }

    #[test]
    fn classify_stderr_recognises_unsupported_codec_alternate_phrases() {
        // The MediaUnsupported branch has 4 substrings; the fixture only
        // exercises 2. Cover the remaining 2 inline.
        match classify_stderr("Unsupported codec with id 0 for input stream 0\n") {
            AppError::MediaUnsupported { hint } => assert!(!hint.is_empty()),
            other => panic!("expected MediaUnsupported, got {:?}", other),
        }
        match classify_stderr("Bitstream filter 'foo' not currently supported\n") {
            AppError::MediaUnsupported { hint } => assert!(!hint.is_empty()),
            other => panic!("expected MediaUnsupported, got {:?}", other),
        }
    }

    #[test]
    fn new_variants_have_stable_kinds_and_keys() {
        assert_eq!(AppError::DiskFull { hint: "h".into() }.kind(), "DiskFull");
        assert_eq!(
            AppError::DiskFull { hint: "h".into() }.i18n_key(),
            Some("errors.disk.full")
        );
        assert_eq!(
            AppError::SelectionTooNarrow { hint: "h".into() }.kind(),
            "SelectionTooNarrow"
        );
        assert_eq!(
            AppError::SelectionTooNarrow { hint: "h".into() }.i18n_key(),
            Some("errors.selection.too_narrow")
        );
        assert_eq!(
            AppError::OutputSameAsInput { path: "p".into() }.kind(),
            "OutputSameAsInput"
        );
        assert_eq!(
            AppError::OutputSameAsInput { path: "p".into() }.i18n_key(),
            Some("errors.output.same_as_input")
        );
    }

    #[test]
    fn classify_stderr_recognises_disk_full_mid_mux_and_at_open() {
        for name in ["disk_full_mux.txt", "disk_full_open.txt"] {
            match classify_stderr(&read_fixture(name)) {
                AppError::DiskFull { hint } => assert!(!hint.is_empty()),
                other => panic!("expected DiskFull for {name}, got {other:?}"),
            }
        }
    }

    #[test]
    fn classify_stderr_routes_output_permission_to_output_path_invalid() {
        match classify_stderr(&read_fixture("permission_denied_output.txt")) {
            AppError::OutputPathInvalid { .. } => {}
            other => panic!("expected OutputPathInvalid, got {other:?}"),
        }
    }

    #[test]
    fn classify_stderr_does_not_route_input_permission_to_output_path_invalid() {
        // Input-side EACCES prints "Error opening input files:" — must NOT
        // classify as an output problem. Falls through to Unknown (no
        // dedicated input-permission bucket in v1).
        if let AppError::OutputPathInvalid { .. } =
            classify_stderr(&read_fixture("permission_denied_input.txt"))
        {
            panic!("misclassified input EACCES as output");
        }
    }

    #[test]
    fn classify_stderr_muxer_tag_failure_is_processing_failed_not_unsupported() {
        // "not currently supported" appears in muxer tag-lookup failures on
        // files that WERE fully recognized — spec §8/S6: MediaUnsupported now
        // requires a decoder-lookup phrase as companion.
        match classify_stderr(&read_fixture("muxer_tag_not_supported.txt")) {
            AppError::ProcessingFailed { hint } => assert!(!hint.is_empty()),
            other => panic!("expected ProcessingFailed, got {other:?}"),
        }
    }

    #[test]
    fn classify_stderr_still_recognises_decoder_lookup_unsupported() {
        // Guard must not break the legitimate unsupported-codec route.
        match classify_stderr("Unknown decoder 'foo'\nsomething not currently supported\n") {
            AppError::MediaUnsupported { .. } => {}
            other => panic!("expected MediaUnsupported, got {other:?}"),
        }
    }
}
