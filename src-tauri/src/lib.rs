mod app_updates;
mod commands;
mod db;
mod error;
mod excel;
mod link_preview;
mod menu;
mod patterns;
mod window_mgr;

use app_updates::*;
use commands::*;
use db::DbState;
use link_preview::*;
use menu::{sync_link_previews_enabled, MenuState};
use parking_lot::Mutex;
use patterns::PatternState;
use std::collections::HashSet;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, Window};
use window_mgr::{
    filter_supported, open_overview_window, spawn_window, spawn_windows_for_files,
    take_overview_context, take_pending_files, PendingFiles, PendingOverviewContexts,
};

fn args_to_files(argv: &[String]) -> Vec<String> {
    // First arg is the app path itself; subsequent args may be files.
    let candidates: Vec<&str> = argv.iter().skip(1).map(|s| s.as_str()).collect();
    filter_supported(candidates)
}

#[derive(Default)]
struct QcQuitState {
    dirty_windows: Mutex<HashSet<String>>,
}

#[tauri::command]
fn set_qc_dirty(window: Window, state: State<'_, QcQuitState>, dirty: bool) {
    let mut dirty_windows = state.dirty_windows.lock();
    if dirty {
        dirty_windows.insert(window.label().to_string());
    } else {
        dirty_windows.remove(window.label());
    }
}

#[tauri::command]
fn request_app_quit(app: AppHandle) {
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let cli_files = args_to_files(&std::env::args().collect::<Vec<_>>());

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            log::info!("second-instance argv: {:?}", argv);
            let files = args_to_files(&argv);
            if files.is_empty() {
                // No file args — just focus the main window.
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.set_focus();
                }
                return;
            }
            if let Err(e) = spawn_windows_for_files(app, files) {
                log::warn!("spawn_windows_for_files failed: {e}");
            }
        }))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(DbState::default())
        .manage(UpdateState::default())
        .manage(PatternState::default())
        .manage(PendingFiles::default())
        .manage(PendingOverviewContexts::default())
        .manage(MenuState::default())
        .manage(QcQuitState::default())
        .invoke_handler(tauri::generate_handler![
            load_file,
            query,
            exec,
            describe,
            tables,
            export_file,
            export_excel_multi,
            get_excel_sheets,
            free_memory,
            get_regex_patterns,
            save_user_pattern,
            delete_user_pattern,
            export_user_patterns,
            import_user_patterns,
            write_json_file,
            read_json_file,
            read_text_file,
            write_text_file,
            read_binary_file,
            write_binary_file,
            file_exists,
            file_stat,
            allow_pdf_asset,
            open_pdf_externally,
            open_new_window,
            open_overview_window,
            close_db,
            take_overview_context,
            take_pending_files,
            get_app_version,
            check_for_update,
            claim_update_notice,
            release_update_notice,
            install_update,
            restart_app,
            set_qc_dirty,
            request_app_quit,
            fetch_link_preview,
            sync_link_previews_enabled,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            let menu = menu::build_menu(&handle)?;
            app.set_menu(menu)?;
            app.on_menu_event(|app, ev| {
                menu::handle_menu_event(app, ev.id().0.as_str());
            });

            let initial = cli_files.clone();
            if cfg!(target_os = "macos") && initial.is_empty() {
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(750));
                    if handle.webview_windows().is_empty() {
                        match spawn_window(&handle, None) {
                            Ok(label) => log::info!("delayed initial window spawned: {label}"),
                            Err(e) => log::warn!("delayed initial window spawn failed: {e}"),
                        }
                    }
                });
            } else {
                let initial_labels = if initial.is_empty() {
                    vec![spawn_window(&handle, None)?]
                } else {
                    spawn_windows_for_files(&handle, initial)?
                };
                log::info!("initial window(s) spawned: {:?}", initial_labels);
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri app");

    app.run(|app_handle, event| {
        #[cfg(target_os = "macos")]
        if let RunEvent::Opened { urls } = &event {
            handle_opened_urls(app_handle, urls.clone());
        }

        if let RunEvent::ExitRequested { api, .. } = &event {
            let state: State<'_, QcQuitState> = app_handle.state();
            let dirty_window = {
                let mut dirty_windows = state.dirty_windows.lock();
                dirty_windows.retain(|label| app_handle.get_webview_window(label).is_some());
                dirty_windows
                    .iter()
                    .find(|label| {
                        app_handle
                            .get_webview_window(label)
                            .and_then(|window| window.is_focused().ok())
                            .unwrap_or(false)
                    })
                    .cloned()
                    .or_else(|| dirty_windows.iter().next().cloned())
            };

            if let Some(label) = dirty_window {
                api.prevent_exit();
                if let Some(window) = app_handle.get_webview_window(&label) {
                    let _ = window.emit("request-quit", ());
                    let _ = window.set_focus();
                }
            }
        }
    });
}

#[cfg(target_os = "macos")]
fn handle_opened_urls(app_handle: &tauri::AppHandle, urls: Vec<tauri::Url>) {
    // macOS "Open With" / drag-to-dock — each url is a file:// path.
    let paths: Vec<String> = urls
        .into_iter()
        .filter_map(|u| u.to_file_path().ok())
        .map(|p| p.to_string_lossy().to_string())
        .collect();
    let supported = filter_supported(paths);
    if supported.is_empty() {
        return;
    }
    if let Err(e) = spawn_windows_for_files(app_handle, supported) {
        log::warn!("spawn_windows_for_files from open-file failed: {e}");
    }
}
