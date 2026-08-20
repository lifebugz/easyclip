//! EasyClip Tauri backend.

pub mod commands;
pub mod error;
pub mod ffmpeg;
pub mod processing;
pub mod validation;

use std::sync::Arc;

use commands::FfmpegInvokerHandle;
use ffmpeg::invoker::SidecarInvoker;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let invoker: FfmpegInvokerHandle = Arc::new(SidecarInvoker::new(app.handle().clone()));
            app.manage(invoker);
            app.manage(processing::ProcessingState::default());
            app.manage(ffmpeg::proxy_run::ProxyState::default());
            app.manage(ffmpeg::poster::PosterState::default());
            app.manage(commands::LastOutput(std::sync::Mutex::new(None)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::probe_media,
            commands::extract_poster_frame,
            commands::process_media,
            commands::plan_duration,
            commands::cancel_processing,
            commands::build_preview_proxy,
            commands::cancel_preview_proxy,
            commands::reveal_output,
            commands::open_output
        ]);

    #[cfg(all(target_os = "macos", debug_assertions))]
    let builder = builder.plugin(tauri_plugin_webdriver_automation::init());

    builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                // Best-effort TRIM-07/V17 floor: kill a live child via the
                // same Mutex + take() the orchestrator uses. The destination
                // temp sibling may survive a hard kill — the next-run sweep
                // covers it (spec §7.2).
                if let Some(job) = app_handle.try_state::<processing::ProcessingState>() {
                    let kill = {
                        let mut j = job.lock().unwrap();
                        j.cancel_requested = true;
                        j.kill.take()
                    };
                    if let Some(k) = kill {
                        k();
                    }
                }
                // Same floor for a live preview-proxy build: its .part is
                // covered by the cache sweep on the next run.
                if let Some(job) = app_handle.try_state::<ffmpeg::proxy_run::ProxyState>() {
                    let kill = {
                        let mut j = job.lock().unwrap();
                        j.cancel_requested = true;
                        j.kill.take()
                    };
                    if let Some(k) = kill {
                        k();
                    }
                }
                // And for a live poster extract. Poster mode issues one roughly
                // every 100 ms during playback, so quitting mid-playback very
                // plausibly lands here; its NamedTempFile is removed on drop.
                if let Some(job) = app_handle.try_state::<ffmpeg::poster::PosterState>() {
                    let kill = {
                        let mut j = job.lock().unwrap();
                        j.cancel_requested = true;
                        j.kill.take()
                    };
                    if let Some(k) = kill {
                        k();
                    }
                }
            }
        });
}
