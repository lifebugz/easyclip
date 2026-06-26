//! Parser for ffmpeg `-progress pipe:1` output.
//!
//! Contract (spec §4.1, all empirically verified on 8.1.1):
//! - key=value lines; a `progress=continue|end` line closes a block.
//! - Parse ONLY `out_time_us` (i64 µs) + `speed` (float, trailing `x`,
//!   %g formatting incl. sci-notation, `N/A` → None). NEVER `out_time_ms`
//!   (it has always contained microseconds).
//! - Input arrives as raw chunks — lines can split across feeds; buffer.
//! - A sub-period -c copy run emits a single `end` block and zero
//!   `continue` blocks.

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ProgressBlock {
    pub out_time_us: Option<i64>,
    pub speed: Option<f64>,
    pub end: bool,
}

pub struct ProgressParser {
    line_buf: String,
    cur_out_time_us: Option<i64>,
    cur_speed: Option<f64>,
}

impl ProgressParser {
    pub fn new() -> Self {
        Self {
            line_buf: String::new(),
            cur_out_time_us: None,
            cur_speed: None,
        }
    }

    /// Feed a raw chunk; returns zero or more completed blocks.
    pub fn feed(&mut self, chunk: &str) -> Vec<ProgressBlock> {
        let mut out = Vec::new();
        self.line_buf.push_str(chunk);
        // Consume complete lines; keep the partial tail buffered.
        while let Some(nl) = self.line_buf.find('\n') {
            let line: String = self.line_buf.drain(..=nl).collect();
            let line = line.trim_end_matches(['\n', '\r']);
            let Some(eq) = line.find('=') else { continue };
            let key = &line[..eq];
            let value = line[eq + 1..].trim();
            match key {
                "out_time_us" => {
                    self.cur_out_time_us = value.parse::<i64>().ok();
                }
                "speed" => {
                    self.cur_speed = parse_speed(value);
                }
                "progress" => {
                    out.push(ProgressBlock {
                        out_time_us: self.cur_out_time_us,
                        speed: self.cur_speed,
                        end: value == "end",
                    });
                    self.cur_out_time_us = None;
                    self.cur_speed = None;
                }
                _ => {} // out_time_ms, frame, fps, bitrate, future keys — ignored
            }
        }
        out
    }
}

impl Default for ProgressParser {
    fn default() -> Self {
        Self::new()
    }
}

/// `speed=` uses %g + a trailing `x`: "1.09x", "4e+03x", "N/A".
fn parse_speed(v: &str) -> Option<f64> {
    v.strip_suffix('x')
        .and_then(|s| s.trim().parse::<f64>().ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed_all(chunks: &[&str]) -> Vec<ProgressBlock> {
        let mut p = ProgressParser::new();
        chunks.iter().flat_map(|c| p.feed(c)).collect()
    }

    #[test]
    fn parses_a_full_block_keyed_on_out_time_us_and_speed() {
        let blocks = feed_all(&[
            "frame=180\nfps=32.69\nbitrate= 853.8kbits/s\nout_time_us=6000000\nout_time_ms=6000000\nout_time=00:00:06.000000\nspeed=1.09x\nprogress=continue\n",
        ]);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].out_time_us, Some(6_000_000));
        assert!((blocks[0].speed.unwrap() - 1.09).abs() < 1e-9);
        assert!(!blocks[0].end);
    }

    #[test]
    fn na_values_yield_none_not_zero() {
        let blocks = feed_all(&["out_time_us=N/A\nspeed=N/A\nprogress=continue\n"]);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].out_time_us, None);
        assert_eq!(blocks[0].speed, None);
    }

    #[test]
    fn sci_notation_speed_parses_fully() {
        let blocks = feed_all(&["out_time_us=100\nspeed=4e+03x\nprogress=end\n"]);
        assert!((blocks[0].speed.unwrap() - 4000.0).abs() < 1e-9);
        assert!(blocks[0].end);
    }

    #[test]
    fn chunk_split_lines_are_buffered() {
        let blocks = feed_all(&["out_time_", "us=500\nprog", "ress=continue\n"]);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].out_time_us, Some(500));
    }

    #[test]
    fn audio_only_block_without_frame_keys_parses() {
        let blocks = feed_all(&[
            "bitrate=  72.2kbits/s\ntotal_size=54132\nout_time_us=6000000\nout_time_ms=6000000\nout_time=00:00:06.000000\ndup_frames=0\ndrop_frames=0\nspeed=9.54e+03x\nprogress=end\n",
        ]);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].out_time_us, Some(6_000_000));
        assert!(blocks[0].end);
    }

    #[test]
    fn single_end_block_with_no_continue_is_one_block() {
        let blocks = feed_all(&["out_time_us=1500\nspeed=300x\nprogress=end\n"]);
        assert_eq!(blocks.len(), 1);
        assert!(blocks[0].end);
    }

    #[test]
    fn negative_out_time_us_passes_through_for_caller_clamp() {
        let blocks = feed_all(&["out_time_us=-100000\nprogress=continue\n"]);
        assert_eq!(blocks[0].out_time_us, Some(-100_000));
    }

    #[test]
    fn multiple_blocks_in_one_chunk() {
        let blocks = feed_all(&[
            "out_time_us=1\nprogress=continue\nout_time_us=2\nprogress=continue\nout_time_us=3\nprogress=end\n",
        ]);
        assert_eq!(blocks.len(), 3);
        assert_eq!(blocks[2].out_time_us, Some(3));
        assert!(blocks[2].end);
    }

    #[test]
    fn unknown_keys_are_ignored_forward_compatibly() {
        let blocks = feed_all(&["elapsed=12.5\nnewkey=zzz\nout_time_us=7\nprogress=continue\n"]);
        assert_eq!(blocks[0].out_time_us, Some(7));
    }
}
