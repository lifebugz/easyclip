//! Preview-proxy planning: pure decision + argv builders (no process spawn).
//!
//! When the WKWebView cannot decode a picked file at runtime, the app builds a
//! WebKit-playable *preview* proxy with the bundled ffmpeg sidecar: a lossless
//! **remux** into mp4/m4a when the codecs are already WebKit-safe (instant -
//! e.g. H.264+AAC inside MKV/FLV/AVI/TS, which this WebKit rejects at the
//! container level), a **transcode** to H.264/AAC otherwise. Trim/export always
//! use the original file; the proxy is preview-only.
//!
//! The codec allowlists are seeded from the OBSERVED decode matrix of the real
//! WKWebView build (2026-07-20, macOS 26): h264 and hevc (hvc1) play natively
//! in mp4; aac/mp3 audio plays in mp4/m4a. vp9/opus/vorbis/flac DO decode
//! natively in their own containers on this WebKit - but a file reaches the
//! proxy path only after native decode already FAILED, and their support
//! inside an mp4 container is not established, so they route to Transcode
//! rather than risk a proxy that fails the same way.

use std::path::Path;

/// How the proxy will be produced. `Remux` is a `-c copy` container swap
/// (lossless, ~instant); `Transcode` re-encodes to H.264/AAC.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProxyMethod {
    Remux,
    Transcode,
}

/// Video codecs the target container (mp4) plays natively in this WebKit.
///
/// Public so `tests/proxy_media.rs` can drive every entry through the REAL
/// sidecar: an allowlist row is a claim that `-c copy` of that codec produces
/// a file ffmpeg will actually mux, and only a real run can check that.
pub const REMUX_SAFE_VIDEO: &[&str] = &["h264", "hevc"];
/// Audio codecs safe to carry into mp4/m4a without re-encoding.
/// See `REMUX_SAFE_VIDEO` for why this is public.
pub const REMUX_SAFE_AUDIO: &[&str] = &["aac", "mp3", "alac"];

/// Decide remux vs transcode from the re-probe of the failing file.
///
/// Rules (all codec names as ffprobe reports them, lowercase):
/// - A video file remuxes iff its video codec is remux-safe AND its audio
///   (when present) is remux-safe too - one non-copyable stream forces a full
///   transcode because a half-copied proxy still would not play.
/// - An audio-only file remuxes iff its audio codec is remux-safe.
/// - Unknown/empty codec names are never remux-safe (probe could not identify
///   the stream, so `-c copy` would preserve exactly what WebKit rejected).
pub fn choose_proxy_method(
    has_real_video: bool,
    video_codec: &str,
    has_audio: bool,
    audio_codec: &str,
) -> ProxyMethod {
    if (!has_real_video || REMUX_SAFE_VIDEO.contains(&video_codec))
        && (!has_audio || REMUX_SAFE_AUDIO.contains(&audio_codec))
    {
        ProxyMethod::Remux
    } else {
        ProxyMethod::Transcode
    }
}

/// Proxy file extension for a given source kind.
pub fn proxy_ext(has_real_video: bool) -> &'static str {
    if has_real_video {
        "mp4"
    } else {
        "m4a"
    }
}

/// Common argv head shared by both builders. `-y` is safe: the orchestrator
/// writes to a fresh `.part` path it owns.
fn args_head(input: &Path) -> Vec<String> {
    vec![
        "-nostdin".into(),
        "-hide_banner".into(),
        "-nostats".into(),
        "-v".into(),
        "error".into(),
        "-y".into(),
        "-i".into(),
        input.to_string_lossy().to_string(),
    ]
}

/// The ffmpeg muxer a proxy is written with. Video proxies always mux `mp4`.
///
/// Audio-only proxies normally mux `ipod` - ffmpeg's M4A muxer, an MP4
/// container with the `M4A ` brand, which is what the `.m4a` extension itself
/// would have selected. `copied_audio` is `Some(codec)` when that codec is
/// being stream-copied and `None` when the audio is re-encoded to AAC: the
/// constraint below is a property of the COPIED codec, so a transcode (which
/// always emits AAC) is never affected by it.
///
/// The exception is MP3. The ipod muxer's codec-tag table has no mp3 entry, so
/// `-c copy` of one dies at header-write - "Could not find tag for codec mp3 in
/// stream #0, codec not currently supported in container", exit 234, 0-byte
/// output (reproduced against the shipped sidecar, ffmpeg 8.1.2). Since `mp3`
/// is remux-safe, that killed EVERY audio-only MP3 preview. The plain `mp4`
/// muxer does carry mp3, so MP3 remuxes there instead.
///
/// aac/alac deliberately KEEP `ipod`. Moving them to `mp4` would change the
/// ftyp major brand from `M4A ` to `isom` on proxies that already play in the
/// shipped build, and only a real-build UAT could show that is harmless - this
/// codebase has been bitten by exactly that class of container detail before
/// (`hev1` vs `hvc1`). Fixing the one broken cell keeps the blast radius at zero.
fn proxy_muxer(has_real_video: bool, copied_audio: Option<&str>) -> &'static str {
    if has_real_video || copied_audio == Some("mp3") {
        "mp4"
    } else {
        "ipod"
    }
}

/// Common argv tail: explicit muxer + streamable output + machine progress.
///
/// The `-f` is load-bearing, not belt-and-braces: the orchestrator writes to a
/// `<name>.mp4.part` / `<name>.m4a.part` temp path, and ffmpeg chooses its
/// output container from the file EXTENSION - which here is `.part`. Without
/// `-f` every build dies at muxer init ("Unable to choose an output format for
/// '….mp4.part'", exit 234), the ladder exhausts, and the preview silently
/// stays on poster. See `proxy_muxer` for which muxer each proxy gets.
fn args_tail(out: &Path, muxer: &str) -> Vec<String> {
    vec![
        "-movflags".into(),
        "+faststart".into(),
        "-f".into(),
        muxer.to_string(),
        "-progress".into(),
        "pipe:1".into(),
        out.to_string_lossy().to_string(),
    ]
}

/// Lossless remux argv. Video files map the first REAL video stream (`0:V:0`
/// skips attached-pic cover art) plus the first audio stream if any; audio-only
/// files drop any cover art with `-vn`. HEVC needs `-tag:v hvc1` - without it
/// the mp4 carries the `hev1` sample-entry, which this WebKit refuses even
/// though the codec itself is supported.
///
/// `audio_codec` is what the source's audio will be COPIED as; it selects the
/// audio-only muxer (see `proxy_muxer`) and is ignored for video proxies.
pub fn build_remux_args(
    input: &Path,
    out: &Path,
    has_real_video: bool,
    video_codec: &str,
    audio_codec: &str,
) -> Vec<String> {
    let mut args = args_head(input);
    if has_real_video {
        args.extend(["-map", "0:V:0", "-map", "0:a:0?", "-c", "copy"].map(String::from));
        if video_codec == "hevc" {
            args.extend(["-tag:v", "hvc1"].map(String::from));
        }
    } else {
        args.extend(["-vn", "-map", "0:a:0", "-c", "copy"].map(String::from));
    }
    args.extend(args_tail(
        out,
        proxy_muxer(has_real_video, Some(audio_codec)),
    ));
    args
}

/// Transcode argv: H.264 (capped at 1280 wide, both dimensions even) + AAC 160k.
/// `-pix_fmt yuv420p` is load-bearing - WebKit will not decode 4:4:4/10-bit
/// H.264, and libx264 preserves the source pixel format without it.
///
/// BOTH scale dimensions must come out even. `h=-2` only fixes the height; the
/// width has to be rounded down explicitly with `trunc(iw/2)*2`, because
/// yuv420p chroma subsampling halves each axis and libx264 refuses to open
/// otherwise ("width not divisible by 2 (321x242)", exit 187, 0-byte output -
/// reproduced against the shipped sidecar with a 321x241 source). Transcode is
/// the ladder's LAST rung, so that left the preview permanently on poster for a
/// file ffmpeg could handle. Odd-width sources are real: cropped clips,
/// screen/window captures of odd-sized regions, some VP8/Theora content.
///
/// `force_divisible_by=2` is NOT an alternative here - it only takes effect
/// alongside `force_original_aspect_ratio`, and was measured still failing with
/// exit 187 on the same source.
pub fn build_transcode_args(input: &Path, out: &Path, has_real_video: bool) -> Vec<String> {
    let mut args = args_head(input);
    if has_real_video {
        args.extend(
            [
                "-map",
                "0:V:0",
                "-map",
                "0:a:0?",
                "-vf",
                "scale=w='min(1280,trunc(iw/2)*2)':h=-2",
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                "23",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-b:a",
                "160k",
            ]
            .map(String::from),
        );
    } else {
        args.extend(["-vn", "-c:a", "aac", "-b:a", "160k"].map(String::from));
    }
    args.extend(args_tail(out, proxy_muxer(has_real_video, None)));
    args
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    // ── choose_proxy_method: the decision table ──
    // Seeded from the observed WKWebView matrix; every row is a real scenario
    // from the Phase A UAT (see plan). Format: (has_real_video, video_codec,
    // has_audio, audio_codec) → expected.
    #[test]
    fn choose_table() {
        use ProxyMethod::*;
        let table: &[(bool, &str, bool, &str, ProxyMethod)] = &[
            // h264+aac in mkv/flv/avi/ts - the flagship remux case.
            (true, "h264", true, "aac", Remux),
            // hevc+aac (hvc1 retag happens in the argv builder, not here).
            (true, "hevc", true, "aac", Remux),
            // Silent h264 video.
            (true, "h264", false, "", Remux),
            // h264 video with mp3 audio (avi world) - mp3 plays in mp4.
            (true, "h264", true, "mp3", Remux),
            // Safe video + unsafe audio forces transcode (half-copy won't play).
            (true, "h264", true, "wmav2", Transcode),
            // Safe video + UNKNOWN audio: probe failed to identify → transcode.
            (true, "h264", true, "", Transcode),
            // Legacy video codecs.
            (true, "mpeg4", true, "mp3", Transcode),
            (true, "wmv2", true, "wmav2", Transcode),
            (true, "mpeg2video", true, "mp2", Transcode),
            // vp9 reaches the proxy only after native decode failed; vp9-in-mp4
            // is not established on this WebKit → transcode.
            (true, "vp9", true, "opus", Transcode),
            // Unknown video codec.
            (true, "", true, "aac", Transcode),
            // Audio-only files.
            (false, "", true, "aac", Remux),
            (false, "", true, "mp3", Remux),
            (false, "", true, "alac", Remux),
            // Degenerate: a file ffprobe reports with NEITHER stream (corrupt,
            // or subtitle/data-only). Both clauses are vacuously true, so this
            // lands on Remux. Harmless and deliberately left as-is: the argv
            // maps `0:a:0`, ffmpeg exits non-zero ("matches no streams"), the
            // ladder retries as transcode, that fails too, and the UI settles on
            // art + "unavailable" - the correct end state. Transcode-instead
            // would cost the same two doomed spawns, so there is nothing to win.
            (false, "", false, "", Remux),
            (false, "", true, "vorbis", Transcode),
            (false, "", true, "opus", Transcode),
            (false, "", true, "", Transcode),
        ];
        for (hv, vc, ha, ac, want) in table {
            assert_eq!(
                choose_proxy_method(*hv, vc, *ha, ac),
                *want,
                "choose_proxy_method({hv}, {vc:?}, {ha}, {ac:?})"
            );
        }
    }

    fn io() -> (PathBuf, PathBuf) {
        (
            PathBuf::from("/media/in.mkv"),
            PathBuf::from("/cache/easyclip-proxy-abc.mp4"),
        )
    }

    #[test]
    fn remux_args_video_h264() {
        let (input, out) = io();
        assert_eq!(
            build_remux_args(&input, &out, true, "h264", "aac"),
            [
                "-nostdin",
                "-hide_banner",
                "-nostats",
                "-v",
                "error",
                "-y",
                "-i",
                "/media/in.mkv",
                "-map",
                "0:V:0",
                "-map",
                "0:a:0?",
                "-c",
                "copy",
                "-movflags",
                "+faststart",
                "-f",
                "mp4",
                "-progress",
                "pipe:1",
                "/cache/easyclip-proxy-abc.mp4"
            ]
        );
    }

    #[test]
    fn remux_args_hevc_gets_hvc1_tag() {
        let (input, out) = io();
        let args = build_remux_args(&input, &out, true, "hevc", "aac");
        let tag_pos = args.iter().position(|a| a == "-tag:v");
        assert!(tag_pos.is_some(), "hevc remux must retag to hvc1: {args:?}");
        assert_eq!(args[tag_pos.unwrap() + 1], "hvc1");
        // The tag must come after `-c copy` (an output option).
        let copy_pos = args.iter().position(|a| a == "copy").unwrap();
        assert!(tag_pos.unwrap() > copy_pos);
        // And h264 must NOT get the tag.
        assert!(
            !build_remux_args(&input, &out, true, "h264", "aac").contains(&"-tag:v".to_string())
        );
    }

    #[test]
    fn remux_args_audio_only() {
        let (input, _) = io();
        let out = PathBuf::from("/cache/easyclip-proxy-abc.m4a");
        assert_eq!(
            build_remux_args(&input, &out, false, "", "aac"),
            [
                "-nostdin",
                "-hide_banner",
                "-nostats",
                "-v",
                "error",
                "-y",
                "-i",
                "/media/in.mkv",
                "-vn",
                "-map",
                "0:a:0",
                "-c",
                "copy",
                "-movflags",
                "+faststart",
                "-f",
                "ipod",
                "-progress",
                "pipe:1",
                "/cache/easyclip-proxy-abc.m4a"
            ]
        );
    }

    #[test]
    fn audio_only_muxer_depends_on_the_copied_codec() {
        // REGRESSION (sidecar-reproduced, ffmpeg 8.1.2): the ipod muxer has no
        // codec tag for mp3, so `-c copy` of an MP3 died at header-write with
        // exit 234 and a 0-byte output - and since `mp3` is remux-safe, that hit
        // EVERY audio-only MP3. mp3 therefore muxes `mp4`; aac/alac keep `ipod`
        // so their already-working proxies keep the `M4A ` ftyp brand.
        // tests/proxy_media.rs proves this end to end against the real sidecar;
        // this pins the decision itself.
        let (input, _) = io();
        let out = PathBuf::from("/cache/easyclip-proxy-abc.m4a");
        let muxer_for = |audio_codec: &str| {
            let args = build_remux_args(&input, &out, false, "", audio_codec);
            let f = args.iter().position(|a| a == "-f").expect("explicit -f");
            args[f + 1].clone()
        };
        assert_eq!(muxer_for("mp3"), "mp4", "ipod cannot tag mp3");
        assert_eq!(muxer_for("aac"), "ipod");
        assert_eq!(muxer_for("alac"), "ipod");

        // A VIDEO file whose audio is mp3 is unaffected - it muxes mp4 anyway.
        let video_out = PathBuf::from("/cache/easyclip-proxy-abc.mp4");
        let args = build_remux_args(&input, &video_out, true, "h264", "mp3");
        let f = args.iter().position(|a| a == "-f").unwrap();
        assert_eq!(args[f + 1], "mp4");

        // A transcode re-encodes to AAC, so the mp3 constraint never applies.
        let audio_tc = build_transcode_args(&input, &out, false);
        let f = audio_tc.iter().position(|a| a == "-f").unwrap();
        assert_eq!(audio_tc[f + 1], "ipod");
    }

    #[test]
    fn transcode_args_video() {
        let (input, out) = io();
        let args = build_transcode_args(&input, &out, true);
        // Spot-check the load-bearing pieces rather than the full literal:
        // yuv420p (WebKit refuses 4:4:4/10-bit), the 1280 cap, libx264+aac,
        // and the faststart+progress tail ending in the output path.
        for needle in [
            // Both dimensions forced even: `h=-2` alone left an odd width, and
            // libx264+yuv420p then refused to open (exit 187, sidecar-verified).
            "scale=w='min(1280,trunc(iw/2)*2)':h=-2",
            "libx264",
            "veryfast",
            "yuv420p",
            "aac",
            "160k",
            "+faststart",
            "pipe:1",
        ] {
            assert!(
                args.contains(&needle.to_string()),
                "missing {needle:?} in {args:?}"
            );
        }
        assert_eq!(args.last().unwrap(), "/cache/easyclip-proxy-abc.mp4");
        assert!(!args.contains(&"-vn".to_string()));
    }

    #[test]
    fn transcode_args_audio_only() {
        let (input, _) = io();
        let out = PathBuf::from("/cache/easyclip-proxy-abc.m4a");
        let args = build_transcode_args(&input, &out, false);
        assert!(args.contains(&"-vn".to_string()));
        assert!(args.contains(&"aac".to_string()));
        assert!(!args.contains(&"libx264".to_string()));
        assert_eq!(args.last().unwrap(), "/cache/easyclip-proxy-abc.m4a");
    }

    #[test]
    fn proxy_ext_by_kind() {
        assert_eq!(proxy_ext(true), "mp4");
        assert_eq!(proxy_ext(false), "m4a");
    }

    #[test]
    fn every_builder_pins_the_muxer_explicitly() {
        // REGRESSION (real-build UAT, 2026-07-25): the orchestrator writes to
        // `<name>.mp4.part`, and ffmpeg picks its output container from the
        // FILE EXTENSION - which is `.part`. Without an explicit `-f` every
        // build died instantly with exit 234, "Unable to choose an output
        // format for '….mp4.part'", so the ladder always exhausted and the
        // preview never left poster mode. Mock-based tests cannot see this
        // (no real ffmpeg runs), hence this argv-level pin.
        let input = PathBuf::from("/media/in.mkv");
        let video_out = PathBuf::from("/cache/easyclip-proxy-abc.mp4.part");
        let audio_out = PathBuf::from("/cache/easyclip-proxy-abc.m4a.part");

        for (args, want) in [
            (
                build_remux_args(&input, &video_out, true, "h264", "aac"),
                "mp4",
            ),
            (build_transcode_args(&input, &video_out, true), "mp4"),
            // `.m4a` is an MP4 container with the M4A brand - ffmpeg's muxer
            // for it is `ipod`, which is what the extension would have picked.
            (
                build_remux_args(&input, &audio_out, false, "", "aac"),
                "ipod",
            ),
            // ...except an mp3 copy, which ipod cannot tag (see
            // `audio_only_muxer_depends_on_the_copied_codec`).
            (
                build_remux_args(&input, &audio_out, false, "", "mp3"),
                "mp4",
            ),
            (build_transcode_args(&input, &audio_out, false), "ipod"),
        ] {
            let f = args.iter().position(|a| a == "-f");
            assert!(f.is_some(), "missing explicit -f muxer in {args:?}");
            assert_eq!(&args[f.unwrap() + 1], want, "wrong muxer in {args:?}");
            // The muxer must precede the output path (it is an output option).
            assert!(f.unwrap() < args.len() - 1);
        }
    }
}
