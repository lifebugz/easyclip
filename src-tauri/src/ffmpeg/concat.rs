//! Concat-demuxer join (spec §4.2 c). List entries use the verified quote
//! escaping ' → '\''; absolute paths + -safe 0 (relative paths resolve
//! against the LIST file's dir, not CWD — never use them).

use std::path::{Path, PathBuf};

pub fn escape_concat_path(p: &str) -> String {
    format!("'{}'", p.replace('\'', r"'\''"))
}

pub fn list_file_contents(segments: &[PathBuf]) -> String {
    let mut out = String::new();
    for s in segments {
        out.push_str("file ");
        out.push_str(&escape_concat_path(&s.to_string_lossy()));
        out.push('\n');
    }
    out
}

pub struct ConcatCommand;

impl ConcatCommand {
    pub fn build(list: &Path, output: &Path) -> Vec<String> {
        let mut args: Vec<String> = vec![
            "-nostdin".into(),
            "-hide_banner".into(),
            "-nostats".into(),
            "-y".into(),
            "-f".into(),
            "concat".into(),
            "-safe".into(),
            "0".into(),
            "-i".into(),
            list.to_string_lossy().to_string(),
            "-map".into(),
            "0".into(),
            "-ignore_unknown".into(),
            "-c".into(),
            "copy".into(),
        ];
        if crate::ffmpeg::wants_faststart_ext(&crate::ffmpeg::derive_ext(output)) {
            args.push("-movflags".into());
            args.push("+faststart".into());
        }
        args.push("-progress".into());
        args.push("pipe:1".into());
        args.push(output.to_string_lossy().to_string());
        args
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    #[test]
    fn escapes_single_quotes_with_the_quote_dance() {
        assert_eq!(
            escape_concat_path("/tmp/weird dir/seg one's & [b].mp4"),
            r"'/tmp/weird dir/seg one'\''s & [b].mp4'"
        );
    }

    #[test]
    fn plain_path_is_just_quoted() {
        assert_eq!(escape_concat_path("/tmp/seg_0.mp4"), "'/tmp/seg_0.mp4'");
    }

    #[test]
    fn list_contents_one_file_directive_per_segment_lf_terminated() {
        let segs = [PathBuf::from("/t/seg_0.mp4"), PathBuf::from("/t/seg_1.mp4")];
        assert_eq!(
            list_file_contents(&segs),
            "file '/t/seg_0.mp4'\nfile '/t/seg_1.mp4'\n"
        );
    }

    #[test]
    fn join_argv_shape() {
        let args = ConcatCommand::build(Path::new("/t/list.txt"), Path::new("/o/p.mp4"));
        let joined = args.join(" ");
        assert!(joined
            .starts_with("-nostdin -hide_banner -nostats -y -f concat -safe 0 -i /t/list.txt"));
        assert!(joined.contains("-map 0 -ignore_unknown -c copy"));
        assert!(joined.contains("-movflags +faststart"), "mp4 final");
        assert!(
            !joined.contains("avoid_negative_ts"),
            "join needs no ts shift"
        );
        assert!(joined.ends_with("-progress pipe:1 /o/p.mp4"));
    }

    #[test]
    fn join_faststart_gate_matches_extension() {
        let args = ConcatCommand::build(Path::new("/t/list.txt"), Path::new("/o/p.mkv"));
        assert!(!args.join(" ").contains("-movflags"));
    }
}
