# `1.3.2` 变更点说明（Windows 桌面端：默认局域网访问 + 防火墙默认放行 + 首次启动创建账户）

本轮按用户要求改 Windows 桌面端的三件事：

1. **默认对局域网开放** —— 以前只监听 `127.0.0.1`，同一局域网里的手机/平板/电视盒子根本连不上；
2. **程序默认放行** —— 不再让 Windows 弹「允许访问」、也不需要用户手工去防火墙里勾选；
3. **版号 `1.3.2`** —— 与同日发布的服务端 `1.3.2`（Steam 成就图标归一化）同号。

因为「对局域网开放」会让「鉴权默认关闭」变成真正的风险（整个库连同 `DELETE /api/media/:id`
这类破坏性接口都暴露在局域网），本轮一并把默认鉴权改成 `local`，并且**首次启动在网页上创建账户**
（不需要用户去数据目录里翻随机密码文件）。

改动范围：`windows/**`（Rust 壳 + 免安装启动器 + 脚本 + 文档）、`web/src/**`（登录页「创建账户」表单，
三端共用）、`backend/src/**`（`AUTH_ALLOW_SETUP` + `POST /api/auth/setup`）。Dockerfile、
`docker-compose*`、`flutter/**` 未动。

---

## 1. 版号线

| 形态 | 版号来源 | `GET /api/health` 的 `version` |
| --- | --- | --- |
| 便携包 / NSIS 安装包 | `windows/package.json` → `resources/build-info.json`（`prepare-backend.mjs` 第 8 步）→ Rust 壳设 `BUILD_VERSION` | `1.3.2` |
| webapp 包（零工具链） | 同上 → `windows/launcher/launch.mjs` 拼 `-desktop-portable` | `1.3.2-desktop-portable` |
| Linux 容器 / 源码直跑 | 根 `package.json` → `scripts/docker-build.sh` 生成 `BUILD_VERSION` | `1.3.2`（本轮同为 1.3.2） |

与 `1.3.1` 不同，这轮桌面端**不再**独立于 Linux 发布线：根 `package.json`、`backend/`、`web/`、
`windows/` 四处 `package.json` 都是 `1.3.2`，另外 `windows/src-tauri/tauri.conf.json:4` 与
`windows/src-tauri/Cargo.toml:6`（exe 版本资源）也是 `1.3.2`。

> 已构建过的旧产物里 `resources/build-info.json` 可能还是 `1.3.1` —— 它由
> `windows/scripts/prepare-backend.mjs` 第 8 步按 `windows/package.json` 现场生成，重跑 `npm run prepare` 即刷新。

---

## 2. 改动①：默认监听整个局域网（`host`）

**症状**：装在客厅/NAS 边上那台 Windows 上，局域网里的手机、平板、电视盒子访问不了；
只有那台 Windows 自己能用。

**根因**：后端本来就默认绑 `0.0.0.0`（`backend/src/main.ts:102`：`process.env.HOST || '0.0.0.0'`），
是桌面壳自己把地址压回了回环 —— `windows/src-tauri/src/backend.rs` 里写死了
`cmd.env("HOST", "127.0.0.1")`，免安装启动器里同样是写死的 `HOST: '127.0.0.1'`。

**改法**：

- `windows/src-tauri/src/config.rs` 新增配置键 `host`（默认 `0.0.0.0`），常量
  `LOOPBACK_HOST = "127.0.0.1"` / `LAN_HOST = "0.0.0.0"`；`normalize()` 只把
  `127.0.0.1`、`localhost`、`loopback`、`local-only`、`localonly` 认成「仅本机」，其余一律回到
  `0.0.0.0`（写错值不会变成「谁都不通」）。
- `windows/src-tauri/src/backend.rs`：`pick_port(&cfg.host, cfg.port)` 用**真实监听地址**试绑
  （只试 `127.0.0.1` 会在「别的进程恰好占着 0.0.0.0:3210」时误判成端口空闲），
  子进程环境改为 `cmd.env("HOST", &cfg.host)`。
- `windows/launcher/launch.mjs`：同规则的 `bindHost()`，`pickPort()` 也从 `srv.listen(0, HOST)` 起。
- **把地址告诉用户**：壳用 `lan_ipv4()`（把一个 UDP socket `connect` 到 `8.8.8.8:80` 取
  `local_addr()`，不发送任何数据包、不引依赖）拿到本机局域网 IP，写进启动日志、
  状态文案（`已就绪；局域网地址 http://192.168.x.x:3210/`）与设置页；
  免安装启动器用 `lanUrls()` 枚举 `os.networkInterfaces()` 的非 `internal` IPv4。
- 本机窗口、健康检查、`verify-desktop.mjs` 仍然走 `http://127.0.0.1:<port>/` —— 绑 `0.0.0.0`
  时回环地址一样可达，所以文档里原有的回环 URL 不算过期。

---

## 3. 改动②：防火墙默认放行（`firewall`）

**症状**：仅绑回环时防火墙不会拦（流量不出网卡），一旦绑 `0.0.0.0`：① 局域网设备连不上；
② 第一次有程序监听非回环地址时，Windows 会弹「允许 ScreenPlay 访问网络」的对话框；③ 用户不理它、
点「取消」或勾错了网络类型，就变成「有时通有时不通」。

**改法**：新增 `windows/src-tauri/src/firewall.rs`（**不引入任何第三方 crate**）：

- 规则名固定 `ScreenPlay`，按**端口段** `3210-3309` 放行（`FIRST_PORT`..`FIRST_PORT + PORT_PROBE_RANGE`，
  用户把 `port` 设到段外时自动追加），因此段内自动换端口不会失效，也不依赖 `node.exe` 的安装路径。
- **先放行、再监听**（`backend.rs` 在 spawn 之前调用 `crate::firewall::ensure_allowed(...)`）：
  Windows 只在「正在监听非回环地址且没有匹配规则」时才弹自己的对话框，规则先落地就什么都看不到。
- 查询用 `Get-NetFirewallRule`（**不需要管理员权限**，所以平时启动不会无谓地弹 UAC）；缺失时把
  `allow-screenplay.ps1` 写进 `<DATA_DIR>\firewall\`，再用 `Start-Process -Verb RunAs` 提权执行
  **一次**（`-Wait`，180 秒超时）；`<DATA_DIR>\firewall\attempted.txt` 记录「已经问过」，
  用户拒绝后不会每次启动都弹。
- 老系统（没有 NetSecurity 模块）脚本里 `catch` 退回 `netsh advfirewall firewall add rule`。
- **失败绝不阻断启动**：没有 PowerShell、UAC 被拒、组策略禁止改防火墙 —— 都只写一行日志，
  系统会退回它自带的「允许访问」对话框（点一次允许即可），文档与日志里也给出
  「以管理员身份运行 `allow-screenplay.ps1`」的手工路径。
- `config.json` 的 `"firewall": "off"` 可让壳完全不碰防火墙；`"host": "127.0.0.1"` 时
  自动跳过（仅本机不需要入站规则）。
- 免安装启动器（`launcher/launch.mjs`）用**同一套规则名、同一段端口、同一份脚本内容**，所以
  零工具链的 webapp 包同样默认放行。

---

## 4. 改动③：默认鉴权 `local` + 首次启动在网页创建账户（`allowSetup`）

**动机**：默认对局域网开放之后，「鉴权关闭」就等于把整个媒体库（含 `DELETE /api/media/:id`、
库根管理这类接口）对整栋楼开放。本轮把默认值改成 **`auth: "local"`**，并加一条安全不变量：
`normalize()` 里只要 `host` 不是回环，`auth: "off"` 会被**自动提升**为 `"local"`（想关掉必须同时把
`host` 改回 `127.0.0.1`）。

**改法**（后端与前端复用既有登录体系，没有新造轮子）：

| 位置 | 内容 |
| --- | --- |
| `backend/src/config/configuration.ts:150-152` | `authEnabled` / `authMode` / `authAllowSetup`（真值 `1/true/yes`，默认关） |
| `backend/src/auth/auth.service.ts` | `authAllowSetup` 为真时 onModuleInit **跳过播种**；新增 `setupAllowed` / `localUserCount()` / `needsSetup()` / `async setup(username, password, userAgent?)`；`login()` 在「还没账户」时 401 拦截，文案「该服务端还没有账户，请先在服务器本机打开网页创建账户」；`describe()` 增 `allowSetup`/`needsSetup` |
| `backend/src/auth/auth.controller.ts:73` | `@Post('setup')` —— 与 login 同构，**HTTP 201、响应体不含 token**（会话 token 只在 `Set-Cookie: screenplay_session=…; HttpOnly; SameSite=Lax`） |
| `backend/src/auth/auth.guard.ts:26` | `/api/auth/setup` 加入 `PUBLIC_PATHS` |
| `web/src/pages/Login.tsx` + `web/src/api/auth.ts` | `session.needsSetup` 为真时渲染「创建账户」表单（`useSetup()` → `POST /auth/setup`），成功后显示完成面板并引导进设置页；i18n 新增 15 个 `setup.*` 键（zh/en） |
| `windows/src-tauri/src/config.rs` | 新增 `allowSetup`（默认 `true`）；`ensure_admin_password()` 在 `allowSetup` 为真时**不**生成随机密码 |
| `windows/src-tauri/src/backend.rs` | `auth == "local"` 且 `allowSetup` 为真时传 `AUTH_ALLOW_SETUP=1`，否则才回落到 `AUTH_ADMIN_PASSWORD` |
| `windows/launcher/launch.mjs` | 同上（`ALLOW_SETUP`） |

**兼容性**：

- `"allowSetup": false` ⇒ 完全回到旧行为（首启随机生成 16 位密码，写 `config.json` 的
  `adminPassword` 与 `<DATA_DIR>\初始密码.txt`，该文件文案已改为「备用管理员密码」）。
- 已有账户的老用户升级后 `needsSetup=false`，登录照旧；`POST /api/auth/setup` 会 403
  「该服务端已经创建过账户，请直接登录」。
- 校验顺序：未开启 ⇒ 403「当前服务端未开启首次创建账户（需要 `AUTH_ALLOW_SETUP=1`）」；
  用户名不匹配 ⇒ 400「用户名需为 2–32 位字母、数字、点、下划线或连字符」；密码 < 8 ⇒ 400「密码至少 8 位」。
- Linux 容器同样具备该能力（`AUTH_ALLOW_SETUP=1`），但默认不开启，容器部署照旧。

---

## 5. 有意不改的边界（记录在案）

- **仍是 HTTP，不做 HTTPS/自签证书**：局域网内明文传输与 Android 端、浏览器直连一致；本轮不引入证书体系。
- **不改 NSIS 的 `installMode: "currentUser"`**：放行走 PowerShell 提权，而不是改成 perMachine 安装，
  这样便携包与安装包两种形态行为一致，也不需要用户重装。
- **防火墙规则按端口段而非 exe 路径**：避免「换端口/移动 exe 后规则失效」，代价是 3210–3309 段内
  任何程序监听都会被放行（该段是本应用独占的约定，见 `DESIGN.md`）。
- **不自动改写 `config.json` 之外的任何东西**：`firewall: "off"`、`host: "127.0.0.1"`、
  `allowSetup: false` 三个旋钮足以回到旧行为，用户的配置不会被悄悄升级覆盖。
- **`web/src` 由三端共用**，因此登录页与 i18n 的改动会一起进 Web/Linux 产物：源码指纹
  `521c4985d95f713c` → **`f9864755a02c7576`**（137 个文件，`.source-hash` 已重新生成）。
  Linux 镜像要重建后才带「创建账户」页面（不重建也能用，只是首次部署仍需老办法建账户）。
- **`flutter/**` 未动**：安卓端仍用「服务端地址 + 用户名密码」登录，服务端 API 形状没变。

---

## 6. 验证记录（2026-10-04，本机 NAS）

```bash
npx tsc --noEmit -p backend/tsconfig.json     # EXIT=0
npx tsc --noEmit -p web/tsconfig.json         # EXIT=0
node windows/scripts/verify-desktop.mjs       # 80 项通过 / 0 项失败
node windows/scripts/verify-desktop.mjs --smoke  # 91 项通过 / 0 项失败（多出的 11 项真启动打包后端跑接口）
node windows/scripts/verify-lan.mjs           # 20 项通过 / 0 项失败
node scripts/gen-source-hash.mjs --check      # ✓ f9864755a02c7576（137 个文件）
bash scripts/verify-suites.sh                 # 20 项通过 / 0 项失败（235 s）
cd flutter && source /tmp/sp-android/env.sh && flutter analyze   # 0 error / 0 warning（8 条既有 info）
cd flutter && flutter test --no-pub           # 52 项通过 / 1 项跳过 / 0 项失败
```

`verify-lan.mjs` 是本轮新增的桌面端端到端套件（`npm run verify:lan`）：在临时数据目录里真拉一次
免安装启动器，断言启动器打印 `0.0.0.0` 与局域网地址、`GET /api/health` 200、用**局域网 IP** 打开
`/` 能拿到页面（证明真的绑到了非回环地址）、`/api/auth/session` 首次为 `needsSetup:true`、
无凭证 `/api/games` 401、`POST /api/auth/setup` 201 且 token 只在 cookie 里、带 cookie 后
`/api/games` 200、重复 setup 403。它需要先 `npm run prepare`（要用到 `resources/backend/dist`），
所以没并进 `scripts/verify-suites.sh`。

**真机待验收（本机是 Linux NAS，没有 Windows、也没有 Rust 工具链）**：

- [ ] Windows 10/11 首次启动只弹**一次** UAC；`wf.msc` 的入站规则里出现 `ScreenPlay`（TCP 3210-3309）。
- [ ] 同局域网手机/平板打开 `http://<本机局域网 IP>:<端口>/` → 出「创建账户」页 → 建号 → 能正常看图库。
- [ ] 在 UAC 上点「否」：程序照常启动，系统弹自己的「允许访问」对话框，点允许后局域网可用。
- [ ] 关闭防火墙服务的机器 / 组策略禁止改防火墙的域内机器：启动不卡死，日志里有解释行。
- [ ] 升级安装（老 `config.json` 无 `host`/`allowSetup`）：默认值生效，老数据的账户仍能登录。

---

## 7. 复现构建

在 Windows 上（Node 20+、Rust 工具链，出 NSIS 安装包还需要 makensis）：

```powershell
cd windows
npm install
npm run prepare          # 前端（web/dist-desktop）+ 后端 + node/ffmpeg → src-tauri/resources
npx tauri build          # NSIS 安装包（版号取 tauri.conf.json / Cargo.toml）
npm run portable:win     # 便携 zip（ScreenPlay.exe，数据落在 exe 旁的 data\）
npm run bundle:webapp    # 零工具链 zip（ScreenPlay.cmd + Edge/Chrome）
npm run verify:win       # 80 项离线自查
npm run verify:win:smoke # 91 项（多出的 11 项真启动打包后端跑接口）
npm run verify:lan       # 20 项「局域网 + 首次创号」端到端自查（需先 npm run prepare）
```

本轮 exe / 安装包 / zip **尚未产出**：本机 NAS 上没有 `cargo`/`rustc`（`windows/scripts/cross/`
交叉编译脚本存在但未验证），Rust 侧的改动只做了源码级复核与文档复核，真机编译与防火墙行为
必须在 Windows 上完成（见第 6 节清单）。