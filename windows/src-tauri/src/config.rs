//! `config.json` read/write, DATA_DIR selection and the "local" auth password.
//!
//! Contract: `windows/DESIGN.md` §7 (config) and §8 (data directory).
//!
//! Everything here is pure `std` — no `dirs`, `chrono` or `rand` crates — so the
//! crate stays small and `cargo check` works on a Linux host as well as on the
//! Windows target.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// Folder name used under `%APPDATA%` (and in the portable `data\` dir).
pub const APP_DIR_NAME: &str = "ScreenPlay";
/// File that switches a portable build to `<exeDir>\data`.
pub const PORTABLE_FLAG: &str = "portable.flag";
/// Name of the file the generated local password is written to (DESIGN §5/§7).
pub const PASSWORD_FILE: &str = "初始密码.txt";

/// The shell configuration, mirroring `DESIGN.md` §7 one-to-one.
///
/// `#[serde(default)]` means a `config.json` written by an older build (or one
/// missing a newly added key) still loads instead of being treated as corrupt.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Config {
    /// `embedded` (bundled backend) | `external` (talk to an existing server).
    pub mode: String,
    /// Preferred port; `0` = auto-probe from 3210 upwards.
    pub port: u16,
    /// Used when `mode == "external"`.
    pub base_url: String,
    /// `off` (default) | `local` | `system`.
    pub auth: String,
    /// Extra media directories; `<DATA_DIR>/media` is always prepended.
    pub media_dirs: Vec<String>,
    /// Reserved for a future tray mode; kept so the file matches DESIGN §7.
    pub close_to_tray: bool,
    /// Generated once when `auth == "local"`. Omitted from the file while empty.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub admin_password: String,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            mode: "embedded".to_string(),
            port: 0,
            base_url: String::new(),
            auth: "off".to_string(),
            media_dirs: Vec::new(),
            close_to_tray: false,
            admin_password: String::new(),
        }
    }
}

impl Config {
    /// Coerce hand-edited values back into the documented enumeration so a typo
    /// in `config.json` cannot put the shell into a state it never handles.
    pub fn normalize(&mut self) {
        let mode = self.mode.trim().to_ascii_lowercase();
        self.mode = if mode == "external" { "external" } else { "embedded" }.to_string();

        let auth = self.auth.trim().to_ascii_lowercase();
        self.auth = match auth.as_str() {
            "local" => "local",
            "system" => "system",
            _ => "off",
        }
        .to_string();

        self.base_url = self.base_url.trim().to_string();
    }
}

/// `<DATA_DIR>/config.json`.
pub fn config_path(data_dir: &Path) -> PathBuf {
    data_dir.join("config.json")
}

/// Read `<DATA_DIR>/config.json`, creating it on first run.
///
/// A file that exists but cannot be parsed is *not* silently ignored: it is
/// backed up to `config.json.bak` first (DESIGN §7), because the user may have
/// hand-edited it and we must not destroy their edit.
pub fn load_or_init(data_dir: &Path) -> Config {
    let path = config_path(data_dir);

    if !path.exists() {
        let cfg = Config::default();
        if let Err(e) = fs::create_dir_all(data_dir) {
            eprintln!("[config] 无法创建数据目录 {}：{}", data_dir.display(), e);
        }
        save(data_dir, &cfg);
        return cfg;
    }

    match fs::read_to_string(&path) {
        Ok(text) => match serde_json::from_str::<Config>(&text) {
            Ok(mut cfg) => {
                cfg.normalize();
                cfg
            }
            Err(e) => {
                eprintln!("[config] config.json 解析失败（{}），已回退默认值", e);
                backup_corrupt(&path);
                let cfg = Config::default();
                save(data_dir, &cfg);
                cfg
            }
        },
        Err(e) => {
            eprintln!("[config] config.json 无法读取（{}），已回退默认值", e);
            backup_corrupt(&path);
            let cfg = Config::default();
            save(data_dir, &cfg);
            cfg
        }
    }
}

/// Write the config back, pretty-printed like DESIGN §7 shows it.
pub fn save(data_dir: &Path, cfg: &Config) {
    let _ = fs::create_dir_all(data_dir);
    let path = config_path(data_dir);
    match serde_json::to_string_pretty(cfg) {
        Ok(text) => {
            if let Err(e) = fs::write(&path, text) {
                eprintln!("[config] 写入 {} 失败：{}", path.display(), e);
            }
        }
        Err(e) => eprintln!("[config] 序列化配置失败：{}", e),
    }
}

/// Copy a corrupt config aside as `config.json.bak` before overwriting it.
fn backup_corrupt(path: &Path) {
    let bak = path.with_file_name("config.json.bak");
    if let Err(e) = fs::copy(path, &bak) {
        eprintln!("[config] 备份损坏配置到 {} 失败：{}", bak.display(), e);
    }
}

/// Where user data lives — `DESIGN.md` §8.
///
/// Portable mode wins: if `<exeDir>\portable.flag` exists *or* `<exeDir>\data`
/// already is a directory, everything goes to `<exeDir>\data` so the whole app
/// stays self-contained next to the exe.
///
/// Returns the directory plus whether portable mode was detected.
pub fn resolve_data_dir(exe_dir: &Path, app_data_dir: Option<PathBuf>) -> (PathBuf, bool) {
    let portable_data = exe_dir.join("data");
    if exe_dir.join(PORTABLE_FLAG).exists() || portable_data.is_dir() {
        return (portable_data, true);
    }

    if let Some(dir) = app_data_dir {
        // Tauri gives `%APPDATA%\com.screenplay.desktop`; DESIGN §8 pins the
        // folder to `%APPDATA%\ScreenPlay`, so re-anchor on the parent.
        return (reanchor_appdata(dir, exe_dir), false);
    }

    // No Tauri resolver (tests / non-Tauri invocation): fall back to the env.
    if let Some(appdata) = std::env::var_os("APPDATA") {
        return (PathBuf::from(appdata).join(APP_DIR_NAME), false);
    }
    if let Some(home) = std::env::var_os("HOME") {
        return (PathBuf::from(home).join(".local/share").join(APP_DIR_NAME), false);
    }
    (exe_dir.join("data"), false)
}

/// Tauri's `app_data_dir()` is `<roaming>/<identifier>`. DESIGN §8 wants
/// `<roaming>\ScreenPlay`, so replace the last segment when it looks like our
/// identifier; otherwise keep what Tauri returned.
fn reanchor_appdata(from_tauri: PathBuf, _exe_dir: &Path) -> PathBuf {
    let last = from_tauri
        .file_name()
        .map(|s| s.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if last == "screenplay" {
        return from_tauri;
    }
    match from_tauri.parent() {
        Some(parent) if last.contains("screenplay") => parent.join(APP_DIR_NAME),
        Some(_) if last == "com.screenplay.desktop" => {
            from_tauri.parent().unwrap().join(APP_DIR_NAME)
        }
        _ => from_tauri,
    }
}

/// DESIGN §7/§5: with `auth == "local"` we generate a random admin password
/// once, persist it in `config.json` (`adminPassword`) **and** drop a copy in
/// `<DATA_DIR>/初始密码.txt` so a first-time user can read it.
///
/// Returns the password to feed into `AUTH_ADMIN_PASSWORD` (or `None` when
/// another auth mode is active).
pub fn ensure_admin_password(data_dir: &Path, cfg: &mut Config) -> Option<String> {
    if cfg.auth != "local" {
        return None;
    }
    if !cfg.admin_password.is_empty() {
        return Some(cfg.admin_password.clone());
    }

    let pwd = generate_password(16);
    cfg.admin_password = pwd.clone();
    save(data_dir, cfg);

    let _ = fs::create_dir_all(data_dir);
    let note = format!(
        "ScreenPlay 本机管理员密码\r\n\
         ============================\r\n\
         用户名：admin\r\n\
         密码：{pwd}\r\n\r\n\
         此密码由程序首次启动时随机生成，并保存在 config.json 的 adminPassword 字段中。\r\n\
         如需更换，请删除 config.json 里的 adminPassword 后重新启动。\r\n\
         生成时间：{}\r\n",
        now_human()
    );
    if let Err(e) = fs::write(data_dir.join(PASSWORD_FILE), note) {
        eprintln!("[config] 写入初始密码文件失败：{}", e);
    }
    Some(pwd)
}

/// A 16-character password from an unambiguous alphabet (no `0O1lI`).
fn generate_password(len: usize) -> String {
    const ALPHABET: &[u8] =
        b"abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#%^*-_=+";
    let mut bytes = vec![0u8; len];
    if !random_bytes(&mut bytes) {
        // random_bytes always fills; this branch is unreachable but explicit.
        for b in bytes.iter_mut() {
            *b = b'a';
        }
    }
    bytes
        .iter()
        .map(|b| ALPHABET[(*b as usize) % ALPHABET.len()] as char)
        .collect()
}

/// Fill `buf` with random bytes, preferring the OS CSPRNG.
///
/// Windows uses `BCryptGenRandom` (bcrypt.dll is linked directly, so no crate is
/// added just for this) and other platforms read `/dev/urandom`. Only if both
/// fail do we fall back to a time/pid-seeded xorshift.
pub fn random_bytes(buf: &mut [u8]) -> bool {
    if fill_os_random(buf) {
        return true;
    }
    eprintln!("[config] 警告：系统随机源不可用，已回退到低强度随机数");
    fill_fallback(buf);
    true
}

#[cfg(windows)]
fn fill_os_random(buf: &mut [u8]) -> bool {
    // 待 Windows 端验证：BCryptGenRandom 的 FFI 签名与 `#[link(name = "bcrypt")]`
    // 链接名（Linux 主机上本分支不参与编译，无法在本机核实）。
    #[link(name = "bcrypt")]
    extern "system" {
        fn BCryptGenRandom(
            algorithm: *mut core::ffi::c_void,
            buffer: *mut u8,
            len: u32,
            flags: u32,
        ) -> i32;
    }
    const BCRYPT_USE_SYSTEM_PREFERRED_RNG: u32 = 0x0000_0002;
    let rc = unsafe {
        BCryptGenRandom(
            core::ptr::null_mut(),
            buf.as_mut_ptr(),
            buf.len() as u32,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    };
    rc == 0
}

#[cfg(not(windows))]
fn fill_os_random(buf: &mut [u8]) -> bool {
    use std::io::Read;
    match fs::File::open("/dev/urandom") {
        Ok(mut f) => f.read_exact(buf).is_ok(),
        Err(_) => false,
    }
}

#[cfg(not(windows))]
fn fill_fallback(buf: &mut [u8]) {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0x9E37_79B9_7F4A_7C15);
    let mut x = nanos ^ ((std::process::id() as u64) << 32) ^ 0xD1B5_4A32_D192_ED03;
    for b in buf.iter_mut() {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        *b = (x & 0xff) as u8;
    }
}

#[cfg(windows)]
fn fill_fallback(buf: &mut [u8]) {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0x9E37_79B9_7F4A_7C15);
    let mut x = nanos ^ ((std::process::id() as u64) << 32) ^ 0xD1B5_4A32_D192_ED03;
    for b in buf.iter_mut() {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        *b = (x & 0xff) as u8;
    }
}

// ---------------------------------------------------------------------------
// Date / time formatting
//
// Log files are named `desktop-YYYYMMDD.log` (DESIGN §5). Pulling in `chrono`
// for three integers would be wasteful, so Windows asks the OS for local time
// and everything else derives a civil date from the Unix epoch.
// ---------------------------------------------------------------------------

/// `(YYYYMMDD, "YYYY-MM-DD HH:MM:SS")` in **local** time on Windows, UTC elsewhere.
pub fn now_stamp() -> (String, String) {
    let (y, mo, d, h, mi, s) = local_parts();
    (
        format!("{y:04}{mo:02}{d:02}"),
        format!("{y:04}-{mo:02}-{d:02} {h:02}:{mi:02}:{s:02}"),
    )
}

/// Human-readable local timestamp for the password note and the log header.
pub fn now_human() -> String {
    now_stamp().1
}

/// `desktop-YYYYMMDD.log` file name (DESIGN §5).
pub fn log_file_name() -> String {
    format!("desktop-{}.log", now_stamp().0)
}

#[cfg(windows)]
fn local_parts() -> (i64, u32, u32, u32, u32, u32) {
    // 待 Windows 端验证：GetLocalTime 的 FFI（kernel32 默认链接）与 SYSTEMTIME
    // 的内存布局（8×u16 = 16 字节，`#[repr(C)]`）。
    // GetLocalTime lives in kernel32, which is linked by default on MSVC.
    #[repr(C)]
    #[derive(Default)]
    struct SystemTime {
        year: u16,
        month: u16,
        day_of_week: u16,
        day: u16,
        hour: u16,
        minute: u16,
        second: u16,
        milliseconds: u16,
    }
    extern "system" {
        fn GetLocalTime(lp_system_time: *mut SystemTime);
    }
    let mut st = SystemTime::default();
    unsafe { GetLocalTime(&mut st) };
    (
        st.year as i64,
        st.month as u32,
        st.day as u32,
        st.hour as u32,
        st.minute as u32,
        st.second as u32,
    )
}

#[cfg(not(windows))]
fn local_parts() -> (i64, u32, u32, u32, u32, u32) {
    // UTC. (Only used for the log file name / header on dev hosts.)
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    (
        y,
        m,
        d,
        (rem / 3600) as u32,
        ((rem % 3600) / 60) as u32,
        (rem % 60) as u32,
    )
}

/// Howard Hinnant's `civil_from_days` — days since 1970-01-01 → (y, m, d).
#[cfg(not(windows))]
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as i64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32; // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Append one line to a file, creating it if needed. Used for the boot banner.
pub fn append_line(path: &Path, line: &str) {
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{line}");
    }
}