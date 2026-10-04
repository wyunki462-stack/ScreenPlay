//! ScreenPlay desktop shell — Tauri v2 entry point.
//!
//! Responsibilities (DESIGN §5): single instance, config load, DATA_DIR pick,
//! backend orchestration kickoff, splash IPC commands and process-tree teardown.
//!
//! The main UI is served by the bundled backend at `http://127.0.0.1:<port>/`,
//! so only the splash window (`WebviewUrl::App("index.html")`) talks IPC.

// No console window in release builds; keep it in debug so `println!` shows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backend;
mod config;
mod firewall;

use std::path::PathBuf;
use std::sync::Mutex;

use tauri::{AppHandle, Manager, State};

use backend::BackendStatus;
use config::Config;

/// Shared shell state. Reached from the event loop, the orchestration thread and
/// the splash IPC commands, hence the mutexes.
pub struct AppState {
    /// What the splash page polls via `backend_status`.
    pub status: Mutex<BackendStatus>,
    /// Live node child, kept so we can `taskkill /T` its whole tree on exit.
    pub child: Mutex<Option<std::process::Child>>,
    /// Parsed `config.json` (already normalized, password generated if needed).
    pub cfg: Mutex<Config>,
    /// `%APPDATA%\ScreenPlay` or `<exeDir>\data` (portable) — DESIGN §8.
    pub data_dir: PathBuf,
    /// `<DATA_DIR>/config.json`.
    pub config_path: PathBuf,
    /// Resolved `resources/` root (DESIGN §5.1).
    pub resource_root: PathBuf,
}

// ---------------------------------------------------------------------------
// IPC commands used by the splash page
// ---------------------------------------------------------------------------

/// `{state, port, message, logPath, dataDir}` — polled by splash every 500 ms.
#[tauri::command]
fn backend_status(state: State<'_, AppState>) -> BackendStatus {
    match state.status.lock() {
        Ok(status) => status.clone(),
        Err(_) => BackendStatus {
            state: "failed".to_string(),
            port: 0,
            message: "内部状态已损坏，请重启 ScreenPlay。".to_string(),
            log_path: String::new(),
            data_dir: String::new(),
        },
    }
}

/// Kill the current node tree (if any) and run the whole startup sequence again.
#[tauri::command]
fn restart_backend(app: AppHandle) {
    backend::kill_child(&app);
    backend::set_status(&app, |s| {
        s.state = "starting".to_string();
        s.message = "正在重新启动本地服务…".to_string();
    });
    backend::start(app);
}

/// Reveal `<DATA_DIR>/logs` in Explorer.
#[tauri::command]
fn open_log_dir(state: State<'_, AppState>) -> Result<(), String> {
    let dir = state.data_dir.join("logs");
    let _ = std::fs::create_dir_all(&dir);
    backend::open_dir(&dir).map_err(|e| format!("无法打开日志目录 {}：{e}", dir.display()))
}

/// Reveal `<DATA_DIR>` in Explorer.
#[tauri::command]
fn open_data_dir(state: State<'_, AppState>) -> Result<(), String> {
    let dir = state.data_dir.clone();
    let _ = std::fs::create_dir_all(&dir);
    backend::open_dir(&dir).map_err(|e| format!("无法打开数据目录 {}：{e}", dir.display()))
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

/// Where the exe lives — the anchor for `resources/` and portable mode.
fn exe_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
}

/// Build the shared state before the orchestration thread starts.
fn build_state(app: &AppHandle) -> AppState {
    let exe_dir = exe_dir();
    let (data_dir, portable) = config::resolve_data_dir(&exe_dir, app.path().app_data_dir().ok());
    if let Err(e) = std::fs::create_dir_all(&data_dir) {
        eprintln!("[shell] 无法创建数据目录 {}：{}", data_dir.display(), e);
    }

    let mut cfg = config::load_or_init(&data_dir);
    // 1.3.2 默认（`allowSetup: true`）：不生成随机密码，第一次打开网页时自己创建账户。
    if cfg.allow_setup_env() {
        eprintln!("[shell] 本地登录：首次在网页上创建账户（config.json 的 allowSetup=true）");
    } else if config::ensure_admin_password(&data_dir, &mut cfg).is_some() {
        // 仅当用户在 config.json 里显式关掉 allowSetup 时才生成随机密码。
        eprintln!(
            "[shell] 已启用本地登录，备用管理员密码见 {}/{}",
            data_dir.display(),
            config::PASSWORD_FILE
        );
    }

    let resource_root = backend::resource_root(&exe_dir);
    let log_path = data_dir.join("logs").join(config::log_file_name());

    eprintln!(
        "[shell] data_dir={} (portable={portable}) host={} auth={} firewall={} resources={}",
        data_dir.display(),
        cfg.host,
        cfg.auth,
        cfg.firewall,
        resource_root.display()
    );

    AppState {
        status: Mutex::new(BackendStatus::starting(
            cfg.port,
            &log_path,
            &data_dir,
        )),
        child: Mutex::new(None),
        config_path: config::config_path(&data_dir),
        cfg: Mutex::new(cfg),
        data_dir,
        resource_root,
    }
}

fn main() {
    let builder = tauri::Builder::default()
        // DESIGN §5.8: official plugin, named mutex on Windows.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window(backend::SPLASH_LABEL) {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .invoke_handler(tauri::generate_handler![
            backend_status,
            restart_backend,
            open_log_dir,
            open_data_dir
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let state = build_state(&handle);
            app.manage(state);
            // Never block setup(): the webview must paint the splash first.
            backend::start(handle);
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                // DESIGN §5.7: reap the node tree *before* the process goes away.
                let handle = window.app_handle().clone();
                backend::shutdown(&handle);
            }
        });

    let app = builder
        .build(tauri::generate_context!())
        .expect("failed to build ScreenPlay shell");

    app.run(|app, event| match event {
        // Covers Ctrl+C, tray quit and "last window closed".
        tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
            backend::shutdown(&app.clone());
        }
        _ => {}
    });
}