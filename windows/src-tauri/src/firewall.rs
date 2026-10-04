//! Windows 防火墙「默认放行」（1.3.2）。
//!
//! 背景：桌面端从 1.3.2 起默认监听 `0.0.0.0`（局域网可访问），而 Windows 防火墙的
//! 默认策略会挡掉外部入站 —— 第一次有程序监听非回环地址时，系统还会弹一个「允许
//! ScreenPlay 访问网络」的对话框。用户要求的「程序要默认放行」就是不要让那个对话框
//! 出现、也不要让人手工去「允许应用通过防火墙」里勾选。
//!
//! 做法（不需要任何第三方 crate；**检查**规则不需要管理员权限，所以平时不会弹窗）：
//!   1. 用 `Get-NetFirewallRule` 查名为 `ScreenPlay` 的入站规则是否已存在；
//!   2. 不存在时，把一段固定脚本写到 `<DATA_DIR>\firewall\allow-screenplay.ps1`，
//!      再用 `Start-Process -Verb RunAs` 提权执行一次（**只弹一次 UAC**）；
//!   3. 把「已经问过」记到 `<DATA_DIR>\firewall\attempted.txt`，用户拒绝后不在每次
//!      启动时反复弹窗；
//!   4. 规则按**端口段**（3210–3309，即 `FIRST_PORT..FIRST_PORT + PORT_PROBE_RANGE`）
//!      放行，因此在段内换端口（端口被占用时自动上探）不会失效，也不依赖 `node.exe`
//!      的安装路径。
//!
//! 拒绝授权、或系统根本没有 PowerShell 时都**不阻断启动**：Windows 会退回它自带的
//! 「允许访问」对话框，用户点一次「允许」即可；日志里也会打印手工命令。
//!
//! 本模块在 Linux 主机上只提供空实现（`cargo check` 也得能过，见 DESIGN §2）。

use std::path::{Path, PathBuf};

use crate::config::{self, Config};

#[cfg(windows)]
use std::process::{Command, Stdio};
#[cfg(windows)]
use std::time::{Duration, Instant};

/// 规则名（`netsh` / `Get-NetFirewallRule` 都用它；不随版本变，避免重复堆规则）。
pub const RULE_NAME: &str = "ScreenPlay";
/// 提权执行脚本的文件名（放在 `<DATA_DIR>/firewall/` 下，方便用户手工重跑）。
pub const SCRIPT_FILE: &str = "allow-screenplay.ps1";
/// 「已经问过用户」的标记文件；存在就不再弹 UAC。
pub const ATTEMPTED_FILE: &str = "attempted.txt";

/// 一次防火墙处理的结果，只用于日志/状态文案。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// `firewall` 被设成 `off`，本次不动防火墙。
    Disabled,
    /// `host` 是 `127.0.0.1`：不存在「从局域网进来」，放行规则没有意义。
    LoopbackOnly,
    /// 非 Windows 平台（开发机自检）。
    NotWindows,
    /// 规则本来就在。
    AlreadyAllowed,
    /// 本次提权添加成功。
    Added,
    /// 用户拒绝了 UAC，或提权执行失败 —— 不阻断启动。
    Declined(String),
    /// 以前问过（有标记文件），这次不再问。
    Skipped,
}

impl Outcome {
    /// 写进启动日志的一行中文说明。
    pub fn describe(&self) -> String {
        match self {
            Outcome::Disabled => "防火墙：config.json 里 firewall=off，未做任何改动".to_string(),
            Outcome::LoopbackOnly => {
                "防火墙：host=127.0.0.1（仅本机监听），无需入站放行".to_string()
            }
            Outcome::NotWindows => "防火墙：非 Windows 平台，跳过".to_string(),
            Outcome::AlreadyAllowed => {
                format!("防火墙：已存在入站放行规则「{RULE_NAME}」")
            }
            Outcome::Added => format!(
                "防火墙：已添加入站放行规则「{RULE_NAME}」（局域网设备现在可以直接访问）"
            ),
            Outcome::Skipped => format!(
                "防火墙：此前已尝试过放行（见 {ATTEMPTED_FILE}），本次不重复弹窗；若局域网仍连不上，\
                 请用管理员 PowerShell 执行 <数据目录>\\firewall\\{SCRIPT_FILE}"
            ),
            Outcome::Declined(why) => format!(
                "防火墙：未能自动放行（{why}）。Windows 可能会弹出「允许访问」对话框，点允许即可；\
                 也可以在管理员 PowerShell 执行 <数据目录>\\firewall\\{SCRIPT_FILE}"
            ),
        }
    }
}

/// 「3210-3309」这种端口段写法；用户把 `port` 设到段外时一并追加。
pub fn port_spec(preferred: u16, first_port: u16, probe_range: u16) -> String {
    let last = first_port.saturating_add(probe_range.saturating_sub(1));
    let base = format!("{first_port}-{last}");
    if preferred == 0 || (preferred >= first_port && preferred <= last) {
        base
    } else {
        format!("{base},{preferred}")
    }
}

/// `<DATA_DIR>/firewall/` 目录（放脚本与标记文件）。
pub fn dir_of(data_dir: &Path) -> PathBuf {
    data_dir.join("firewall")
}

/// 确保入站放行规则存在。任何失败都只回一个 `Outcome`（由调用方写日志），不阻断启动。
pub fn ensure_allowed(
    cfg: &Config,
    data_dir: &Path,
    preferred_port: u16,
    first_port: u16,
    probe_range: u16,
) -> Outcome {
    if cfg.firewall == "off" {
        Outcome::Disabled
    } else if !cfg.lan_reachable() {
        Outcome::LoopbackOnly
    } else {
        let ports = port_spec(preferred_port, first_port, probe_range);
        ensure_allowed_impl(data_dir, &ports)
    }
}

#[cfg(windows)]
fn ensure_allowed_impl(data_dir: &Path, ports: &str) -> Outcome {
    if !powershell_available() {
        return Outcome::Declined("找不到 powershell.exe".to_string());
    }

    if rule_exists() {
        return Outcome::AlreadyAllowed;
    }

    let flag = dir_of(data_dir).join(ATTEMPTED_FILE);
    if flag.exists() {
        return Outcome::Skipped;
    }

    let script = dir_of(data_dir).join(SCRIPT_FILE);
    if let Err(e) = write_script(&script, ports) {
        return Outcome::Declined(format!("无法写入 {SCRIPT_FILE}：{e}"));
    }

    // 提权命令：`Start-Process -Verb RunAs` 会弹一次 UAC，`-Wait` 等它跑完。
    let elevate = format!(
        "Start-Process -FilePath 'powershell.exe' \
         -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',{} \
         -Verb RunAs -Wait -WindowStyle Hidden",
        ps_literal(&script.to_string_lossy())
    );
    let elevate_arg = elevate.as_str();
    let mut cmd = Command::new("powershell.exe");
    cmd.args([
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        elevate_arg,
    ]);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::null());
    cmd.stderr(Stdio::null());
    // 用户在 UAC 上停留多久都算正常，给 3 分钟；超时就放弃（不阻断启动）。
    let status = run_with_timeout(&mut cmd, Duration::from_secs(180));

    // 无论成功还是被拒绝都记下标记文件：只问一次，不反复打扰启动。
    let _ = std::fs::create_dir_all(dir_of(data_dir));
    let _ = std::fs::write(
        &flag,
        format!(
            "{} — 已尝试自动放行（{RULE_NAME} TCP {ports}）。\r\n\
             重新尝试：删除本文件后重启 ScreenPlay，或以管理员身份运行同目录的 {SCRIPT_FILE}。\r\n",
            config::now_human()
        ),
    );

    match status {
        Some(st) if st.success() => {
            if rule_exists() {
                Outcome::Added
            } else {
                Outcome::Declined("提权命令返回成功，但规则仍未出现".to_string())
            }
        }
        Some(st) => Outcome::Declined(format!(
            "提权执行结束但未成功（退出码 {}）",
            st.code()
                .map(|c| c.to_string())
                .unwrap_or_else(|| "未知".to_string())
        )),
        None => Outcome::Declined("提权执行超过 3 分钟未结束".to_string()),
    }
}

#[cfg(not(windows))]
fn ensure_allowed_impl(_data_dir: &Path, _ports: &str) -> Outcome {
    Outcome::NotWindows
}

/// 规则是否已经存在（查询不需要管理员权限，所以启动时不会无谓地弹 UAC）。
#[cfg(windows)]
fn rule_exists() -> bool {
    let probe = format!(
        "$r = Get-NetFirewallRule -DisplayName '{RULE_NAME}' -ErrorAction SilentlyContinue; \
         if ($r) {{ exit 0 }} else {{ exit 3 }}"
    );
    let probe_arg = probe.as_str();
    let mut cmd = Command::new("powershell.exe");
    cmd.args([
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        probe_arg,
    ]);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::null());
    cmd.stderr(Stdio::null());
    matches!(run_with_timeout(&mut cmd, Duration::from_secs(15)), Some(st) if st.success())
}

#[cfg(windows)]
fn powershell_available() -> bool {
    let mut cmd = Command::new("powershell.exe");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", "exit 0"]);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::null());
    cmd.stderr(Stdio::null());
    run_with_timeout(&mut cmd, Duration::from_secs(15)).is_some()
}

/// 固定脚本：先试 `New-NetFirewallRule`，老系统（没有 NetSecurity 模块）退回 `netsh`。
#[cfg(windows)]
fn write_script(path: &Path, ports: &str) -> std::io::Result<()> {
    let body = format!(
        "# ScreenPlay 1.3.2 — 桌面端首次启动时自动生成；管理员 PowerShell 可直接重跑本文件。\r\n\
         $ErrorActionPreference = 'Stop'\r\n\
         $name = '{RULE_NAME}'\r\n\
         $ports = '{ports}'\r\n\
         try {{\r\n\
         \x20 if (-not (Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue)) {{\r\n\
         \x20   New-NetFirewallRule -DisplayName $name -Group $name -Direction Inbound -Action Allow `\r\n\
         \x20     -Protocol TCP -LocalPort $ports -Profile Any `\r\n\
         \x20     -Description 'ScreenPlay desktop (LAN access to the bundled server)' | Out-Null\r\n\
         \x20 }}\r\n\
         }} catch {{\r\n\
         \x20 netsh advfirewall firewall show rule name=$name *> $null\r\n\
         \x20 if ($LASTEXITCODE -ne 0) {{\r\n\
         \x20   netsh advfirewall firewall add rule name=$name dir=in action=allow `\r\n\
         \x20     protocol=TCP localport=$ports profile=any | Out-Null\r\n\
         \x20 }}\r\n\
         }}\r\n\
         exit 0\r\n"
    );
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(path, body)
}

/// 把字符串安全地嵌进 PowerShell 单引号字面量（路径里可能有 `'`，比如中文用户名）。
#[cfg(windows)]
fn ps_literal(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// `Command` 的带超时执行 —— `std::process` 没有超时版 `output()`，这里自己等。
#[cfg(windows)]
fn run_with_timeout(
    cmd: &mut Command,
    timeout: Duration,
) -> Option<std::process::ExitStatus> {
    let mut child = cmd.spawn().ok()?;
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status),
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(150));
            }
            Err(_) => {
                let _ = child.kill();
                return None;
            }
        }
    }
}