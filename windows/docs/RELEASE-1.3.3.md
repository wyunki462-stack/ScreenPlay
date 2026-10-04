# `1.3.3` 变更点说明（Windows 桌面端：密码可见性 / 媒体库目录浏览 / 设置页改密三端一致 / 成就抓取提速）

本轮桌面端与 **Web / Linux 服务端同号发布**（都是 `1.3.3`），改动全部落在三者共用的 `web/src` 与
`backend/src`（外加 `windows/scripts/prepare-frontend.mjs` 的一处收敛）；`windows/` 的 Rust 壳本身没有
功能分支改动，只是跟着版号重建。桌面端在这四项上与 Web 端**逐条一致**：

1. **登录页密码框「眼睛」图标** —— 可切换明文 / 密文；
2. **「添加媒体库」的「浏览…」目录选择器** —— 服务端只读白名单列表，桌面端与 Web 端同一套 UI；
3. **设置页「修改密码」三端一致** —— 删掉了桌面端专属的「空实现替身」，桌面产物与 Web 产物是同一应用；
4. **成就抓取提速（服务端）** —— 「刷新全部」默认复用 15 天内成功的成就数据，并给 Steam 单独的限流间隔。

改动范围：`web/src/**`（`components/ui/PasswordInput.tsx`(新)、`pages/Login.tsx`、
`components/PathBrowser.tsx`(新)、`components/LibraryManager.tsx`、`api/hooks.ts`、
`components/ChangePasswordCard.desktop-stub.tsx`(删)、`vite.config.ts`、`pages/Settings.tsx`、`i18n/**`）、
`backend/src/**`（`library/**`、`config/configuration.ts`、`common/http/http.service.ts`、
`metadata/**`、`games/**`）、`windows/scripts/prepare-frontend.mjs`。`flutter/**` 本轮另改（见
[`flutter/docs/ANDROID-1.3.3.md`](../../flutter/docs/ANDROID-1.3.3.md)），与本 Windows 发布说明无关。

---

## 1. 版号线

| 形态 | 版号来源 | `GET /api/health` 的 `version` |
| --- | --- | --- |
| 便携包 / NSIS 安装包 | `windows/package.json` → `resources/build-info.json`（`prepare-backend.mjs` 第 8 步）→ Rust 壳设 `BUILD_VERSION` | `1.3.3` |
| webapp 包（零工具链） | 同上 → `windows/launcher/launch.mjs` 拼 `-desktop-portable` | `1.3.3-desktop-portable` |
| Linux 容器 / 源码直跑 | 根 `package.json` → `scripts/docker-build.sh` 生成 `BUILD_VERSION` | `1.3.3`（本轮三端同号） |

根 `package.json`、`backend/`、`web/`、`windows/` 四处 `package.json` 都是 `1.3.3`，另外
`windows/src-tauri/tauri.conf.json` 与 `windows/src-tauri/Cargo.toml`（exe 版本资源）也是 `1.3.3`。

> 已构建过的旧产物里 `resources/build-info.json` 可能还是旧版号 —— 它由
> `windows/scripts/prepare-backend.mjs` 第 8 步按 `windows/package.json` 现场生成，重跑 `npm run prepare` 即刷新。

---

## 2. 改动①：登录页密码框「眼睛」图标（`PasswordInput`）

**动机**：登录、创建账户、修改密码几处都要填密码，出错时看不见输入内容。

**改法**：

- 新增 `web/src/components/ui/PasswordInput.tsx`，props 为
  `{value,onChange,autoComplete,autoFocus,className,testId}`；切换按钮默认
  `data-testid="password-visibility"`，创建账户页两个框为 `password-visibility-setup` /
  `password-visibility-confirm`，并带 `aria-label` / `aria-pressed` / `title`。
- `web/src/pages/Login.tsx` 的三个密码框（登录、创建账户、确认密码）全部换成该组件。
- 新增 i18n 键 `login.showPassword` / `login.hidePassword`（`web/src/i18n/{zh,en}/common.ts`）。

---

## 3. 改动②：「添加媒体库」新增「浏览…」可视化选择文件夹

**动机**：以前只能手敲目录路径，容易写错；桌面端与 Web 端都缺一个「点点点选目录」的入口。

**后端**（只读、无副作用）：

| 位置 | 内容 |
| --- | --- |
| `backend/src/library/library-roots.controller.ts:44-46` | 新增 `GET /api/library/roots/browse?path=…` |
| `backend/src/library/library-roots.service.ts` | `browseRoots()` / `browse()` / `browseFail()`：只列一层目录、最多 2000 条、过滤隐藏项与 `$RECYCLE.BIN` / `System Volume Information` / `lost+found`、用 `fs.realpath` 做前缀校验防符号链接逃逸 |
| `backend/src/config/configuration.ts:107-108` | 白名单根 = env `LIBRARY_BROWSE_ROOTS`；默认 = 媒体库根 + 已挂载根 + `/media /mnt /vol2 /home`（Windows 取盘符） |

**前端**：

- 新增 `web/src/components/PathBrowser.tsx`（面包屑 / 上级 / roots 快捷入口 / `Enter` 确认 / `Esc` 关闭，
  `data-testid` 前缀 `path-browser*`）。
- `web/src/components/LibraryManager.tsx` 路径输入右侧新增「浏览…」按钮
  （`data-testid="browse-path"`，**仅非 env 模式显示**）；选中后回填路径，继续走既有 500ms 防抖 +
  `useCheckRoot`。
- 新增 `web/src/api/hooks.ts` 的 `useBrowsePath`；i18n 各 12 个 `library.browse.*` 键。

**Windows 上的差异**：白名单根的默认集合会包含本机盘符（如 `C:\`），`PathBrowser` 的面包屑从盘符根开始；
列出的是**服务端视角**的目录（Windows 上是后端进程能看到的路径）。

---

## 4. 改动③：设置页「修改密码」三端一致

**背景**：`1.2.0` 时桌面端通过构建期把「修改密码」卡片替换成一个空实现模块
（`ChangePasswordCard.desktop-stub.tsx` + `web/vite.config.ts` 的 `resolve.alias`），当时桌面端默认无鉴权、
无需改密。`1.3.2` 起桌面端默认 `auth: "local"` 且首启在网页创号，改密入口必须真实可用。

**改法**：

- 删除 `web/src/components/ChangePasswordCard.desktop-stub.tsx`。
- `web/vite.config.ts` 去掉把它当替身注入的 `resolve.alias`。
- `web/src/pages/Settings.tsx` 去掉 `IS_DESKTOP_TARGET` 门，**无条件**渲染
  `<ChangePasswordCard session={session} />`。
- `windows/scripts/prepare-frontend.mjs` 的禁入字符串收敛为只剩 `cdn.plyr.io`（桌面产物与 Web 产物
  现在是**同一个应用**，`--mode desktop` 只决定输出目录 `web/dist-desktop`，不再裁剪任何界面入口）。

---

## 5. 改动④：成就抓取提速（服务端）

**动机**：「刷新全部」是对全库无条件重抓成就，既慢、又对 Steam 不礼貌；而 15 天 TTL 此前只在
`enrichGame`（扫描 / 详情懒加载）路径生效，批量刷新把它绕过了。

**改法**（详见 [`docs/VERIFY.md`](../../docs/VERIFY.md) 顶部「1.3.3 服务端」一节与
[`CHANGELOG.md`](../../CHANGELOG.md) 的 `[1.3.3]` 条目）：

- `backend/src/config/configuration.ts:141` 新增 `STEAM_STORE_BASE_URL` / `STEAM_API_BASE_URL`（默认真站）
  与 `CRAWLER_MIN_INTERVAL_STEAM_MS`（默认 **350**，仅对两个 Steam origin 生效）；全局
  `CRAWLER_MIN_INTERVAL_MS` 默认仍 **1200** 不变。
- `backend/src/common/http/http.service.ts:33` 改为 per-origin 间隔表（同一 origin 仍一次只发一个）。
- `backend/src/metadata/providers/steam.provider.ts:324` 单游戏内并行（基座 schema / 全球百分比
  `Promise.all`、DLC 有界并发上限 3 且保序）+ 成就 in-flight 单飞 + `fetch(...,{skipAchievements})`。
- `backend/src/metadata/metadata.service.ts:538` `RefreshOptions{achievements}`、
  `achievementsAreFresh` 收紧为「时间戳非空 + TTL 内 + `achievements_status IN ('ok','empty')`」。
- `POST /api/games/refresh-all` 默认 `ttl`；`?achievements=force` 回到旧行为
  （`games.controller.ts:168`、`games.service.ts:663`）。

**前后对比（N=30、双离线桩、每请求 250ms）**：

| 场景 | 改动前 | 改动后 | 变化 |
| --- | --- | --- | --- |
| sweep1 首次全量抓取 | 72139ms / 90 请求 | 21801ms / 90 请求 | **≥3.31×** |
| sweep2 紧接着再点「刷新全部」 | 71868ms / 90 请求（成就 60） | 16989ms / 30 请求（成就 0） | **≥4.23×** |
| 单游戏 p50 | 8867ms | 2173ms | **≥4.08×** |

口径为「同一份 1.3.3 构建 + 改动前语义 vs 新默认」，故倍数写「≥」；原始记录见
`docs/perf/achievements-before.txt` / `docs/perf/achievements-after.txt`。

---

## 6. 产物与校验值（均在 Linux 上产出）

| 产物 | 路径 | 实测 |
| --- | --- | --- |
| 桌面壳 | `windows/dist/ScreenPlay.exe` | **7,436,288 B**，PE VERSIONINFO `FileVersion` / `ProductVersion` = `1.3.3`，sha256 `0811eb02de9a0fac9fa4207fdd02a9a385792f9057b78eeb3e6940d11bce4f01` |
| 便携包 | `windows/dist/ScreenPlay_1.3.3_x64-portable.zip` | **114,343,271 B / 11,426 条目**，sha256 `0f8b8de9c8506f5134221c38bb71692a7cff585e8308d6eff8180f991032a7c3` |
| 免构建包 | `windows/dist/ScreenPlay_1.3.3_x64-webapp.zip` | **112,134,183 B / 11,429 条目**，sha256 `625f297143ef1ff33a8b8e270d2c24c6ded91fdc851a6a9f05e7c317352596d2` |
| NSIS 安装包 | `windows/dist/ScreenPlay_1.3.3_x64-setup.exe` | **74,944,713 B（71.47 MiB）**，sha256 `fc60e64ed20b635cb0b49f50a38ada761dcc0e473a79ac081c68f4d58c288367` |

体积、哈希与条目数的现场值另见 `windows/docs/ARTIFACTS.md` §5。

---

## 7. 复现构建：`make-setup-cross.sh` 重出命令链

在 Linux 主机上（不需要 Windows、不需要 Rust 宿主工具链的踩坑版本；配方同
`windows/docs/BUILD-WINDOWS.md` §3 与 §3.6）：

```bash
cd windows
npm install

# 1. 准备运行资源：桌面精简前端 + 编译后的后端 + node/ffmpeg
npm run prepare            # = prepare:frontend && prepare:backend

# 2. 交叉编译真 Windows exe（zig 冒充 cc/ar/rc + 4 个垫片）
bash scripts/cross/cross-build.sh          # → dist/ScreenPlay.exe

# 3. 用 Linux 原生 makensis 打 NSIS 安装包（依赖上一步的 exe 与 resources/）
bash scripts/cross/make-setup-cross.sh     # → dist/ScreenPlay_1.3.3_x64-setup.exe

# 4. 便携 zip（含 exe + resources/）与零工具链 webapp zip
npm run portable:win                       # → dist/ScreenPlay_1.3.3_x64-portable.zip
npm run bundle:webapp                      # → dist/ScreenPlay_1.3.3_x64-webapp.zip
```

`make-setup-cross.sh` 的前置条件是：先跑过 `cross-build.sh`（目标目录里已有
`release/screenplay.exe`）、`windows/src-tauri/resources/` 已就绪、`windows/node_modules` 里有
`@tauri-apps/cli`；首次联网会下载 `nsis_tauri_utils.dll`（约 34 KB）与 Debian 的 nsis 包。
它不用 `tauri build`（那会在 Linux 上试图编译 Windows 目标并报 `failed to run 'cargo metadata'`），
而是只跑 `tauri bundle --bundles nsis`，直接打包已编译好的 exe。

---

## 8. 验收步骤

**自动化（离线，本机已跑绿）**：

```bash
cd <仓库根目录>
npx tsc --noEmit -p backend/tsconfig.json     # rc=0
npx tsc --noEmit -p web/tsconfig.json         # rc=0
bash scripts/verify-suites.sh                 # 21 项通过 / 0 项失败（257 s）
node scripts/gen-source-hash.mjs --check      # ✓ d8e826c489fd756b（138 文件）
node windows/scripts/verify-desktop.mjs       # 82 项通过 / 0 项失败
node windows/scripts/verify-desktop.mjs --smoke  # 93 项通过 / 0 项失败
node windows/scripts/verify-lan.mjs           # 20 项通过 / 0 项失败
```

新增的桌面自检断言（2 项）：桌面产物里**含「眼睛」按钮代码**；**改密替身文件已删除**。

**真机待验收（本机是 Linux NAS，没有 Windows）**：

- [ ] **眼睛图标切换**：登录页 / 创建账户 / 修改密码三处的眼睛按钮都能切换明文与密文；按钮有
      `data-testid="password-visibility"`，切换后 `aria-pressed` 随之变化。
- [ ] **媒体库「浏览…」**：设置页「添加媒体库」点「浏览…」→ 根列表出现本机盘符（`C:\` 等）与
      媒体库根；从 `C:\` 面包屑逐级进入子目录；选中后路径回填并触发 `useCheckRoot` 校验；`Esc` 关闭、
      `Enter` 确认；列出的目录与服务端进程可见范围一致。
- [ ] **设置页改密三端一致**：桌面端设置页出现「修改密码」卡片，改密成功后新密码可重新登录
      （旧会话中其它会话被注销）。
- [ ] **局域网首启网页创号**：同局域网设备打开 `http://<本机局域网 IP>:<端口>/` 首次出「创建账户」页；
      建号后可正常使用（`1.3.2` 已引入，本轮回归确认未被改坏）。
- [ ] **成就提速**：在设置页点「刷新全部」，符合「15 天内且上次成功」的成就被跳过（观察请求日志 / 耗时下降）；
      需要强制重抓时用 `POST /api/games/refresh-all?achievements=force` 或单游戏按钮。

---

## 9. 已知限制（有意为之）

- **「浏览…」是服务端白名单只读列表，不做原生目录对话框**。原因有三：
  1. 桌面主窗口**刻意不授予 Tauri IPC 能力**（壳只负责拉起后端并托管同一份 Web 前端，见
     [`windows/DESIGN.md`](../DESIGN.md)），网页里拿不到 Windows 原生选目录 API；
  2. 免构建的 **webapp 形态**（`ScreenPlay.cmd` + Edge `--app`）根本没有 Tauri 壳，只有 HTTP；
  3. **局域网设备**访问时同样只能走 HTTP，原生对话框在远端浏览器里也无从实现。
  因此统一走「服务端读目录 → 浏览器渲染」这一条路径，三端（桌面 / webapp / 局域网浏览器）行为一致。
  目录访问受 `LIBRARY_BROWSE_ROOTS` / 默认白名单限制，只读、只列一层。
- **仍是 HTTP，不做 HTTPS / 自签证书**（沿用 `1.3.2` 的边界）。
- **成就 TTL 复用只对批量「刷新全部」生效**：单游戏的「刷新元数据」「刷新成就」按钮仍是强制刷新；
  `failed` / `unsupported` / 空状态即使时间戳新鲜也会重试。
- **`make-setup-cross.sh` 的首次联网依赖**：需要下载 `nsis_tauri_utils.dll` 与 Debian 的 nsis deb；
  离线环境需用 `SP_NSIS_DEB` / `SP_NSIS_COMMON_DEB` / `SP_NSIS_INCLUDE_DEB` 指到本地包。
- **真机行为（眼睛图标、盘符根浏览、改密、局域网创号、成就提速）必须在 Windows 上验收**，见第 8 节清单。