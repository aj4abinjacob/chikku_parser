use crate::db::DbState;
use crate::error::{AppError, AppResult};
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
#[cfg(target_os = "macos")]
use tauri::TitleBarStyle;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

const SUPPORTED_EXTS: &[&str] = &[
    "csv", "tsv", "json", "jsonl", "ndjson", "md", "markdown", "pdf", "parquet", "xlsx", "xls",
];

pub fn is_supported(path: &str) -> bool {
    let ext = Path::new(path)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    SUPPORTED_EXTS.contains(&ext.as_str())
}

pub fn filter_supported<I, S>(paths: I) -> Vec<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    paths
        .into_iter()
        .filter(|p| is_supported(p.as_ref()))
        .map(|p| p.as_ref().to_string())
        .collect()
}

/// Per-window queue of files to open. Renderer drains via take_pending_files.
#[derive(Default)]
pub struct PendingFiles {
    by_window: Mutex<HashMap<String, Vec<String>>>,
}

impl PendingFiles {
    pub fn push(&self, label: &str, files: Vec<String>) {
        if files.is_empty() {
            return;
        }
        let mut map = self.by_window.lock();
        map.entry(label.to_string()).or_default().extend(files);
    }

    pub fn take(&self, label: &str) -> Vec<String> {
        let mut map = self.by_window.lock();
        map.remove(label).unwrap_or_default()
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverviewWindowContext {
    pub table_name: String,
    pub display_name: String,
}

#[derive(Default)]
pub struct PendingOverviewContexts {
    by_window: Mutex<HashMap<String, OverviewWindowContext>>,
}

impl PendingOverviewContexts {
    fn insert(&self, label: &str, context: OverviewWindowContext) {
        self.by_window.lock().insert(label.to_string(), context);
    }

    fn take(&self, label: &str) -> Option<OverviewWindowContext> {
        self.by_window.lock().remove(label)
    }
}

static WINDOW_COUNTER: AtomicU64 = AtomicU64::new(1);
static OVERVIEW_WINDOW_COUNTER: AtomicU64 = AtomicU64::new(1);

fn label_for(n: u64) -> String {
    if n == 1 {
        "main".to_string()
    } else {
        format!("win-{}", n)
    }
}

/// Create a new window. If `files` is non-empty, queue them for that window so the
/// renderer can pick them up via `take_pending_files` on mount.
pub fn spawn_window(app: &AppHandle, files: Option<Vec<String>>) -> AppResult<String> {
    let window_id = WINDOW_COUNTER.fetch_add(1, Ordering::SeqCst);
    let label = label_for(window_id);
    let cascade_offset = ((window_id - 1) % 8) as f64 * 36.0;
    let url = WebviewUrl::App("index.html".into());
    let mut builder = WebviewWindowBuilder::new(app, &label, url)
        .title("Chikku Parser")
        .inner_size(1400.0, 900.0)
        .min_inner_size(800.0, 600.0)
        .position(80.0 + cascade_offset, 80.0 + cascade_offset)
        .resizable(true)
        .devtools(false);

    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title_bar_style(TitleBarStyle::Overlay)
            .hidden_title(true);
    }

    let window = builder
        .build()
        .map_err(|e| AppError::msg(format!("window build: {e}")))?;

    if let Some(files) = files {
        let supported = filter_supported(files);
        if !supported.is_empty() {
            let state: tauri::State<'_, PendingFiles> = app.state();
            state.push(&label, supported);
        }
    }

    // Wire window-close to free DB session
    let app_handle = app.clone();
    let lbl = label.clone();
    window.on_window_event(move |ev| {
        if let tauri::WindowEvent::Destroyed = ev {
            let dbs: tauri::State<'_, DbState> = app_handle.state();
            dbs.close_for(&lbl);
            app_handle.state::<crate::table_search::TableSearchState>().close_for(&lbl);
        }
    });

    Ok(label)
}

fn spawn_overview_window(
    app: &AppHandle,
    source_label: &str,
    db_state: &DbState,
    contexts: &PendingOverviewContexts,
    context: OverviewWindowContext,
) -> AppResult<String> {
    let window_id = OVERVIEW_WINDOW_COUNTER.fetch_add(1, Ordering::SeqCst);
    let label = format!("overview-{window_id}");
    let title = format!("Data Overview - {}", context.display_name);

    db_state.share_for(source_label, &label)?;
    contexts.insert(&label, context);

    let builder = WebviewWindowBuilder::new(
        app,
        &label,
        WebviewUrl::App("index.html?view=overview".into()),
    )
    .title(title)
    .inner_size(1420.0, 940.0)
    .min_inner_size(960.0, 680.0)
    .resizable(true)
    .devtools(false);

    let window = match builder.build() {
        Ok(window) => window,
        Err(err) => {
            db_state.close_for(&label);
            contexts.take(&label);
            return Err(AppError::msg(format!("overview window build: {err}")));
        }
    };

    let app_handle = app.clone();
    let closed_label = label.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::Destroyed = event {
            let dbs: tauri::State<'_, DbState> = app_handle.state();
            dbs.close_for(&closed_label);
            app_handle.state::<crate::table_search::TableSearchState>().close_for(&closed_label);
            let pending: tauri::State<'_, PendingOverviewContexts> = app_handle.state();
            pending.take(&closed_label);
        }
    });

    let _ = window.set_focus();
    Ok(label)
}

/// Open externally requested files as independent app sessions.
pub fn spawn_windows_for_files(app: &AppHandle, files: Vec<String>) -> AppResult<Vec<String>> {
    let supported = filter_supported(files);
    if supported.is_empty() {
        return Ok(Vec::new());
    }

    let mut labels = Vec::with_capacity(supported.len());
    for file in supported {
        labels.push(spawn_window(app, Some(vec![file]))?);
    }

    if let Some(label) = labels.last() {
        if let Some(window) = app.get_webview_window(label) {
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
    }

    Ok(labels)
}

#[tauri::command]
pub fn take_pending_files(
    window: tauri::Window,
    state: tauri::State<'_, PendingFiles>,
) -> AppResult<Vec<String>> {
    Ok(state.take(window.label()))
}

#[tauri::command]
pub fn open_overview_window(
    window: tauri::Window,
    app: AppHandle,
    db_state: tauri::State<'_, DbState>,
    contexts: tauri::State<'_, PendingOverviewContexts>,
    table_name: String,
    display_name: String,
) -> AppResult<String> {
    spawn_overview_window(
        &app,
        window.label(),
        db_state.inner(),
        contexts.inner(),
        OverviewWindowContext {
            table_name,
            display_name,
        },
    )
}

#[tauri::command]
pub fn take_overview_context(
    window: tauri::Window,
    contexts: tauri::State<'_, PendingOverviewContexts>,
) -> AppResult<Option<OverviewWindowContext>> {
    Ok(contexts.take(window.label()))
}
