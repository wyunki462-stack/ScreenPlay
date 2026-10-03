# `1.3.1` 变更点说明（仅 Windows 桌面端）

本轮只修 Windows 桌面端（Tauri 壳 + React 前端）报上来的三个问题。**`backend/`、
`Dockerfile`、`docker-compose*`、Linux 构建脚本零改动，Linux 端版本仍是 `1.3.0`**；
桌面端版号为 `1.3.1`。HTTP 接口、DTO、数据结构、app 目录布局（`appdata/`、`appmeta/`、
`cache/`、`audio/`）全部未变，Linux 容器与桌面便携包对同一份数据库完全兼容。

改动范围：`web/src/**`（三端共用的前端）+ `windows/**`（外壳配置、桌面端版号线、文档），
共 23 个文件、+441/−94 行。

---

## 1. 版号线：桌面端从 Linux 发布线里独立出来

| 形态 | 版号来源 | `GET /api/health` 的 `version` |
| --- | --- | --- |
| 便携包 / NSIS 安装包 | `windows/package.json` → `resources/build-info.json` → Rust 壳设 `BUILD_VERSION`（`windows/src-tauri/src/backend.rs:428/453`） | `1.3.1` |
| webapp 包 | 同上 → `windows/launcher/launch.mjs:65-71,212` 拼 `-desktop-portable` | `1.3.1-desktop-portable` |
| Linux 容器 / 源码直跑 | 根 `package.json` → `scripts/docker-build.sh:560` 生成 `BUILD_VERSION` | `1.3.0`（不变） |

**根 `package.json` 一个字都没动**：它同时是 Linux 镜像的 `BUILD_VERSION` 来源，
改它会让「只修 Windows」变成「Linux 也发新版」。

改到的文件：

- `windows/package.json:3` —— `1.3.0` → `1.3.1`（桌面端唯一版号源）。
- `windows/scripts/prepare-backend.mjs:506` —— 写 `resources/build-info.json` 的 `version`
  由读根 `package.json` 改为读 `windows/package.json`（变量 `desktopPkg`）。
- `windows/scripts/make-portable.mjs:169` —— 便携包名取 `windows/package.json`（同因）。
- `windows/src-tauri/Cargo.toml:2-5`、`Cargo.lock:2864-2866` —— `screenplay 1.3.1`（exe 版本资源）。
- `windows/src-tauri/tauri.conf.json:4` —— `version: 1.3.1`（安装包版号）。
- `windows/scripts/make-webapp-bundle.mjs:37` 本来就读 `windows/package.json`，无需改。

---

## 2. 修复①：图库「自定义排序」在 Windows 上拖不动

**症状**：Windows 桌面端切到「自定义排序」后，按住卡片拖不出任何反应；Linux/浏览器里正常。

**根因**：图库用的是标准 HTML5 拖放（`web/src/components/GameCard.tsx` 的
`draggable` + `onDragStart/onDragOver/onDrop/onDragEnd`，落在
`web/src/pages/Home.tsx` 的 `dragId/dropTarget/pendingOrder` 上）。**Tauri v2 的窗口默认
开启内部拖放接管（`dragDropEnabled` 默认 `true`），它会替换掉 WebView2 的 drag-drop
handler**，网页侧因此永远收不到拖放事件。官方注释原文
（本地 `tauri-utils-2.10.1/src/config.rs:1974-1984`）：

> Whether the drag and drop handlers used internally to generate `DragDropEvent`s are
> enabled on the webview. By default it is enabled. Disabling it is required to use
> HTML5 drag and drop on the frontend on Windows since we replace the drag drop handler
> of WebView2.

主界面确实跑在这个 webview 里（`windows/src-tauri/src/backend.rs:545-576`：健康检查通过后
`window.eval("window.location.replace(...)")` 把 splash 窗口导航成主界面），所以窗口级
配置直接生效。

**改法**：`windows/src-tauri/tauri.conf.json` 的窗口对象加上

```json
"dragDropEnabled": false
```

关掉接管是安全的：`web/src` 与 `windows/src-tauri/src` 里对 Tauri 拖放事件
（`__TAURI__` / `onDragDropEvent` / `tauri://`）零引用，没有功能依赖它；桌面端本来就不
支持「把文件拖进窗口导入」。

顺手补的两处（拖动后的手感与「拖了没生效」的观感）：

- `web/src/pages/Home.tsx` —— 落点后立刻把新顺序写进缓存
  （`queryClient.setQueryData<GameSummary[]>(["games", filters], next)`）：原实现只更新本地
  `pendingOrder`，持久化 `PUT /games/order` 落地后由 `invalidateQueries` 重拉，冷启动的
  「同意性 refetch」还没回来时列表会闪回旧顺序，看起来就像没拖动。另加容器级
  `onDragOver`（`preventDefault` + `dropEffect = "move"`）与 `select-none`，让卡片间隙也能
  落点、拖动时不选中文字。
- 失败提示：`{reorder.isError && …}` 一条红条 + i18n 键 `home.custom.saveFailed`
  （zh「排序保存失败，已恢复原顺序」/ en "Could not save the new order; the previous order was restored"）。

占位符与插入指示线（`GameCard.tsx:68-77 DropIndicator`、`dropSide` 高亮）保持原样。

---

## 3. 修复②：游戏详情页打开慢

**根因不是后端慢，而是前端把整页压在一条最慢的请求上**：

- `web/src/pages/GameDetail.tsx` 原实现 `if (gameQuery.isLoading) return <DetailSkeleton/>`，
  而 `GET /api/games/:id` 首访会在后端请求线程里 `await` 一整轮外网元数据刮削
  （`backend/src/games/games.service.ts:482-494` 的 `last_meta_refresh == null` 分支 →
  `metadata.service.ts:94 enrichGame()` 并发打 rawg/steam/metacritic/igdb/hltb，受 429 退避，
  冷刮削墙钟可达数十秒）。后端属冻结范围，不动。
- 同帧还无条件发了 `useGameMedia`（只有相册 tab 用）与 `useGameNeighbors`（只服务标题上方
  两个按钮）。
- 相册一次铺满全部媒体 DOM（裸 `<img loading="lazy">`），`PhotoSlider` 常驻并把每张图的
  4K `/preview`（2.5–9.8 MB）URL 一次性交给 react-photo-view。

**改法（分级懒加载 + 本地缓存 + 骨架）**：

| 文件 | 改动 |
| --- | --- |
| `web/src/pages/GameDetail.tsx` | 新增 `findCachedSummary()`：从图库列表缓存（key `["games", filters]` 前缀匹配）取出该游戏的 `GameSummary`，与完整详情组成 `game = detail ?? cached`。封面、标题、平台、评分、相册用 `summary` 就能画；只有详情独有的字段（简介/开发商/发行商/发售日/时长/价格/时间线/官方海报区）在 `!detail` 时显示局部骨架（新增 `MetaPending()`、`TabPending()`，复用 `ui/Skeleton`），整页骨架只在「既没有详情、也没有列表缓存」（例如硬刷新深链）时出现 |
| 同上 | `useGameNeighbors` 延后到浏览器空闲再发（`requestIdleCallback(enable, { timeout: 1500 })`，老浏览器退回 `setTimeout`），切游戏时重置 |
| 同上 | `gameQuery.isLoading` 时标题下方显示「元数据补全中…」轻量胶囊（i18n `detail.metaPending`），不再整页遮罩；有列表兜底而详情请求失败时，只在顶部给一条可重试提示（`action.retry`），页面照常可用 |
| 同上 | 「编辑海报」「平台设置」两个按钮与两个对话框加 `detail &&` 门（它们要读写完整海报/平台列表）；`HeroPosterCarousel` 在 `!detail` 时以同比例骨架占位（该组件按既定决定不加 `loading="lazy"`，本轮不动它） |
| `web/src/api/hooks.ts` | `useGame`/`useGameMedia`/`useGameNeighbors` 加 `staleTime: 5 分钟`、`gcTime: 30 分钟`（二次进入同一详情页不再重发，也不动 `main.tsx` 的全局默认值）；后两条加可选 `options.enabled`（默认 `true`，既有调用点行为不变） |
| `web/src/components/MediaGrid.tsx` | 网格里的裸 `<img>` 换成仓库自带的 `LazyImage`（IntersectionObserver 闸门 + 骨架占位，比例容器仍是 `aspect-video`，不产生 CLS —— 它的 docblock 记着「248 张图并发 248 个请求」的老教训）；`PhotoSlider` 改为首次打开查看器后才挂载（打开过就保持挂载，开合过渡动画不变） |

图片本地缓存：缩略图/封面/中转图本来就带
`Cache-Control: public, max-age=2592000, immutable`（`backend/src/media/media.controller.ts:44/68/95`），
浏览器缓存即可命中；前端不另加缓存层。

---

## 4. 修复③：空相册文件夹卡顿

**澄清**：卡的不是「扫描文件夹」，而是「点进一张空文件夹的游戏卡 = 打开一次详情页」，
也就是第 2 节那条冷刮削。空文件夹在这套代码里就是一张 `mediaCount = 0` 的游戏卡
（`backend/src/library/library.service.ts:159-231 scanGame()` 即使 `files = []` 也会 upsert 一行）。

**改法**：

- **零请求判空**：`web/src/pages/GameDetail.tsx` 相册 tab 里
  `mediaQuery.data == null && game.mediaCount === 0` → 直接渲染 `<MediaGrid media={[]}/>`，
  一个请求都不发就给出「暂无图片」。（服务端没有可用的判空入口：
  `GET /api/games/:id/media` 忽略一切查询参数、无 `limit/offset`，且后端属冻结范围；
  `mediaCount` 已随列表接口返回，是现成的判空依据。）
- **终结性空态文案**：`web/src/i18n/{zh,en}/media.ts` 新增 `media.emptyFolder`
  （zh「暂无图片」/ en "No images or videos"）。原 `media.empty` 那条劝用户去「刷新元数据/
  重新扫描」，对空文件夹是误导，保留但不再用于此处。
- **图库卡角标**：`web/src/components/GameCard.tsx:178-187` —— `mediaCount === 0` 时封面左下角
  显示短标「空」（tooltip 为「暂无图片」，i18n `media.emptyBadge`），进详情页之前就能看出
  这是个空文件夹。
- 扫描本身没有阻塞点可改：`useScanLibrary` 只在用户点按钮时触发
  （`web/src/pages/Home.tsx:245`），相册列表是纯 SQLite 查询（毫秒级返回）。

---

## 5. 有意不改的边界（记录在案）

- `backend/src/games/games.service.ts:482-494` 的「首访详情页同步等一整轮刮削」是**设计变更**，
  属后端/SQL 语义范围，本轮无权重，只在前端做了「不等它」。
- `GET /api/media/:id/preview`（原图，4K）**没有 `Cache-Control`**（`media.controller.ts:148-155`，
  仅 JXR 分支 `:162` 有 `immutable`），相册大图仍会在每次打开时重下；前端只削减到
  「首次打开才构造 URL / 挂载查看器」。
- `HeroPosterCarousel` 不加懒加载、`usePosters` 的 `refetchOnMount: "always"`、
  `web/src/api/client.ts` 的 401 流程、`LazyImage` 的 IntersectionObserver 语义：都是既有
  决定，本轮不动。
- 深链硬刷新（无列表缓存）仍走整页骨架 —— 既有行为，`scripts/verify-browser.mjs` 的
  `openDetail()` 依赖它。
- `web/src` 由三端共用，因此源码指纹变化：`35019ad7abf95fdd` → `1736b31e358104b9`
  （`.source-hash` 已重新生成）。Linux 侧本轮不发新镜像、版号不动。

---

## 6. 验证记录（2026-10-03，本机 NAS）

```bash
cd web && npx tsc --noEmit                      # 无输出，EXIT=0
node windows/scripts/verify-desktop.mjs         # 57 项通过 / 0 项失败
node scripts/gen-source-hash.mjs --check        # ✓ 1736b31e358104b9（137 个文件）
```

产物：

| 文件 | 大小 / 结果 |
| --- | --- |
| `windows/dist/ScreenPlay.exe` | 7,384,576 B；PE machine 0x8664、subsystem 2（GUI）、资源目录 10,368 B 非空；`FileVersion = ProductVersion = 1.3.1`；exe 内 `1.3.0` / `1.0.0` 命中 0 次 |
| `windows/dist/ScreenPlay_1.3.1_x64-portable.zip` | 114,362,118 B（109.06 MiB）/ 11,427 条目 / 10471 个 staging 文件全量比对通过 |
| `windows/dist/ScreenPlay_1.3.1_x64-webapp.zip` | 112,165,522 B（106.97 MiB）/ 11,430 条目（依赖 Edge/Chrome 的纯前端形态，`ScreenPlay.cmd` 启动） |
| `resources/build-info.json`（zip 内） | `{"version":"1.3.1","sourceHash":"1736b31e358104b9","builtAt":"2026-10-03T13:33:41.731Z","nodeVersion":"22.20.0"}` |
| `resources/backend/package.json`（zip 内） | `1.3.0`（后端版号不变，桌面端版号走 `BUILD_VERSION`） |
| `resources/web/assets/`（zip 内） | `index-DrJx1YXK.js` 309.01 kB、`GameDetail-KCdYxMvX.js` 91.12 kB、`Settings-C2k6kKoR.js`、`VideoPlayer-LLlQ56fq.js`、`Card-BiYUmhZX.js` |

未在本机跑浏览器套件（需要 repo 自带 Chromium 与在跑的服务）；详情页 prev/next 的 1.5s
延后由 `openDetail()` 的 `waitForFunction` 兜住。

---

## 7. 复现构建

在 Windows 上（有 Node 22 + Rust 工具链，NSIS 安装包还需要 makensis）：

```powershell
cd windows
npm install
npm run prepare          # 前端（web/dist-desktop）+ 后端 + node/ffmpeg → src-tauri/resources
npx tauri build          # 出 NSIS 安装包（版号取 tauri.conf.json / Cargo.toml）
npm run portable:win     # 出 ScreenPlay_1.3.1_x64-portable.zip
npm run verify:win       # 57 项离线自查
```

本轮 exe 是在 NAS 上用 `windows/scripts/cross/cross-build.sh --portable` 交叉编译的
（cargo-xwin + zig 垫片，见 `windows/docs/BUILD-WINDOWS.md`）；`web/dist-desktop` 与
`resources/` 两侧共用同一套 `prepare*` 脚本，产物与 Windows 本机构建一致。

两种 zip 都已出：`ScreenPlay_1.3.1_x64-portable.zip`（自带 Node/后端，双击 `ScreenPlay.exe`
即用，数据落在 exe 旁的 `data\`）与 `ScreenPlay_1.3.1_x64-webapp.zip`（不打包运行时，
靠系统的 Edge/Chrome，双击 `ScreenPlay.cmd` 启动）。