//! Backend orchestration: resource discovery, port selection, `node.exe` spawn,
//! health polling, log wiring and process-tree teardown.
//!
//! Contract: `windows/DESIGN.md` §5 (startup) and §2 (architecture).
//!
//! Deliberately dependency-free on the network side: the health probe is a
//! hand-written `GET /api/health HTTP/1.0` over `std::net::TcpStream`, and the
//! child process is plain `std::process::Command`. Keeping `reqwest`/`hyper`/
//! `tokio`/`openssl` out of the tree is what makes a Linux → `x86_64-pc-windows-msvc`
//! cross build feasible at all.

use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::config::{self, Config};
use crate::AppState;

/// Window label declared in `tauri.conf.json` (`app.windows[0].label`).
pub const SPLASH_LABEL: &str = "splash";

/// First port tried when `config.port == 0` (DESIGN §5.3).
pub const FIRST_PORT: u16 = 3210;
/// How far the auto-probe walks upwards before giving up.
pub const PORT_PROBE_RANGE: u16 = 100;

/// Health polling cadence and ceiling (DESIGN §5.6).
pub const HEALTH_POLL_MS: u64 = 250;
pub const HEALTH_TIMEOUT_SECS: u64 = 90;

/// Post-startup main-window geometry.
///
/// The Web bundle is **mobile-first** (Tailwind `min-width` breakpoints at
/// 480 / 640 / 768 / 1024 / 1280 / 1536). If the window can be dragged narrower
/// than 1024 px it drops into the narrow-screen layout, which is exactly the
/// mobile adaptation DESIGN §1 tells us to drop — so the floor is 1024, not 0.
pub const MAIN_MIN_WIDTH: f64 = 1024.0;
pub const MAIN_MIN_HEIGHT: f64 = 700.0;
pub const MAIN_WIDTH: f64 = 1280.0;
pub const MAIN_HEIGHT: f64 = 860.0;

/// `CREATE_NO_WINDOW` — stops the console window from flashing for node.exe.
#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Snapshot handed to the splash page by the `backend_status` command.
///
/// `rename_all = "camelCase"` is load-bearing: `splash/index.html` reads
/// `status.logPath` / `status.dataDir`, so the wire shape is
/// `{state, port, message, logPath, dataDir}` exactly as DESIGN §5 specifies.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendStatus {
    /// `starting` | `ready` | `failed`.
    pub state: String,
    pub port: u16,
    pub message: String,
    pub log_path: String,
    pub data_dir: String,
}

impl BackendStatus {
    pub fn starting(port: u16, log_path: &Path, data_dir: &Path) -> Self {
        Self {
            state: "starting".to_string(),
            port,
            message: "正在启动本地服务…".to_string(),
            log_path: log_path.display().to_string(),
            data_dir: data_dir.display().to_string(),
        }
    }

    pub fn failed(message: impl Into<String>, log_path: &Path, data_dir: &Path) -> Self {
        Self {
            state: "failed".to_string(),
            port: 0,
            message: message.into(),
            log_path: log_path.display().to_string(),
            data_dir: data_dir.display().to_string(),
        }
    }
}

// ---------------------------------------------------------------------------
// Resource discovery
// ---------------------------------------------------------------------------

/// Locate the bundled `resources/` root (DESIGN §5.1).
///
/// Development builds look next to `Cargo.toml` first so `cargo tauri dev` works
/// without an install; release builds use the directory that holds the exe,
/// which is where `bundle.resources` maps `resources/` to.
pub fn resource_root(exe_dir: &Path) -> PathBuf {
    #[cfg(debug_assertions)]
    {
        let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources");
        if dev.is_dir() {
            return dev;
        }
    }
    exe_dir.join("resources")
}

/// Read `resources/build-info.json` for `BUILD_VERSION` / `BUILD_TIME`.
fn read_build_info(root: &Path) -> (String, String) {
    let path = root.join("build-info.json");
    if let Ok(text) = fs::read_to_string(&path) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
            let version = v
                .get("version")
                .and_then(|x| x.as_str())
                .unwrap_or("unknown")
                .to_string();
            let built_at = v
                .get("builtAt")
                .and_then(|x| x.as_str())
                .unwrap_or("unknown")
                .to_string();
            return (version, built_at);
        }
    }
    ("unknown".to_string(), "unknown".to_string())
}

// ---------------------------------------------------------------------------
// Port selection
// ---------------------------------------------------------------------------

/// `config.port` when set, otherwise the first bindable `<host>:<port>` from 3210.
///
/// 1.3.2 起 `host` 默认是 `0.0.0.0`：探测必须绑**同一个地址**，否则会出现
/// 「127.0.0.1:3210 空闲」但后端绑 0.0.0.0:3210 却失败的假象（别的进程可能正好占着
/// 3210 的某个具体网卡地址）。
pub fn pick_port(host: &str, preferred: u16) -> u16 {
    if preferred > 0 {
        return preferred;
    }
    for offset in 0..PORT_PROBE_RANGE {
        let port = FIRST_PORT.saturating_add(offset);
        if TcpListener::bind((host, port)).is_ok() {
            return port;
        }
    }
    FIRST_PORT
}

// ---------------------------------------------------------------------------
// Health probe (no HTTP client crate)
// ---------------------------------------------------------------------------

/// Minimal `GET /api/health` — returns `(status_code, raw_response)`.
///
/// `HTTP/1.0` + `Connection: close` makes the server terminate the connection,
/// so a plain `read_to_end` terminates too and we never need chunked decoding.
fn http_get_health(port: u16) -> Option<(u16, String)> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(600)).ok()?;
    let _ = stream.set_read_timeout(Some(Duration::from_millis(2_000)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(2_000)));

    let request = format!(
        "GET /api/health HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nAccept: application/json\r\nUser-Agent: ScreenPlay-Desktop\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(request.as_bytes()).ok()?;

    let mut buf = Vec::with_capacity(4_096);
    let _ = stream.read_to_end(&mut buf);
    let text = String::from_utf8_lossy(&buf).into_owned();

    let code = text
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|c| c.parse::<u16>().ok())
        .unwrap_or(0);

    Some((code, text))
}

/// Is the backend up and healthy?
///
/// `/api/health` is served by `backend/src/app.controller.ts:73-92` and returns
/// exactly `{"status":"ok","uptime":…,"version":…,"buildTime":…,"features":[…]}`.
/// There is **no** `ok` field, so the readiness test is HTTP 200 **plus** a
/// `"status":"ok"` in the body — not a literal `"ok":true`.
///
/// The whitespace variants are accepted because the body is inspected as raw
/// text (no JSON parser in the hot path); `{"status": "ok"}` is equally valid
/// JSON and we must not report a healthy backend as dead over a space.
///
/// `/api/health` is a public path (`backend/src/auth/auth.guard.ts:14`), so this
/// probe succeeds even when `auth` is `local` or `system`.
fn health_ok(port: u16) -> bool {
    match http_get_health(port) {
        Some((200, body)) => {
            let compact = body.chars().filter(|c| !c.is_whitespace()).collect::<String>();
            compact.contains("\"status\":\"ok\"")
        }
        _ => false,
    }
}

// ---------------------------------------------------------------------------
// Platform shims (kept tiny so `cargo check` also passes on Linux)
// ---------------------------------------------------------------------------

/// Suppress the console window for a spawned process (Windows only).
fn apply_no_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        // 待 Windows 端验证：CommandExt::creation_flags(CREATE_NO_WINDOW)
        // （Linux 主机上本分支不参与编译）。
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
}

/// Reap the whole node process tree (DESIGN §5.7).
fn kill_tree(pid: u32) {
    // Bind the pid as a `&str` first: `["/PID", &pid.to_string(), ..]` would mix
    // `&str` and `&String` in one array, which does not type-check.
    let pid_arg = pid.to_string();
    #[cfg(windows)]
    {
        // 待 Windows 端验证：真实 `taskkill` 是否存在、`/T /F` 是否确实回收
        // node + ffmpeg 子进程树。
        let mut cmd = Command::new("taskkill");
        cmd.args(["/PID", pid_arg.as_str(), "/T", "/F"]);
        apply_no_window(&mut cmd);
        let _ = cmd.stdout(Stdio::null()).stderr(Stdio::null()).status();
    }
    #[cfg(not(windows))]
    {
        let _ = Command::new("kill")
            .args(["-9", pid_arg.as_str()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

/// Open a directory in the OS file manager without pulling in `tauri-plugin-opener`.
pub fn open_dir(path: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        Command::new("explorer").arg(path).spawn().map(|_| ())
    }
    #[cfg(not(windows))]
    {
        let launcher = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
        Command::new(launcher).arg(path).spawn().map(|_| ())
    }
}

// ---------------------------------------------------------------------------
// Status plumbing
// ---------------------------------------------------------------------------

/// Mutate the shared status that the splash page polls.
pub fn set_status(app: &AppHandle, f: impl FnOnce(&mut BackendStatus)) {
    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(mut guard) = state.status.lock() {
            f(&mut guard);
        }
    }
}

fn fail(app: &AppHandle, message: impl Into<String>) {
    let message = message.into();
    eprintln!("[backend] 启动失败：{}", message);
    let (log_path, data_dir) = log_targets(app);
    set_status(app, |s| {
        let new = BackendStatus {
            state: "failed".to_string(),
            port: s.port,
            message: message.clone(),
            log_path: log_path.display().to_string(),
            data_dir: data_dir.display().to_string(),
        };
        *s = new;
    });
}

fn log_targets(app: &AppHandle) -> (PathBuf, PathBuf) {
    match app.try_state::<AppState>() {
        Some(state) => (
            state.data_dir.join("logs").join(config::log_file_name()),
            state.data_dir.clone(),
        ),
        None => (PathBuf::from(""), PathBuf::from("")),
    }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/// Spawn the orchestration thread. Never blocks the Tauri event loop.
pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        if let Err(message) = run(&app) {
            fail(&app, message);
        }
    });
}

/// Kill the node tree and forget the handle. Safe to call repeatedly.
pub fn kill_child(app: &AppHandle) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let child = state.child.lock().ok().and_then(|mut guard| guard.take());
    if let Some(mut child) = child {
        let pid = child.id();
        // taskkill /T is what actually reaps grandchildren (ffmpeg, sharp workers).
        kill_tree(pid);
        let _ = child.kill();
        let _ = child.wait();
        eprintln!("[backend] 已回收 node 进程树 pid={pid}");
    }
}

/// Called on window close / app exit (DESIGN §5.7).
pub fn shutdown(app: &AppHandle) {
    kill_child(app);
}

fn run(app: &AppHandle) -> Result<(), String> {
    let state = app
        .try_state::<AppState>()
        .ok_or_else(|| "内部状态未初始化".to_string())?;

    let root = state.resource_root.clone();
    let data_dir = state.data_dir.clone();
    let cfg = state
        .cfg
        .lock()
        .map(|c| c.clone())
        .map_err(|_| "配置锁被污染，无法读取启动配置".to_string())?;
    drop(state);

    // --- §5.1 resource root -------------------------------------------------
    if !root.is_dir() {
        return Err(format!(
            "找不到内置资源目录：{}\n安装包似乎不完整，请重新安装 ScreenPlay。",
            root.display()
        ));
    }

    let log_dir = data_dir.join("logs");
    let log_path = log_dir.join(config::log_file_name());

    // --- §5.2 external mode short-circuits everything -----------------------
    if cfg.mode == "external" {
        let base = cfg.base_url.trim().to_string();
        if base.is_empty() {
            return Err("config.json 中 mode 为 external，但 baseUrl 为空。".to_string());
        }
        let port = port_from_url(&base).unwrap_or(0);
        set_status(app, |s| {
            s.state = "ready".to_string();
            s.port = port;
            s.message = format!("正在连接外部服务 {base}");
        });
        navigate_to_main(app, &base);
        return Ok(());
    }

    // --- §5.4/§5.5 node executable + entrypoint ----------------------------
    let node_exe = root.join("node").join("node.exe");
    let main_js = root.join("backend").join("dist").join("main.js");
    if !node_exe.is_file() {
        return Err(format!(
            "缺少内置 Node 运行时：{}\n请重新运行 windows/scripts/prepare-backend.mjs 并重新打包。",
            node_exe.display()
        ));
    }
    if !main_js.is_file() {
        return Err(format!(
            "缺少后端入口文件：{}\n请重新运行 windows/scripts/prepare-backend.mjs 并重新打包。",
            main_js.display()
        ));
    }

    // --- §5.3 port ---------------------------------------------------------
    let port = pick_port(&cfg.host, cfg.port);

    // --- §5.4 log wiring ---------------------------------------------------
    if let Err(e) = fs::create_dir_all(&log_dir) {
        return Err(format!("无法创建日志目录 {}：{e}", log_dir.display()));
    }
    let log_file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| format!("无法打开日志文件 {}：{e}", log_path.display()))?;
    let log_err = log_file
        .try_clone()
        .map_err(|e| format!("无法复制日志句柄：{e}"))?;

    config::append_line(
        &log_path,
        &format!(
            "\n===== {} ScreenPlay 桌面壳启动（host={}, port={port}, data={}）=====",
            config::now_human(),
            cfg.host,
            data_dir.display()
        ),
    );

    // 「局域网地址」：给日志和人看的一行，方便手机/平板直接填地址。
    let lan_ip = if cfg.lan_reachable() { lan_ipv4() } else { None };
    if let Some(ip) = lan_ip {
        config::append_line(&log_path, &format!("[backend] 局域网访问地址：http://{ip}:{port}/"));
    }

    set_status(app, |s| {
        s.state = "starting".to_string();
        s.port = port;
        s.message = match lan_ip {
            Some(ip) => format!("正在启动本地服务（{ip}:{port}，局域网可访问）…"),
            None => format!("正在启动本地服务（端口 {port}）…"),
        };
        s.log_path = log_path.display().to_string();
    });

    // Make sure the default media dir exists: DESIGN §8 promises it is non-empty
    // and writable so the settings page has something to manage on first run.
    let default_media = data_dir.join("media");
    let _ = fs::create_dir_all(&default_media);

    let (build_version, build_time) = read_build_info(&root);

    // --- 「默认放行」：先让防火墙有规则，再让 node 开始监听 ------------------
    //
    // 顺序是刻意的：Windows 只有在「程序正在监听非回环地址且没有匹配的放行规则」时
    // 才会弹它自己的「允许访问」对话框。规则先落地，用户就完全看不到那个弹窗。
    // 这一步失败也不阻断启动，只写日志。
    let fw = crate::firewall::ensure_allowed(
        &cfg,
        &data_dir,
        cfg.port,
        FIRST_PORT,
        PORT_PROBE_RANGE,
    );
    config::append_line(&log_path, &format!("[firewall] {}", fw.describe()));

    // --- §5.4/§5.5 spawn ---------------------------------------------------
    let mut cmd = Command::new(&node_exe);
    cmd.arg(&main_js);
    cmd.current_dir(root.join("backend"));
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::from(log_file));
    cmd.stderr(Stdio::from(log_err));
    apply_no_window(&mut cmd);

    let bin_dir = root.join("bin");
    cmd.env("PORT", port.to_string());
    // 1.3.2 起默认 `0.0.0.0`（局域网可达）；后端 `backend/src/main.ts:102` 也认这个键。
    cmd.env("HOST", &cfg.host);
    cmd.env("DATA_DIR", &data_dir);
    cmd.env("MEDIA_DIRS", media_dirs_env(&cfg, &data_dir));
    cmd.env("WEB_DIST", root.join("web"));
    cmd.env("NODE_ENV", "production");
    cmd.env("FFMPEG_PATH", bin_dir.join("ffmpeg.exe"));
    cmd.env("FFPROBE_PATH", bin_dir.join("ffprobe.exe"));
    cmd.env(
        "PATH",
        format!("{};{}", bin_dir.display(), inherited_path()),
    );
    cmd.env("MAINTENANCE_ON_BOOT", "0");
    cmd.env("BUILD_VERSION", build_version);
    cmd.env("BUILD_TIME", build_time);

    match cfg.auth.as_str() {
        // 默认路径：`AUTH_ALLOW_SETUP=1` ⇒ 首次打开网页自己创建账户（不生成随机密码）。
        // 密码在 `config::ensure_admin_password()` 里生成 + 持久化（仅 allowSetup=false）。
        "local" => {
            cmd.env("AUTH_MODE", "local");
            if cfg.allow_setup_env() {
                cmd.env("AUTH_ALLOW_SETUP", "1");
            } else if !cfg.admin_password.is_empty() {
                cmd.env("AUTH_ADMIN_PASSWORD", &cfg.admin_password);
            }
        }
        "system" => {
            cmd.env("AUTH_MODE", "system");
        }
        _ => {
            cmd.env("AUTH_DISABLED", "1");
        }
    }

    let child = cmd.spawn().map_err(|e| {
        format!(
            "启动后端进程失败：{e}\n命令：{} {}（工作目录 {}）",
            node_exe.display(),
            main_js.display(),
            root.join("backend").display()
        )
    })?;

    let pid = child.id();
    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(mut guard) = state.child.lock() {
            *guard = Some(child);
        }
    }
    config::append_line(&log_path, &format!("[backend] 已启动 node (pid={pid})"));

    // --- §5.6 health poll --------------------------------------------------
    let deadline = Instant::now() + Duration::from_secs(HEALTH_TIMEOUT_SECS);
    loop {
        if health_ok(port) {
            break;
        }

        if let Some(code) = child_exited(app) {
            let tail = tail_of_log(&log_path, 20);
            return Err(format!(
                "后端进程在启动过程中退出（退出码 {}）。\n最近日志（{}）：\n{}",
                code.map(|c| c.to_string()).unwrap_or_else(|| "unknown".to_string()),
                log_path.display(),
                tail
            ));
        }

        if Instant::now() >= deadline {
            let tail = tail_of_log(&log_path, 20);
            kill_child(app); // don't leave a half-started backend behind
            return Err(format!(
                "本地服务在 {HEALTH_TIMEOUT_SECS} 秒内未通过健康检查（http://127.0.0.1:{port}/api/health）。\n最近日志（{}）：\n{}",
                log_path.display(),
                tail
            ));
        }

        std::thread::sleep(Duration::from_millis(HEALTH_POLL_MS));
    }

    config::append_line(&log_path, "[backend] 健康检查通过，正在打开主界面");
    let url = format!("http://127.0.0.1:{port}/");
    // 本机窗口与健康检查始终走回环地址（host 绑 0.0.0.0 时 127.0.0.1 一样可达）；
    // 后面这段只是把「手机/平板该填哪个地址」告诉用户。
    let lan_hint = match lan_ip {
        Some(ip) => format!("；局域网地址 http://{ip}:{port}/"),
        None => String::new(),
    };
    set_status(app, |s| {
        s.state = "ready".to_string();
        s.port = port;
        s.message = format!("已就绪，正在打开 {url}{lan_hint}");
    });
    navigate_to_main(app, &url);
    Ok(())
}

/// `Some(exit_code)` when the child has already terminated.
fn child_exited(app: &AppHandle) -> Option<Option<i32>> {
    let state = app.try_state::<AppState>()?;
    let mut guard = state.child.lock().ok()?;
    let child = guard.as_mut()?;
    match child.try_wait() {
        Ok(Some(status)) => {
            *guard = None;
            Some(status.code())
        }
        Ok(None) => None,
        Err(_) => None,
    }
}

/// Navigate the splash window to the live UI and grow it into the real shell.
///
/// Verified against the real crate sources (tauri 2.12.0,
/// `src/webview/webview_window.rs`): both `eval(&self, js: impl Into<String>)`
/// and `navigate(&self, url: Url)` exist. `navigate` would need a parsed
/// `url::Url` first, where `eval` takes the string we already have — so we keep
/// `eval`, whose single `location.replace` is an ordinary top-level navigation
/// (allowed because `app.security.csp` is null and IPC is not involved).
fn navigate_to_main(app: &AppHandle, url: &str) {
    let Some(window) = app.get_webview_window(SPLASH_LABEL) else {
        eprintln!("[backend] 找不到 {SPLASH_LABEL} 窗口，无法打开主界面");
        return;
    };

    // The splash window is fixed at ~520x340 and not resizable; the main UI needs
    // a desktop window, so lift every constraint we set for the splash.
    // NB: `set_min_size`/`set_max_size` take `Option<S>`, `set_size` takes `S`.
    let _ = window.set_resizable(true);
    let _ = window.set_maximizable(true);
    let _ = window.set_minimizable(true);
    let _ = window.set_min_size(Some(tauri::LogicalSize::new(MAIN_MIN_WIDTH, MAIN_MIN_HEIGHT)));
    let _ = window.set_size(tauri::LogicalSize::new(MAIN_WIDTH, MAIN_HEIGHT));
    let _ = window.center();
    let _ = window.set_title("ScreenPlay");

    let literal = serde_json::to_string(url)
        .unwrap_or_else(|_| "\"http://127.0.0.1/\"".to_string());
    let js = format!("window.location.replace({literal});");
    if let Err(e) = window.eval(&js) {
        eprintln!("[backend] 导航到 {url} 失败：{e}");
    }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/// 本机在局域网里的 IPv4 地址（拿不到就 `None`）。
///
/// 手法：把一个 UDP socket `connect` 到外网地址 —— 不发任何数据包，`connect` 只做一次
/// 路由查找，于是 `local_addr()` 就给出「系统认为去局域网该走的那块网卡」的地址。
/// 这样不必引入 `getifaddrs`/`netdev` 之类依赖，完全离线也有效。
fn lan_ipv4() -> Option<std::net::Ipv4Addr> {
    let sock = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect("8.8.8.8:80").ok()?;
    match sock.local_addr().ok()? {
        SocketAddr::V4(addr) => Some(*addr.ip()),
        _ => None,
    }
}

/// `<DATA_DIR>\media` first, then any user-configured extras, `;`-joined.
fn media_dirs_env(cfg: &Config, data_dir: &Path) -> String {
    let default = data_dir.join("media").to_string_lossy().into_owned();
    let mut out: Vec<String> = vec![default];
    for dir in &cfg.media_dirs {
        let dir = dir.trim();
        if dir.is_empty() {
            continue;
        }
        if !out.iter().any(|existing| existing.eq_ignore_ascii_case(dir)) {
            out.push(dir.to_string());
        }
    }
    out.join(";")
}

/// The inherited `PATH`, honouring Windows' case-insensitive variable names.
fn inherited_path() -> String {
    for (key, value) in std::env::vars() {
        if key.eq_ignore_ascii_case("PATH") {
            return value;
        }
    }
    String::new()
}

fn port_from_url(url: &str) -> Option<u16> {
    let rest = url.split("://").nth(1).unwrap_or(url);
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let port = authority.rsplit(':').next()?;
    if port == authority {
        return None; // no ':' at all
    }
    port.parse::<u16>().ok()
}

fn tail_of_log(path: &Path, lines: usize) -> String {
    match fs::read_to_string(path) {
        Ok(text) => {
            let all: Vec<&str> = text.lines().collect();
            let start = all.len().saturating_sub(lines);
            if start == all.len() {
                return "(日志为空)".to_string();
            }
            all[start..].join("\n")
        }
        Err(_) => "(无法读取日志)".to_string(),
    }
}