//! Argv builders for the lossless trim paths (spec §4.2 a/b). The file path
//! is appended LAST so no user-controlled string lands before a flag literal
//! (same discipline as build_probe_args). -map_chapters -1: default chapter
//! copy after a trim produces garbage (past-EOF/ghost chapters, verified);
//! concat drops them anyway — dropping everywhere is the only consistent
//! behavior (spec §4.2).

use crate::processing::plan::PlannedSegment;
use std::path::Path;

/// Shortest round-trippable decimal for an f64 (Ryū via `{}`); never f32,
/// never fixed `{:.N}` (spec §3.4/N21 — precision loss can move a seek
/// across a container tick and land a whole GOP early).
pub fn fmt_seconds(v: f64) -> String {
    v.to_string()
}

fn wants_faststart(output: &Path) -> bool {
    crate::ffmpeg::wants_faststart_ext(&crate::ffmpeg::derive_ext(output))
}

pub struct TrimCommand;

impl TrimCommand {
    /// Single kept range → final temp sibling (faststart-gated).
    pub fn for_single_range(input: &Path, output: &Path, seg: &PlannedSegment) -> Vec<String> {
        build(input, output, seg, wants_faststart(output), false)
    }

    /// One segment extract → TempDir intermediate (never faststart).
    pub fn for_segment(input: &Path, seg_output: &Path, seg: &PlannedSegment) -> Vec<String> {
        build(input, seg_output, seg, false, false)
    }

    /// Muxer-tag fallback (one-shot): drop data tracks, keep v/a/s.
    pub fn for_single_range_restricted(
        input: &Path,
        output: &Path,
        seg: &PlannedSegment,
    ) -> Vec<String> {
        build(input, output, seg, wants_faststart(output), true)
    }

    /// Muxer-tag fallback segment variant: drop data tracks, keep v/a/s.
    pub fn for_segment_restricted(
        input: &Path,
        seg_output: &Path,
        seg: &PlannedSegment,
    ) -> Vec<String> {
        build(input, seg_output, seg, false, true)
    }
}

fn build(
    input: &Path,
    output: &Path,
    seg: &PlannedSegment,
    faststart: bool,
    restricted: bool,
) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-nostdin".into(),
        "-hide_banner".into(),
        "-nostats".into(),
        "-y".into(),
    ];
    if let Some(seek) = seg.seek {
        args.push("-ss".into());
        args.push(fmt_seconds(seek));
    }
    if let Some(end) = seg.end {
        args.push("-to".into());
        args.push(fmt_seconds(end));
    }
    args.push("-i".into());
    args.push(input.to_string_lossy().to_string());
    if restricted {
        args.extend(
            [
                "-map",
                "0:v",
                "-map",
                "0:a",
                "-map",
                "0:s?",
                "-map_chapters",
                "-1",
                "-c",
                "copy",
                "-avoid_negative_ts",
                "make_zero",
            ]
            .iter()
            .map(|s| (*s).to_string()),
        );
    } else {
        args.extend(
            [
                "-map",
                "0",
                "-ignore_unknown",
                "-map_chapters",
                "-1",
                "-c",
                "copy",
                "-avoid_negative_ts",
                "make_zero",
            ]
            .iter()
            .map(|s| (*s).to_string()),
        );
    }
    if faststart {
        args.push("-movflags".into());
        args.push("+faststart".into());
    }
    args.push("-progress".into());
    args.push("pipe:1".into());
    args.push(output.to_string_lossy().to_string());
    args
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::processing::plan::PlannedSegment;
    use std::path::Path;

    /// Minimal argv-test builder: span/weight are placeholder 1.0 values and
    /// snapped_start is simplified to the seek value — TrimCommand reads only
    /// `seek` and `end`, so these fields are inert here. Orchestration tests
    /// (Tasks 9/10) construct semantically-correct PlannedSegments via
    /// build_plan instead; never copy this helper there.
    fn seg(seek: Option<f64>, end: Option<f64>) -> PlannedSegment {
        PlannedSegment {
            snapped_start: seek.unwrap_or(0.0),
            end,
            seek,
            span: 1.0,
            weight: 1.0,
        }
    }

    #[test]
    fn fmt_seconds_is_shortest_roundtrip_f64() {
        assert_eq!(fmt_seconds(5.0), "5");
        assert_eq!(fmt_seconds(4.003998), "4.003998");
        assert_eq!(fmt_seconds(0.1), "0.1");
        // Never fixed-precision: a value needing 17 digits keeps them.
        let x = 1.0_f64 / 3.0_f64;
        assert_eq!(fmt_seconds(x).parse::<f64>().unwrap(), x);
    }

    #[test]
    fn single_range_full_argv_order_and_flags() {
        let args = TrimCommand::for_single_range(
            Path::new("/in/clip.mp4"),
            Path::new("/out/.easyclip-partial-x.mp4"),
            &seg(Some(5.0), Some(8.008)),
        );
        let joined = args.join(" ");
        assert!(
            joined.starts_with("-nostdin -hide_banner -nostats -y -ss 5 -to 8.008 -i /in/clip.mp4")
        );
        assert!(joined.contains("-map 0 -ignore_unknown -map_chapters -1 -c copy"));
        assert!(joined.contains("-avoid_negative_ts make_zero"));
        assert!(
            joined.contains("-movflags +faststart"),
            "mp4 final gets faststart"
        );
        assert!(joined.ends_with("-progress pipe:1 /out/.easyclip-partial-x.mp4"));
    }

    #[test]
    fn omits_ss_and_to_when_none() {
        let args = TrimCommand::for_single_range(
            Path::new("/in/clip.mp4"),
            Path::new("/out/p.mp4"),
            &seg(None, None),
        );
        let joined = args.join(" ");
        assert!(!joined.contains("-ss"));
        assert!(!joined.contains("-to"));
    }

    #[test]
    fn faststart_only_for_mp4_mov_m4a() {
        for (out, expect) in [
            ("/o/p.mp4", true),
            ("/o/p.mov", true),
            ("/o/p.m4a", true),
            ("/o/p.mkv", false),
            ("/o/p.webm", false),
            ("/o/p.mp3", false),
        ] {
            let args = TrimCommand::for_single_range(
                Path::new("/in/c.mp4"),
                Path::new(out),
                &seg(None, None),
            );
            assert_eq!(
                args.join(" ").contains("-movflags"),
                expect,
                "faststart gate wrong for {out}"
            );
        }
    }

    #[test]
    fn segment_variant_never_has_faststart() {
        let args = TrimCommand::for_segment(
            Path::new("/in/c.mp4"),
            Path::new("/tmp/seg_0.mp4"),
            &seg(Some(1.0), Some(2.0)),
        );
        assert!(
            !args.join(" ").contains("-movflags"),
            "intermediates skip faststart"
        );
        assert!(args.join(" ").contains("-map_chapters -1"));
    }

    #[test]
    fn restricted_variant_maps_vas_only() {
        let args = TrimCommand::for_segment_restricted(
            Path::new("/in/c.mp4"),
            Path::new("/t/seg_0.mp4"),
            &seg(Some(1.0), Some(2.0)),
        );
        let joined = args.join(" ");
        assert!(joined.contains("-map 0:v -map 0:a -map 0:s?"));
        assert!(!joined.contains("-ignore_unknown"));
        assert!(joined.contains("-map_chapters -1"));
    }
}
