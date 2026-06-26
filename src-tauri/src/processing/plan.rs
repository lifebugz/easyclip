//! Plan derivation: requested kept ranges + probed keyframes → executable
//! segments. Implements the spec §3 snap policy exactly:
//! - starts snap FORWARD to the first keyframe >= requested (never leak
//!   removed content); ends are NOT snapped (packet-granular under -c copy);
//! - collapse predicate: post-snap width < MIN_CUT_DUR (covers width <= 0
//!   and tiny survivors); drop silently when the REQUESTED width is also
//!   < MIN_CUT_DUR, abort SelectionTooNarrow otherwise;
//! - post-drop empty plan → SelectionTooNarrow (branch totality, B1);
//! - seek = midpoint(S, next DISTINCT kf) — backward -ss semantics land it
//!   exactly on S; never subtract an epsilon (whole-GOP-early hazard).

use crate::error::AppError;

/// Mirror of src/lib/timeline/constants.ts MIN_CUT_DUR (0.25 s) — the
/// editor's own meaningful-region threshold.
pub const MIN_CUT_DUR: f64 = 0.25;

#[derive(Debug, Clone, Copy, PartialEq, serde::Deserialize)]
pub struct KeptRange {
    pub start: f64,
    pub end: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PlannedSegment {
    pub snapped_start: f64,
    pub end: Option<f64>,  // None = cut to EOF (omit -to)
    pub seek: Option<f64>, // None = omit -ss (range effectively starts at 0)
    pub span: f64,         // progress denominator: (end ?? duration) - (seek ?? 0)
    pub weight: f64,       // cross-stage weight: (end ?? duration) - snapped_start
}

#[derive(Debug)]
pub struct ProcessingPlan {
    pub segments: Vec<PlannedSegment>,
    pub total_weight: f64,
}

pub fn build_plan(
    ranges: &[KeptRange],
    keyframes: &[f64],
    duration: f64,
) -> Result<ProcessingPlan, AppError> {
    // Dedup (N8): exact-equal neighbours collapse so the midpoint rule
    // always sees a DISTINCT next keyframe.
    let mut kfs: Vec<f64> = keyframes.to_vec();
    kfs.dedup();

    let mut segments: Vec<PlannedSegment> = Vec::new();
    for r in ranges {
        let snapped_start = snap_forward(r.start, &kfs);
        let post_snap_width = r.end - snapped_start;
        if post_snap_width < MIN_CUT_DUR {
            // Collapsed (incl. width <= 0 and tiny survivors).
            if r.end - r.start < MIN_CUT_DUR {
                continue; // sub-threshold request → silent drop
            }
            return Err(AppError::SelectionTooNarrow {
                hint: format!(
                    "range [{}, {}) keeps {:.3}s after keyframe snap",
                    r.start, r.end, post_snap_width
                ),
            });
        }
        let seek = seek_target(snapped_start, &kfs, duration);
        let end = if r.end >= duration { None } else { Some(r.end) };
        let effective_end = end.unwrap_or(duration);
        segments.push(PlannedSegment {
            snapped_start,
            end,
            seek,
            span: effective_end - seek.unwrap_or(0.0),
            weight: effective_end - snapped_start,
        });
    }

    if segments.is_empty() {
        return Err(AppError::SelectionTooNarrow {
            hint: "no kept range survived keyframe snapping".into(),
        });
    }

    // Defensive no-op (N20): forward-only start snaps with fixed ends mean
    // gaps only grow — surviving segments provably never touch. The pass
    // guards future policy changes only.
    merge_touching(&mut segments, duration);

    let total_weight = segments.iter().map(|s| s.weight).sum();
    Ok(ProcessingPlan {
        segments,
        total_weight,
    })
}

/// First keyframe >= t; t verbatim when the table is empty (audio-only /
/// over-cap — spec §3.3).
fn snap_forward(t: f64, kfs: &[f64]) -> f64 {
    if kfs.is_empty() {
        return t;
    }
    match kfs.iter().find(|&&k| k >= t) {
        Some(&k) => k,
        // Past the last keyframe: there is nothing to snap forward TO; the
        // collapse predicate decides this range's fate via post-snap width.
        None => t,
    }
}

/// Spec §3.4 midpoint rule. None = omit -ss.
fn seek_target(s: f64, kfs: &[f64], duration: f64) -> Option<f64> {
    if kfs.is_empty() {
        // No table: pass the requested time; ffmpeg's native backward
        // keyframe seek takes over (dense-kf files by construction).
        return if s <= 0.0 { None } else { Some(s) };
    }
    if s <= kfs[0] {
        return None; // at/before the first keyframe → start of file
    }
    match kfs.iter().find(|&&k| k > s) {
        Some(&next) => Some((s + next) / 2.0),
        None => Some(s + (1.0_f64).min((duration - s) / 2.0)),
    }
}

fn merge_touching(segments: &mut Vec<PlannedSegment>, duration: f64) {
    let mut i = 1;
    while i < segments.len() {
        let prev_end = segments[i - 1].end;
        let touches = match prev_end {
            Some(e) => segments[i].snapped_start <= e,
            None => true, // prev runs to EOF — anything after touches
        };
        if touches {
            let cur = segments.remove(i);
            let prev = &mut segments[i - 1];
            prev.end = cur.end;
            let eff_end = cur.end.unwrap_or(duration);
            prev.span = eff_end - prev.seek.unwrap_or(0.0);
            prev.weight = eff_end - prev.snapped_start;
        } else {
            i += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::AppError;

    const KF: &[f64] = &[0.0, 2.0, 4.0, 6.0, 8.0];
    const DUR: f64 = 10.0;

    fn r(start: f64, end: f64) -> KeptRange {
        KeptRange { start, end }
    }

    #[test]
    fn full_range_omits_both_seek_and_to() {
        let p = build_plan(&[r(0.0, 10.0)], KF, DUR).unwrap();
        assert_eq!(p.segments.len(), 1);
        let s = &p.segments[0];
        assert_eq!(s.seek, None);
        assert_eq!(s.end, None); // end == duration → cut to EOF, omit -to
        assert!((s.span - 10.0).abs() < 1e-9);
        assert!((s.weight - 10.0).abs() < 1e-9);
    }

    #[test]
    fn start_snaps_forward_never_backward() {
        // Requested 3.1 → first kf >= 3.1 is 4.0 (NOT 2.0).
        let p = build_plan(&[r(3.1, 10.0)], KF, DUR).unwrap();
        let s = &p.segments[0];
        assert!((s.snapped_start - 4.0).abs() < 1e-9);
        // seek = midpoint(4.0, 6.0) = 5.0
        assert!((s.seek.unwrap() - 5.0).abs() < 1e-9);
    }

    #[test]
    fn end_is_never_snapped() {
        let p = build_plan(&[r(0.0, 7.3)], KF, DUR).unwrap();
        assert!((p.segments[0].end.unwrap() - 7.3).abs() < 1e-9);
    }

    #[test]
    fn span_uses_seek_origin_and_weight_uses_snapped_start() {
        // Spec §4.1 item 3 (review-2 S1): out_time counts from the SEEK point.
        let p = build_plan(&[r(3.1, 9.0)], KF, DUR).unwrap();
        let s = &p.segments[0];
        // snapped_start=4.0, seek=5.0, end=9.0
        assert!((s.span - (9.0 - 5.0)).abs() < 1e-9, "span = E - seek");
        assert!((s.weight - (9.0 - 4.0)).abs() < 1e-9, "weight = E - S");
    }

    #[test]
    fn last_keyframe_uses_half_remainder_seek() {
        // Requested 8.0 → snapped 8.0 is the LAST kf; seek = 8 + min(1, (10-8)/2) = 9.0
        let p = build_plan(&[r(8.0, 10.0)], KF, DUR).unwrap();
        assert!((p.segments[0].seek.unwrap() - 9.0).abs() < 1e-9);
    }

    #[test]
    fn duplicate_keyframes_do_not_degenerate_the_midpoint() {
        // N must be the next DISTINCT kf strictly > S (review-2 N8).
        let kf = &[0.0, 4.0, 4.0, 6.0];
        let p = build_plan(&[r(3.5, 10.0)], kf, DUR).unwrap();
        // S=4.0; next distinct is 6.0 → seek = 5.0 (never (4+4)/2 = 4.0)
        assert!((p.segments[0].seek.unwrap() - 5.0).abs() < 1e-9);
    }

    #[test]
    fn tiny_requested_sliver_is_dropped_silently() {
        // Kept sliver [4.05, 4.10) (requested width 0.05 < MIN_CUT_DUR) has no
        // kf inside → collapses → dropped; the surrounding ranges survive.
        let p = build_plan(&[r(0.0, 3.0), r(4.05, 4.10), r(6.0, 10.0)], KF, DUR).unwrap();
        assert_eq!(p.segments.len(), 2);
    }

    #[test]
    fn meaningful_range_that_collapses_aborts_selection_too_narrow() {
        // Requested [4.5, 5.9): width 1.4 >= MIN_CUT_DUR but no kf inside
        // (next kf 6.0 > 5.9) → post-snap width <= 0 → abort, not drop.
        let r1 = build_plan(&[r(4.5, 5.9)], KF, DUR);
        assert!(
            matches!(r1, Err(AppError::SelectionTooNarrow { .. })),
            "got {r1:?}"
        );
    }

    #[test]
    fn post_snap_width_below_min_counts_as_collapsed() {
        // Requested [3.9, 4.1): snapped start 4.0 → post-snap width 0.1 <
        // MIN_CUT_DUR → collapsed; requested width 0.2 < MIN → dropped.
        // Lone range → post-drop plan empty → SelectionTooNarrow (B1).
        let r1 = build_plan(&[r(3.9, 4.1)], KF, DUR);
        assert!(
            matches!(r1, Err(AppError::SelectionTooNarrow { .. })),
            "got {r1:?}"
        );
    }

    #[test]
    fn all_drops_yield_selection_too_narrow_even_when_each_is_sub_min() {
        let r1 = build_plan(&[r(4.05, 4.12), r(6.05, 6.14)], KF, DUR);
        assert!(
            matches!(r1, Err(AppError::SelectionTooNarrow { .. })),
            "got {r1:?}"
        );
    }

    #[test]
    fn empty_keyframes_pass_requested_times_through() {
        // Audio-only / over-cap: no snapping; seek = requested start verbatim.
        let p = build_plan(&[r(3.1, 9.0)], &[], DUR).unwrap();
        let s = &p.segments[0];
        assert!((s.snapped_start - 3.1).abs() < 1e-9);
        assert!((s.seek.unwrap() - 3.1).abs() < 1e-9);
        assert!((s.span - (9.0 - 3.1)).abs() < 1e-9);
    }

    #[test]
    fn merge_pass_is_a_provable_noop() {
        // Forward-only start snaps + fixed ends mean surviving ranges can
        // never come to touch (review-2 N20) — assert the pass changes nothing.
        let p = build_plan(&[r(0.0, 3.0), r(6.0, 10.0)], KF, DUR).unwrap();
        assert_eq!(p.segments.len(), 2);
        assert!((p.segments[0].end.unwrap() - 3.0).abs() < 1e-9);
        assert!((p.segments[1].snapped_start - 6.0).abs() < 1e-9);
    }

    #[test]
    fn total_weight_sums_segment_weights() {
        let p = build_plan(&[r(0.0, 3.0), r(6.0, 10.0)], KF, DUR).unwrap();
        let sum: f64 = p.segments.iter().map(|s| s.weight).sum();
        assert!((p.total_weight - sum).abs() < 1e-9);
    }
}
