# `1.3.1` 安卓端 Flutter 客户端 —— 变更说明

本轮为 ScreenPlay 新增**安卓端客户端**（`flutter/` 目录内的 Flutter 应用，非新工程），
并为它补齐后端所需的两个能力（媒体删除接口、无 Cookie 的会话凭证通道）。安卓端版号
`1.3.1`；**Linux 端与 Windows 后端的服务版号不变**（`GET /api/health` 在 Linux 容器里仍是
`1.3.0`，`windows/` 桌面端仍是 `1.3.1`，根 `package.json` 一字未动）。

改动范围：`flutter/**`（20 个 Dart 文件、6118 行；安卓工程胶水）+
`backend/src/media/**`、`backend/src/auth/**` + `backend/scripts/verify/*`（两个离线验证脚本）
+ 文档（`docs/API.md`、`README.md`、`CHANGELOG.md`、`flutter/README.md`、本文件）。

---

## 0. 三端一致性

| 维度 | 结论 |
| --- | --- |
| HTTP 接口 | **只增不改**：新增 `DELETE /api/media/:id`；`GET /api/auth/session`、`POST /api/auth/logout`、`POST /api/auth/password` 增加 `Authorization: Bearer` 识别，Cookie 行为原样保留（Cookie 优先）。其余端点、DTO、状态码、分页口径全未改动 |
| 数据库 | **结构零改动**：无新表、无新列、无迁移；删除只删除既有 `media` 行并清理既有磁盘缓存文件 |
| 既有功能 | Web 端此前**没有**删除媒体的入口，新增端点不影响既有 Web 页面；桌面端（Tauri 壳 + 同一份 Web 前端）行为不变 |
| 版号 | 安卓端 `1.3.1`；`flutter/pubspec.yaml` `version: 1.3.1+1`（`versionCode` 1）。Linux 后端 / Docker 镜像 / 根 `package.json` 不变，`windows/package.json` 不动。**2026-10-04 追加修订 2**：`version: 1.3.1+2`（`versionCode` 2，`versionName` 仍是 `1.3.1`），内容见 §9 |
| 数据库兼容 | 安卓端只是消费者：Linux 容器、Windows 桌面端内置后端对同一份 SQLite 完全兼容 |

---

## 1. 交付物

| 交付物 | 位置 |
| --- | --- |
| 安卓安装包 | 修订 2（`1.3.1+2`，2026-10-04）：`app-arm64-v8a-release.apk` **21,243,136 B**（主推，现代手机）、`app-armeabi-v7a-release.apk` **18,800,086 B**（老设备）、`app-x86_64-release.apk` **22,427,527 B**（模拟器）；`--split-per-abi` 三个 ABI 分包，另有同内容便利副本在 `flutter/dist/`（已被 `.gitignore` 忽略，不入库）。首发 `1.3.1+1` 三包为 21,240,968 / 18,797,918 / 22,359,823 B |
| 客户端源码 | `flutter/lib/**`（20 个 Dart 文件）、`flutter/android/**`（清单、Gradle 三件套、wrapper）；修订 2 新增 `flutter/lib/widgets/{authed_image,brand_glyph,brand_mark}.dart`、`scripts/brand-icons.mjs`、`flutter/test/**`（见 §9） |
| 后端源码 | `backend/src/media/media.controller.ts`、`backend/src/media/media.service.ts`、`backend/src/auth/auth.controller.ts` |
| 验证脚本 | `backend/scripts/verify/media-delete-e2e.mjs`（22 项断言）、`backend/scripts/verify/android-auth-bearer.mjs`（19 项断言） |
| 文档 | 本文件、`flutter/README.md`、`docs/API.md`（新增 `DELETE /api/media/:id` 与认证说明）、`CHANGELOG.md` |

---

## 2. 用户规格 → 实现对照

| 规格（任务书 §一/§二/§三/§四/§五） | 实现位置 |
| --- | --- |
| ① 在现有 `flutter/` 内开发，不新建独立工程 | 全部新增文件都在 `flutter/lib/**` 与 `flutter/android/**`；未触碰仓库根（根 `package.json` 未改） |
| ② 同时兼容 Linux 端 NAS 服务与 Windows 桌面端内置后端 | `lib/screens/connect_screen.dart` 保存地址后探测 `GET /api/auth/session`：`enabled==false` ⇒ `ServerMode.windows` 直连；`enabled==true` ⇒ `ServerMode.linux` 走登录（`lib/core/prefs.dart:16`） |
| ③ Linux 必须登录（账号体系与 PAM 一致、复用登录接口），Windows 免登录 | `lib/screens/login_screen.dart` 调 `ApiClient.login()`（`POST /api/auth/login`），会话校验走 `GET /api/auth/session`；Windows 端后端以 `AUTH_DISABLED=1` 启动，探测即免登录 |
| ④ 游戏列表默认一行 2 个卡片 | `lib/screens/home_screen.dart:349` `_columnsForWidth()`：宽 ≥900 → 4 列、≥600 → 3 列、否则 **2 列**；`lib/screens/home_screen.dart:364` `_childAspectRatioFor()` 由格子宽高反推并夹在 `[0.40, 0.62]` |
| ⑤ 安卓端版号 1.3.1，Linux/Windows 服务版号不变 | 见 §0；`flutter/pubspec.yaml:7` |
| ⑥ 海报轮播改为左右滑动切换 | `lib/widgets/game_card.dart` 的 `_PosterSlideshow`：多张海报时用 `PageView` 左右滑，单张时退回静态海报；滑动层上盖 `Positioned.fill(GestureDetector(behavior: opaque))` 保证滑动不误触点击 |
| ⑦ 列表长按卡片拖拽自定义排序，实时同步服务端 | `lib/screens/home_screen.dart:595` `_onReorder()`：乐观本地顺序 + `PUT /api/games/order`（`beforeId` = 落点下方卡片、`afterId` = 落点上方卡片），失败回滚并弹「排序同步失败」；`lib/providers/api_providers.dart:119` `reorderGamesProvider` |
| ⑧ 相册图片/视频长按删除，弹系统风格确认框，默认同步到服务端 | `lib/widgets/media_tile.dart:159` `runMediaDelete()`、`:201` `_MediaDeleteDialog`；`lib/core/media_actions.dart:43` `MediaActions.delete()` |
| ⑨ 关闭同步时仅删手机本地缓存 | `syncToServer:false` 时直接调 `mediaActionsProvider.delete`（**不经** `deleteMediaProvider.run`，避免它失效 `gameMediaProvider` 把已删条目重新拉回来），并从 `lib/widgets/media_tile.dart:125` `locallyRemovedMediaIdsProvider` 本地隐藏 |
| ⑩ 大图浏览、视频全屏播放 | `lib/widgets/photo_viewer.dart`（`InteractiveViewer` 捏合缩放 + 顶栏「原图/预览」切换）、`lib/widgets/video_player_screen.dart`（`video_player` + `chewie`，走 `/stream`） |
| ⑪ 单张媒体可调系统分享面板、可保存到系统相册 | `lib/core/media_actions.dart` 的 `share()` / `saveToGallery()`；`share_plus` 10.1.4、`gal` 2.3.3 |
| ⑫ **严格禁止任何媒体上传到服务端** | 客户端**没有**任何文件上传通道：`ApiClient` 的写操作只有 `POST /api/library/scan`、`POST /api/auth/login`、`POST /api/auth/logout`（`lib/core/api_client.dart:236/284/301`，均为 JSON/无体）、`PUT /api/games/order`(:370)、`DELETE /api/media/:id`(:343)；全仓 `lib/**` 无 `FormData` / `MultipartFile` / 字节流上传。分享与保存只读 `GET` 回来的字节 |
| ⑬ 非 WiFi 默认低分辨率预览、WiFi 原图；设置页「WiFi 下自动加载原图」默认开 | `lib/core/network_quality.dart:105` `mediaQualityProvider`：开关开 ⇒ WiFi/以太网 `MediaQuality.original`、移动数据 `.preview`；开关关 ⇒ 一律 `.original` |
| ⑭ 内存 + 磁盘三级缓存，优先读本地 | `lib/core/image_cache.dart:34` `ScreenplayCacheManager`（内存 80 MB、磁盘 600 个对象 / 30 天过期）+ `lib/core/image_cache.dart:58` `qualityCacheKey()` 让预览图和原图各自成缓存键 |
| ⑮ 后台暂停预加载并取消非必要请求 | `lib/main.dart:252` `HomeGate` 挂 `WidgetsBindingObserver`；退到后台时 `apiClient.cancelNonEssential()`（CancelToken，`lib/core/api_client.dart:139`） |
| ⑯ 快速滚动降低加载优先级、停止离屏加载 | `lib/screens/home_screen.dart:52` `_kFastScrollVelocity=1400`；`:397` `_onScrollNotification()` + `:384` `_inPreloadWindow()`，`:317` 处 `preloadAllowed && _inPreloadWindow(index)` 才预取海报 |
| ⑰ 同步删除/数据刷新仅前台执行 | `lib/core/app_lifecycle.dart` 的 `appLifecycleProvider` / `isForegroundProvider` / `preloadAllowedProvider`，前台才允许预取与刷新 |
| ⑱ 最小化权限（不要定位、传感器） | 清单只加 `ACCESS_NETWORK_STATE` 与 `WRITE_EXTERNAL_STORAGE(maxSdkVersion=28)`，见 §6 |
| ⑲ 设置页两个新开关 + 竖屏适配 | `lib/widgets/settings_screen.dart`：服务器地址、两个开关、清理图片缓存、退出登录；分组竖屏布局 |

---

## 3. 新增 / 改动文件（Flutter，20 个 Dart 文件 / 6118 行）

**新增 · 核心层**

| 文件 | 行 | 职责 |
| --- | --- | --- |
| `lib/core/prefs.dart` | 119 | `AppPrefs`（`SharedPreferences` 封装）、`enum ServerMode{linux,windows}`、键 `screenplay_load_original_on_wifi`(默认 true)、`screenplay_sync_delete_to_server`(默认 true)、`screenplay_session_token` / `_user` / `_server_mode` |
| `lib/core/network_quality.dart` | 115 | `NetworkQualityService`（`connectivity_plus` 监听）、`enum MediaQuality{preview,original}`、`mediaQualityProvider` |
| `lib/core/image_cache.dart` | 152 | `ScreenplayCacheManager`（`flutter_cache_manager` 定制：内存 80 MB、磁盘 600 对象、30 天）、`screenplayImageCache`、`qualityCacheKey(url, quality)`、`evictImage/clearImageCache/applyImageMemoryLimits` |
| `lib/core/media_actions.dart` | 220 | `MediaActions.downloadToTemp/share/saveToGallery/delete/ensureGalleryPermissionIfNeeded`、`DeleteOutcome`；删除时清 thumbnail/preview/original/stream 四个 URL 的缓存；401 → 中文提示，404 → 视为已删除 |
| `lib/core/app_lifecycle.dart` | 66 | `AppForegroundState`、`appLifecycleProvider`、`isForegroundProvider`、`fastScrollingProvider`、`preloadAllowedProvider` |
| `lib/screens/connect_screen.dart` | 235 | IP + 端口连接页；保存后探测会话能力并分流（Windows 直连 / Linux 去登录） |
| `lib/screens/login_screen.dart` | 238 | 账号密码登录（`remember` 默认开），成功后持久化 token 与用户名 |

**改动 · 既有文件**

| 文件 | 行 | 改动 |
| --- | --- | --- |
| `lib/core/api_client.dart` | 426 | `ApiClient({required String baseUrl, String? authToken})`、拦截器同时注入 `Authorization: Bearer <token>` 与 `Cookie: screenplay_session=<token>`；新增 `session()`(:251)、`login()`(:278，从 `Set-Cookie` 提取 token 并返回)、`logout()`、`listPosters()`、`deleteMedia()`(:343)、`reorderGames()`(:361)、`resetGameOrder()`、`mediaUrl(id, {MediaVariant})`(:67)、`posterImageUrl/posterThumbUrl`、`cancelNonEssential()`(:139)；新增 `SessionInfo` / `DeleteMediaResult` |
| `lib/models/models.dart` | 553 | 新增 `Poster`（与 `PosterDto` 同字段）；`Media` 增 `previewUrl` / `previewPath` / `thumbnailPath` |
| `lib/providers/api_providers.dart` | 205 | 新增 `postersProvider`、`sessionProvider`、`reorderGamesProvider`(:119)、`deleteMediaProvider`(:147)、`imageQualityProvider`、`pickImageUrlProvider`(:192) |
| `lib/main.dart` | 321 | 启动按 `AppPrefs` 决定去连接页/登录页/首页（`initialRouteForMode()`:89）；`ProviderScope` 注入 prefs/地址/两个开关/服务器模式；`HomeGate`(:252) 观测前后台并在后台取消非必要请求 |
| `lib/widgets/game_card.dart` | 382 | 海报 `PageView` 左右滑动、滑动层不误触点击、按清晰度与窗口决定加载哪张 |
| `lib/screens/home_screen.dart` | 780 | 2/3/4 列自适应、格子比例反推、排序下拉新增「自定义排序」、长按拖拽排序（乐观 + 回滚）、快速滚动降级、预加载窗口 |
| `lib/widgets/media_tile.dart` | 308 | 长按删除入口 `runMediaDelete()`(:159)、确认弹窗 `_MediaDeleteDialog`(:201)、本地隐藏集合 |
| `lib/widgets/photo_viewer.dart` | 374 | 顶栏「预览/原图」切换、按清晰度取图并独立缓存键；移除原生 `Image.network` 的旧「原图」页 |
| `lib/widgets/video_player_screen.dart` | 253 | 全屏播放 + 分享/保存/删除入口 |
| `lib/screens/game_detail_screen.dart` | 943 | 相册长按删除、媒体操作接线、竖屏适配 |
| `lib/widgets/settings_screen.dart` | 353 | 两个新开关、清理图片缓存、退出登录、竖屏分组 |
| `pubspec.yaml` | 57 | `version: 1.3.1+1`；新增 `connectivity_plus` / `share_plus` / `path_provider` / `gal` / `flutter_cache_manager` |
| `android/app/src/main/AndroidManifest.xml` | 50 | 权限与注释见 §6 |

> `lib/core/server_config.dart`(24) 与 `lib/utils/format.dart`(52) 未改动。

---

## 4. 后端改动

### 4.1 新增 `DELETE /api/media/:id`

- 控制器：`backend/src/media/media.controller.ts:179-183` `@Delete(':id') remove(@Param('id') id): Promise<object>`
  —— 未加额外守卫（沿用全局 `AuthGuard`），未加 `@HttpCode`，因此**成功返回 200 + JSON**；
  找不到媒体时服务层抛 `NotFoundException('Media not found')` ⇒ **404**。
- 服务：`backend/src/media/media.service.ts:124-204` `remove(id)`，语义与任务书一致
  （**删磁盘文件 + 删 DB 记录 + 清缩略图/预览缓存**）：

  1. 先删 `media` 行（无事务，沿用仓库既有删除范式），再删磁盘文件，单个文件删除失败**静默**；
  2. 清理 `DATA_DIR` 下的缓存：缩略图 `${id}.webp` 与 JXR 变体 `${id}v${JXR_PIPELINE_VERSION}.webp`、
     封面、预览 `${id}@*`（`:174` 附近）；
  3. 原图路径**必须落在媒体库根内**才删（`:283-294` `isInsideLibraryRoot()`；根集合 =
     `MEDIA_DIRS` env ∪ `library_roots` 表，判定为 `resolved===base || resolved.startsWith(base+path.sep)`），
     库根外的一律跳过并在返回体里以 `originalSkipped` 标注；
  4. 清理悬挂引用：`game_posters.media_id`（无 FK，`backend/src/database/database.service.ts:303`）
     与 `games.poster_url`。实现为 `:216-274` `restoreCoverAfterMediaDelete()` ——
     镜像 `posters.service.ts:533-567` 的回退逻辑（先删该 media 的海报行，再重新镜像仍被选中的行，
     否则按 `is_selected DESC, sort_order ASC, created_at ASC LIMIT 1` 提升，再否则退回该游戏第一张本地图，
     最后置空），刻意**不**注入 `PostersService` 以免 `PostersModule ↔ MediaModule` 循环依赖。

- 返回体：`{ok:true, id, deleted:true, removedFiles, postersRemoved, originalSkipped}`（已写入 `docs/API.md:503`）。
- 凭证：Linux 端由全局 `AuthGuard` 要求登录（无凭证 401）；Windows 桌面端后端以 `AUTH_DISABLED=1`
  启动，无需凭证（`backend/src/auth/auth.guard.ts:31`）。两条路径都在验证脚本里覆盖。

### 4.2 认证接口支持 `Authorization: Bearer`

现状：`AuthGuard` 早已同时接受 Cookie 与 Bearer（`backend/src/auth/auth.guard.ts:51-55`），但
`/api/auth/session`、`/api/auth/logout`、`/api/auth/password` 三个控制器方法**只看 Cookie**，
安卓端不保存 Cookie 会被判成未登录。改动：新增私有 `sessionTokenOf(req): string | undefined`
——先取 cookie，再取 `Authorization: Bearer`（`/^Bearer\s+(.+)$/i`），三个方法改用它。
**纯加法**：Cookie 路径一字未变；Web 端行为不变。`docs/API.md` 认证节已补说明。

---

## 5. 关键实现细节（供评审重点看这几处）

### 5.1 清晰度策略（用户原话：WiFi 原图 / 移动数据压缩图；关闭开关后一律原图）

`lib/core/network_quality.dart:105`：

```
开关开 → WiFi/以太网 → MediaQuality.original ；移动数据/其他 → MediaQuality.preview
开关关 → 一律 MediaQuality.original
```

`MediaQuality` 只决定**取哪个 URL**（`thumbnail` / `preview` / `original`，见
`lib/core/api_client.dart:67` `enum MediaVariant`）与**缓存键**（`qualityCacheKey`），
不改变任何后端接口语义。海报轮播与详情头图只用 `posterUrl`/`thumbUrl`，不受开关影响（后端已给合适尺寸）。

### 5.2 删除的两种模式

| 模式 | 行为 |
| --- | --- |
| 同步开（默认） | `DELETE /api/media/:id`（Linux 端带 Bearer + Cookie，Windows 端无凭证）→ 成功后失效 `gameMedia` / `gameDetail` / `games` / `stats`；服务端已删，列表自然消失 |
| 同步关 | 只清本机缓存（`evictImage`，四个 URL 变体）+ 把 id 放进 `locallyRemovedMediaIdsProvider` 本地隐藏；**不发任何网络请求** |

删除前一律弹确认框（`_MediaDeleteDialog`，Material 风格，文案区分「同时删除服务端文件」与「仅删除本机缓存」）。

### 5.3 卡片海报滑动与长按拖拽的区别

- 卡片主体：`PageView` 横滑切海报（`lib/widgets/game_card.dart` 的 `_PosterSlideshow`）——**只有 >1 张海报**时才挂载，避免单海报卡片平白多一层手势竞争。
- 长按拖拽：网格里长按卡片触发自定义排序；`_onReorder` 把 `beforeId`（落点下方）与 `afterId`（落点上方）
  按后端注释口径传（`backend/src/games/games.service.ts:1492-1550`：`afterId` = 落点上方卡片、`beforeId` = 落点下方卡片；
  Web 端同样口径见 `web/src/pages/Home.tsx:176`）。**这两个值传反会撞上
  `backend/src/games/games.service.ts:1523-1533` 的 `if (mid <= after || mid >= before)` ⇒ 触发
  `renumberCustomOrder()` + 递归 `reorder()`，表现为 500 或顺序错乱**，交付前已核对。

### 5.4 分享与保存（不允许上传）

`MediaActions.share()` 先把媒体下载到临时目录再用 `share_plus` 调系统分享面板；
`saveToGallery()` 用 `gal` 写系统相册（Android 9 及以下需 `WRITE_EXTERNAL_STORAGE`，见 §6）。
两者都只读 `GET` 回来的字节：客户端全仓没有任何 `FormData` / `MultipartFile` / 字节流上传，
写操作只有 `POST /api/library/scan`、`POST /api/auth/login`、`POST /api/auth/logout`、
`PUT /api/games/order`、`DELETE /api/media/:id`（`lib/core/api_client.dart:236/284/301/370/343`）。

### 5.5 连接与登录分流

```
连接页保存地址 → GET /api/auth/session
  ├─ enabled == false（Windows 桌面端 AUTH_DISABLED=1）→ ServerMode.windows，直接进首页
  └─ enabled == true （Linux 容器，auth.mode=system/local）→ ServerMode.linux → 登录页
        POST /api/auth/login {username,password,remember}
          成功：记住 token + user（SessionInfo），Response 的 Set-Cookie 也一并提取
          失败：中文提示（401）
启动时：有 token ⇒ 先 GET /api/auth/session 复核，未通过则回登录页
```

token 同时以 `Authorization: Bearer` 与 `Cookie: screenplay_session=` 两条通道携带
（`lib/core/api_client.dart:99-100`），这样后端无论按哪种方式取都能识别；服务端 `Set-Cookie` 值
在设置侧是 `encodeURIComponent(token)`，客户端提取时已解码处理。

---

## 6. 安卓工程改动

### 6.1 权限（`flutter/android/app/src/main/AndroidManifest.xml`）

| 权限 | 用途 | 备注 |
| --- | --- | --- |
| `INTERNET` | 所有媒体经 HTTP 从后端流式获取 | 唯一必需的权限 |
| `ACCESS_NETWORK_STATE` | 判断 WiFi/以太网 vs 移动数据以选清晰度 | 普通权限，不弹窗 |
| `WRITE_EXTERNAL_STORAGE`（`maxSdkVersion=28`） | Android 9 及以下保存到相册 | Android 10+ 走 MediaStore，不再申请 |

**不申请**：定位、相机、传感器、`READ_EXTERNAL_STORAGE` / `READ_MEDIA_*`。
`android:usesCleartextTraffic="true"` 保留（后端默认 `http://`，局域网联调必需）。
`minSdk 28`（Android 9.0）/ `targetSdk 34` / `compileSdk 34` / 包名 `com.screenplay.app` 全部保持原值。

### 6.2 Gradle：迁到 Flutter 3.24.5 的声明式写法 + 一个必要的兜底

原 `flutter/android/{settings.gradle,build.gradle,app/build.gradle}` 是**旧式命令式写法**
（`apply plugin` / `apply from: flutter.gradle` / `buildscript { classpath AGP }`）。它在本轮构建时报：

```
A problem occurred evaluating project ':gal'
> Could not get unknown property 'flutter' for extension 'android' of type com.android.build.gradle.LibraryExtension
Script '.../flutter_tools/gradle/.../flutter.groovy' line: 929
> Cannot invoke method substring() on null object        # getCompileSdkFromProject(): gradleProject.android.compileSdkVersion.substring(8)
> compileSdkVersion is not specified. Please add it to build.gradle
```

因此按 Flutter 3.24.5 自己的模板改成声明式（`settings.gradle` 里
`pluginManagement{ includeBuild(<flutter sdk>/packages/flutter_tools/gradle) }` +
`plugins{ dev.flutter.flutter-plugin-loader; com.android.application; org.jetbrains.kotlin.android }`；
`app/build.gradle` 用 `plugins{}` 应用、`android{}` 里 `compileSdk = flutter.compileSdkVersion`）。
**AGP 保持我们原来的 8.1.4**（不用模板的 8.1.0），`namespace` / `applicationId` / `minSdk 28` /
`release` 用 debug 签名等自定义项原样保留。Kotlin 插件则**必须从 1.9.22 升到 2.2.0**：本轮构建报

```
Execution failed for task ':package_info_plus:compileReleaseKotlin'
e: .../package_info_plus-9.0.1/.../PackageInfoPlugin.kt:127:6 Class 'kotlin.jvm.Throws' was compiled
   with an incompatible version of Kotlin. The actual metadata version is 2.2.0, but the compiler
   version 1.9.0 can read versions up to 2.0.0.
   The class is loaded from .../jetified-kotlin-stdlib-2.2.0.jar!/kotlin/jvm/Throws.class
```

根因是插件自己把新版 stdlib 带进了编译类路径：`package_info_plus-9.0.1/android/build.gradle:5`
`ext.kotlin_version = '2.2.0'` + `:51 implementation "org.jetbrains.kotlin:kotlin-stdlib:$kotlin_version"`
（`wakelock_plus-1.4.0/android/build.gradle:5/54` 同款；`shared_preferences_android-2.4.7` 用 `2.1.10`、
`share_plus-10.1.4` 用 `1.7.22`）。编译器只能读到 2.0.0 元数据，于是报一堆「`Unresolved reference: first`
/ `indices`、`Too many arguments for public constructor String()`」的假错。Flutter 自己也提示
「Your project requires a newer version of the Kotlin Gradle plugin … update the version number of the
plugin with id `org.jetbrains.kotlin.android` in the plugins block of `flutter/android/settings.gradle`」。
改法就是把 `plugins{}` 里那一行升到 `2.2.0`（与插件声明一致），AGP 不用动。

但仅迁移还不够：Flutter 3.24.5 的 Gradle 插件**只在 `:app` 上创建 `flutter` 扩展**
（`flutter.groovy:264`；`FlutterPlugin.apply`(`:212`) 不为 library 工程建扩展），而我们的插件
**`gal 2.3.3`、`package_info_plus 9.0.1`、`wakelock_plus 1.4.0` 在各自的 `android/build.gradle` 里写的是
`compileSdk flutter.compileSdkVersion`**（同上报文即来自 gal；官方 example 用的是更新的 Flutter + AGP 8.9.1）。
于是 `flutter/android/settings.gradle` 里加了一个带注释的兜底（放在 `include ":app"` 之前）：

```groovy
gradle.beforeProject { project ->
    if (project.path == ':app') { return }
    def appFlutter = project.rootProject.findProject(':app')?.extensions?.findByName('flutter')
    project.ext.flutter = appFlutter ?: [
        compileSdkVersion: 34, minSdkVersion: 21, targetSdkVersion: 34,
        ndkVersion: '23.1.7779620', versionCode: 1, versionName: '1.3.1',
    ]
}
```

即：插件工程求值前，优先复用 `:app` 上真实的 `FlutterExtension`，取不到时退回 Flutter 3.24.5 的默认常量
（`flutter.groovy:42-80`：compileSdk 34 / minSdk 21 / targetSdk 34 / ndk 23.1.7779620）。验证：
`./gradlew :app:tasks --dry-run` ⇒ `BUILD SUCCESSFUL`。

`app/build.gradle` **刻意不写** `ndkVersion = flutter.ndkVersion`：本项目 9 个安卓插件的
`ndkVersion` 全为 `None`（`.flutter-plugins-dependencies`），不写就不会触发 NDK 下载。

### 6.3 构建

```bash
cd flutter
export FLUTTER_STORAGE_BASE_URL=https://storage.flutter-io.cn
export PUB_HOSTED_URL=https://pub.flutter-io.cn
flutter pub get
flutter analyze
flutter build apk --release --split-per-abi     # 产物：build/app/outputs/flutter-apk/app-<abi>-release.apk
```

- **未开启 R8 / `minifyEnabled` / `shrinkResources`**：本项目 `release` 用 debug 签名（无正式 keystore），
  且本轮没有真机可回归验证插件反射/资源裁剪，宁可体积大一点也不冒「装上去崩在混淆」的风险；
  体积靠 `--split-per-abi`（三个 ABI 分包）+ 精简依赖控制。
- 依赖固定：`share_plus` 固定在 **10.1.4**（13.x 改了分享 API）、`gal` 2.3.3、`connectivity_plus` 6.1.5、
  `flutter_cache_manager` 3.4.1。
- 国内镜像：Flutter SDK 走 `storage.flutter-io.cn`、pub 走 `pub.flutter-io.cn`；Maven 由
  `$GRADLE_USER_HOME/init.gradle` 统一改写为 `maven.aliyun.com/repository/{public,google,gradle-plugin}`
  （本机到 `dl.google.com` / `repo.maven.apache.org` 不稳），Gradle 发行版走腾讯镜像。
- 本轮为在 NAS 上完成构建，曾临时调小 `flutter/android/gradle.properties` 的 JVM 堆并改过
  `gradle-wrapper.properties` 的 `distributionUrl`；**交付前均已还原为仓库原值**
  （`-Xmx4G -XX:MaxMetaspaceSize=2G`；`https://services.gradle.org/distributions/gradle-8.3-all.zip`）。

### 6.4 一个隐蔽的坑：`AndroidManifest.xml` 的首行注释必须是 XML 注释

`AndroidManifest.xml` 文件头那段落说明最初误写成 C 风格 `/* … */`，Gradle 在打包阶段直接报：

```
Execution failed for task ':app:processReleaseMainManifest'.
> com.android.manifmerger.ManifestMerger2$MergeFailureException: Error parsing
  /vol2/1000/ScreenPlay/flutter/android/app/src/main/AndroidManifest.xml
```

`xmllint --noout` 的原始错误是 `AndroidManifest.xml:1: parser error : Start tag expected, '<' not found`。
改成 `<!-- … -->` 后正常（现已对所有 `flutter/**/*.xml` 跑过 `xmllint --noout`，全部通过）。
XML 注释里**不能出现 `--`**，写说明时注意。

---

## 7. 验证结果

| 验证 | 命令 / 脚本 | 结果 |
| --- | --- | --- |
| 静态分析 | `cd flutter && flutter analyze` | **0 error / 0 warning**，7 条 info（均为 riverpod 2.6.1 的弃用提示：`lib/core/api_client.dart:71`、`lib/providers/api_providers.dart:16/24/31/38/44/49`） |
| 后端删除接口 | `node backend/scripts/verify/media-delete-e2e.mjs` | **22 项通过 / 0 失败**（离线隔离 `DATA_DIR`/`MEDIA_DIRS`、`AUTH_MODE=local`）；覆盖：无凭证 401 / 带 Cookie 200 / 磁盘文件与 DB 行消失 / 二次删除 404 / 列表与 `mediaCount` 一致 / `game_posters` 悬挂引用清理 / `AUTH_DISABLED=1` 免凭证 200 |
| 认证 Bearer 通道 | `node backend/scripts/verify/android-auth-bearer.mjs` | **19 项通过 / 0 失败**：`/api/auth/session`、`/logout`、`/password` 在 Bearer-only（无 Cookie）下均正确识别；Cookie 路径回归通过 |
| 后端类型/构建 | `npm --prefix backend run build`、`npx tsc --noEmit` | EXIT 0 |
| Gradle 配置 | `cd flutter/android && ./gradlew :app:tasks --dry-run` | `BUILD SUCCESSFUL` |
| APK 构建 | `flutter build apk --release --split-per-abi` | **3 个 ABI 分包全部构建成功**（见下表） |
| 包信息 | `aapt2 dump badging <apk>` | `package com.screenplay.app` / `versionName 1.3.1` / `sdkVersion 28` / `targetSdkVersion 34` / `native-code` 与分包一致；权限**只有** `INTERNET`、`ACCESS_NETWORK_STATE`、`WRITE_EXTERNAL_STORAGE(maxSdkVersion=28)`（另有 AndroidX 自动加的 `com.screenplay.app.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`） |
| 签名 | `apksigner verify --verbose <apk>` | `Verifies`（v2 方案 true，签名者 1 个，证书 `C=US, O=Android, CN=Android Debug`，SHA-256 `9a1a94436902c1bc5f43e76ff0435c4b1da46dfff30d3e5a60f1cf8ea9597fe3`） |
| XML 合法性 | `xmllint --noout`（全部 `flutter/**/*.xml`） | 全部通过 |

**APK 产物**（`flutter/build/app/outputs/flutter-apk/`，2026-10-04 本机 NAS 构建）：

| 文件 | 大小 | `versionCode` | SHA-256 |
| --- | --- | --- | --- |
| `app-arm64-v8a-release.apk` | 21,240,968 B（20.26 MiB） | 2001 | `8c5a1d731ac4403b4b6ebfde93c64dbd787778a9cc4663730cb61e2fecdaca82` |
| `app-armeabi-v7a-release.apk` | 18,797,918 B（17.93 MiB） | 1001 | `8ec12348958376abd14d636abe3245c49768a0df6d50cf1482c9128f5743b1a6` |
| `app-x86_64-release.apk` | 22,359,823 B（21.32 MiB） | 4001 | `689a2922aa17bbcf6c3922def7dfa870ca1981c2fb697610acab79ba270ffaed` |

> `versionCode` 是 Flutter 在 `--split-per-abi` 下按 ABI 附加的偏移（base 1 + v7a 1000 / arm64 2000 /
> x86_64 4000）；`versionName` 一律 `com.screenplay.app` 的 `1.3.1`。现代手机装 `arm64-v8a` 那个即可。

签名 = debug keystore（`signingConfigs.debug`），可直接侧载安装，但**不适用于上架**；
正式发布请提供自己的 keystore 并在 `flutter/android/app/build.gradle` 配置 `signingConfigs.release`。

**未做的验证（需真机）**：NAS 上没有 Android 设备/模拟器，因此本轮的**交互确认**（长按拖拽排序手感、
系统分享面板、保存到相册、退出后台取消请求、移动数据下取预览图）只做到代码层与静态分析层，
建议真机按 `docs/VERIFY.md` 的清单过一遍。

---

## 8. 已知限制与建议后续（均不阻塞本轮交付）

1. **release 用 debug 签名**：侧载可用，上架需换正式 keystore（见 §7）。
2. 后端原图删除走「库根校验 + 失败静默」：与既有删除范式一致（无事务、删库先行）。若日后要强一致，
   应改为「先删文件后删行」或在失败时回滚，但会牵动既有 Web 行为，本轮**刻意不动**。
3. `game_posters.media_id` 没有外键约束（建表就如此）：删除媒体时靠代码清理悬挂引用，
   若日后有别的写入路径直接改 `game_posters`，建议补 `ON DELETE SET NULL`（需要迁移，本轮不动）。
4. 图片缓存上限（内存 80 MB / 磁盘 600 对象 / 30 天）在设置页只提供「清理」，未做容量可视化调节。
5. Windows 桌面端若要支持安卓端删除服务端文件，`windows/` 需要重新打包（新的 `backend/dist` 必须进入
   `resources/backend`）——本轮不主动重发 Windows 包。
6. **服务端成就图标数据缺陷（2026-10-04 实测发现，不属本轮 App 修复范围，未改后端）**：
   `GET /api/games/:id` 内嵌的 `achievements[].icon_url` 里有 **1409 / 1738（81%）** 是「域名 + 路径之后
   又拼了一个完整 URL」的双重地址，例：

   ```
   https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/3768760/https://steamcdn-a.akamaihd.net/steamcommunity/public/images/apps/3768760/b3332b48b48964e7ddb245b4cfe6672b33df1c68.jpg.jpg
   ```

   尾巴指向**已下线**的 `steamcdn-a.akamaihd.net`，所以原样、取末段、补 `.jpg.jpg` 三种取法都是 502。
   正确形式（实测可用）：`https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/3768760/b3332b48b48964e7ddb245b4cfe6672b33df1c68.jpg` → `200 image/jpeg 18,633 B`。
   同类统计：`media[].coverUrl` **0/335** 坏、`GET /api/games/:id/posters` 的 `url` **0/536** 坏 —— 缺陷只集中在
   成就图标（爬虫写入时拼错），**Web 端同样显示裂图**，App 会退回奖杯占位图标（不劣于 Web）。
   建议后续：爬虫侧加绝对 URL 守卫 + 一次性迁移把 `<hash>.jpg.jpg` 归一为
   `https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/<appid>/<hash>.jpg`。
7. `READ_EXTERNAL_STORAGE`（`maxSdkVersion=28`）不是主清单声明的，而是插件清单合并带来的既有项（见 §7 /
   §9.3），文档此前只记了主清单的 3 项权限。

---

## 9. 修订 2（`1.3.1+2`，2026-10-04）：连 Linux 后端五项体验修复

用户报障（原话摘要）：连 Linux 后端后 **① 大部分海报不显示；② 点任意卡片都是「加载详情失败」；
③ 只有卡片下方文字能进详情；④ 应用图标与左上角图标要与 Web、Windows 统一；⑤ 首页要有下拉刷新，
触发时与后端全量同步（游戏列表 / 海报 / 元数据 / 评分）**，且要求与 Web 端体验对齐、不破坏现有功能。

### 9.1 根因（均在真实 Linux 后端上复现取证）

| # | 现象 | 根因 | 证据 |
| --- | --- | --- | --- |
| ① | 大部分海报不显示，只剩彩色渐变占位 | (a) 图片端点都要凭证，而 `CachedNetworkImage` 走 dart:io，**不经过 Dio 拦截器** ⇒ 一律 401；(b) 列表里的 `posters[]` 根本没被 App 读，卡片退化成 `postersProvider` 的**远端 CDN 直链**，手机在大陆网络下基本取不到 | 同一张封面：带凭证 `200 image/jpeg 52,927 B`，**不带凭证 `401`（81 B JSON）**；`/api/media/:id/thumbnail` 带凭证 `200 image/webp 6,018 B`、不带 `401`；`/api/media/:id/preview` 带凭证 `200 image/png 2,527,455 B`。Windows 桌面端 `AUTH_DISABLED=1` 无凭证放行，所以只在 Linux 后端暴露 |
| ② | 点任意卡片 → 「加载详情失败」 | 详情内嵌 `achievements[]` 是 **snake_case**（`game_id` / `icon_url` / `global_percent` / `dlc_app_id`），而 `Achievement.fromJson` 只读 `json['gameId'] as String` ⇒ `type 'Null' is not a subtype of type 'String'`；当时 `_parseList` 没有逐项容错 ⇒ 一行坏数据把整个 `GameDetail` 打挂 | 39 个游戏里 **34 个**点开必失败（另 5 个没有成就数据，恰好是 Windows 端测试库的情形，所以 Windows 不复现）。Web 不读这个内嵌数组（走 `GET /api/achievements/:id` 的 camelCase），因此只有 App 暴露 |
| ③ | 只有卡片下方文字能进详情 | 多海报轮播层上盖着一层「手势吸收层」（`GestureDetector(behavior: HitTestBehavior.opaque, onTap: () {})`），它把点击吃掉了 | `flutter/lib/widgets/game_card.dart` 里该层的 onTap 原本是空实现 |
| ④ | App 没有品牌标识 | 安卓自适应图标的前景还是手写的紫色三角 play；首页 AppBar 只有一行 `Text('ScreenPlay')` | — |
| ⑤ | 首页没有下拉刷新 | 网格没套 `RefreshIndicator` | — |

### 9.2 修法（逐条与 Web 端对齐）

**(1) 图片通道统一（①②）** —— `flutter/lib/core/api_client.dart`：

- `Map<String,String> get imageHeaders`：令牌非空时同时给 `Authorization: Bearer <token>` 与
  `Cookie: screenplay_session=<token>`（与业务请求同一套双通道凭证）。
- `String imageSource(String)`：相对地址 → 拼 baseUrl；**远端 http(s) 且不是本服务端 → 改走后端
  `/api/media/proxy?url=<Uri.encodeComponent>`**；本服务端地址原样。手机直连境外 CDN 大陆网络下不可用，
  这正是「一半海报有、一半没有、与 Web 数量不一致」的另一半原因。
- `String cardImageSource(String)`：`/api/media/:id/preview` → `/api/media/:id/thumbnail`，正则
  `^/api/media/([^/]+)/preview$` 与 Web `web/src/components/GameCard.tsx` 的 `cardFrame()` **逐字一致**
  （卡片只有 ~300px 宽，`/preview` 是 2.5–9.8 MB 的 4K 图，`/thumbnail` 是 ~6 KB 的磁盘缓存 WebP）。
- `List<String> cardPosterSources(GameSummary game)`：`[posterUrl, ...game.posters]` 去重后逐条归一，与 Web
  `cardPosters()` 同源同序。
- 新增 `flutter/lib/widgets/authed_image.dart`：`AuthedImage extends ConsumerWidget`，把
  `ref.watch(apiClientProvider).imageHeaders` 传给 `CachedNetworkImage.httpHeaders`（`watch` 而非 `read`，
  登录 / 登出换令牌后自动带新凭证）。App 内 **7 处** `CachedNetworkImage` 全部换成 `AuthedImage`：
  卡片海报、视频封面（`video_player_screen.dart`）、相册封面（`media_tile.dart`）、大图查看器
  （`photo_viewer.dart`）、详情页头部海报、媒体 PageView、成就图标（`game_detail_screen.dart` 三处）。
- 卡片海报改为**列表直传**：`home_screen.dart` 的 itemBuilder 现在算 `api.cardPosterSources(game)` 并用
  `GameCard(posterUrls: …)` 传入；`postersProvider` 预取降级为「列表没带海报」时的兜底。
  `flutter/lib/models/models.dart` 的 `GameSummary` 补上了 `posters` 字段（`GameDetail` 继承）。
- 详情页所有图片取值点（头部海报、截图流、相册封面、`displayUrl`、成就图标）从 `api.resolve(...)` 换成
  `api.imageSource(...)`。

**(2) 详情页解析健壮化（②）** —— `flutter/lib/models/models.dart`：

- `Achievement.fromJson` 同时接受 camelCase ∪ snake_case：`_asStringAny(json, ['id','external_id'])`、
  `['gameId','game_id']`、`['iconUrl','icon_url']`、`_asDoubleAny(json, ['globalPercent','global_percent'])`。
- `_parseList<T>` 改为**逐项 try/catch**（一行坏数据只丢那一行，不再让整个模型抛错）并返回
  `List<T>.unmodifiable`。
- `GameSummary.id/name`、`Poster.id/gameId/url` 去掉 `as String` 硬转，改用 `_asString(...) ?? ''`；
  `_asInt` / `_asDouble` 容忍数字字符串（`global_percent: 12` 读成 `12.0`）。
- 后端一行未改：`GET /api/games/:id` 的 snake_case 形状保持不变（改它会动契约与 Verify 指纹），
  客户端两边都读即可。

**(3) 整卡可点（③）** —— `flutter/lib/widgets/game_card.dart`：`_PosterSlideshow` 新增
`required VoidCallback onTap`，手势吸收层由 `onTap: () {}` 改成 `onTap: widget.onTap`。**只注册 onTap，不注册长按**
—— 自定义排序依赖外层的 `LongPressDraggable`，抢长按会破坏拖拽；横向拖拽仍由 `PageView` 胜出，滑动切图不受影响。

**(4) 三端图标统一（④）**：

- 新增零依赖生成器 **`scripts/brand-icons.mjs`**：先用字面量断言 `web/public/favicon.svg` 的品牌常量
  （`viewBox="0 0 36 36"`、`<rect … rx="8">`、渐变 `#7c3aed → #06b6d4`、
  `transform="translate(11.33333 11.33333) scale(0.555556)"`、白色 `stroke-width="2"` 的 Gamepad2 字形 4 线 1 路径），
  再把 SVG path 转成 Dart `Path`（所有 `a` 弧都是圆 ⇒ 转 `arcToPoint`）与安卓 VectorDrawable。
  `node scripts/brand-icons.mjs --check` 只比较不写入，漂移即 exit 1（与 Windows 的 `assertBrandSvg()` 同一思路）。
- 产物：`flutter/lib/widgets/brand_glyph.dart`（纯几何 + 品牌常量）、
  `flutter/android/app/src/main/res/drawable/ic_launcher_background.xml`（品牌对角渐变，替换原有纯色）、
  `drawable/ic_launcher_foreground.xml`（品牌字形，**覆盖**旧的紫色三角 play）、
  `drawable/ic_launcher_monochrome.xml`（Android 13+ 主题图标）、
  `mipmap-anydpi-v26/ic_launcher.xml`（自适应图标改指新背景 + 单色层；`minSdk 28` 足以只用矢量图标）。
- App 内标记 `flutter/lib/widgets/brand_mark.dart` 的 `BrandMark`：**与 Web 页眉同一套比例** —— Web 是
  `h-9 w-9`（36px）方块里放 `h-5 w-5`（20px）的 `Gamepad2`，故 `kBrandMarkGlyphRatio = 20/36`；用于首页
  AppBar leading（`BrandMark(size: 32)`，`leadingWidth: 56`）与连接页 / 登录页头图（`Center(child: BrandMark(size: 64, shadow: true))`）。
  注意：**应用图标**（favicon / Windows / 安卓 launcher）用 favicon 的 36 单位几何，**页眉标记**用 20/36 —— Web 端
  自己就是这么分工的，App 照抄同一套。详情页「没有海报」的占位仍保留通用手柄水印（换个渐变方块会叠在渐变底上）。

  渲染核对（在 `flutter/` 下执行 `flutter test tool/render_brand_icons.dart`，产物覆盖写入本目录）：

  ![App 内品牌标记 BrandMark（192px，字形占 20/36）](brand-mark-192.png)
  ![应用图标几何（等同 web/public/favicon.svg）](brand-launcher-192.png)

  左：App 内 `BrandMark`（首页左上角 / 连接页 / 登录页头图用的就是它）；右：**应用图标几何** ——
  36 单位方块 + `rx=8` + 对角渐变 + `translate(11.33333 11.33333) scale(0.555556)` 的白色手柄字形，
  与 `web/public/favicon.svg` 逐字同源（同一套常量由 `scripts/brand-icons.mjs` 生成）。
  两张 PNG 只是把生成出来的常量画出来看一眼，**几何真源仍是 favicon**（漂移由 `--check` 拦截）。

**(5) 下拉刷新全量同步（⑤）** —— `flutter/lib/screens/home_screen.dart`：

- 网格外套 `RefreshIndicator(onRefresh: _refresh)`，并给 `GridView` 加
  `physics: const AlwaysScrollableScrollPhysics()`（内容不足一屏时也能下拉）。
- `_refresh()`：`POST /api/library/scan`（与 Web「重新扫描」同一端点、同一语义；后端是**后台任务**，
  实测 **24–26 ms** 返回 ⇒ 不会长时间转圈）→ 重取 `gamesProvider` / `statsProvider` → 清掉本地自定义顺序覆盖
  → 失败弹「同步失败：…」，成功弹「已与后端同步」。扫描完成后游戏列表、海报、元数据、评分都会随重取刷新；
  详情页与媒体列表各自保有下拉刷新（`gameDetailProvider` 重取）。

### 9.3 验证

**静态与单元（本机 / 离线）**

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 静态分析 | `cd flutter && flutter analyze` | **0 error / 0 warning**（7 条 `deprecated_member_use` info 为 riverpod 2.6.1 既有写法） |
| Dart 单元测试 | `cd flutter && flutter test` | **43 通过 / 1 跳过**（跳过的是真后端用例的占位） |
| 图标产物一致性 | `node scripts/brand-icons.mjs --check` | ✓ 与 `web/public/favicon.svg` 一致 |
| 后端 / Web 未改 | `node scripts/gen-source-hash.mjs --check` | ✓ `a0e18c54d5340a97`（137 文件，与 1.3.1 首发相同） |
| 整仓离线全量回归 | `bash scripts/verify-suites.sh` | 见 `docs/VERIFY.md` |

新增测试文件：`flutter/test/models_parse_test.dart`（13 例：列表 / 详情夹具解析、snake_case 内嵌成就、
逐项容错、camelCase 兼容、媒体与海报）、`flutter/test/api_client_urls_test.dart`（16 例：`resolve` /
`imageSource` / `cardImageSource` / `cardPosterSources` / `imageHeaders`）、
`flutter/test/brand_mark_test.dart`（10 例：品牌常量、字形包围盒、20/36 比例、安卓资源同源）、
`flutter/test/game_card_tap_test.dart`（4 例：**③ 整卡可点** —— 点海报区与信息行都进详情、海报区吸收层
不注册长按（长按留给拖拽排序）、横向滑动切图不触发进详情）、
`flutter/test/live_backend_test.dart`（7 例，默认跳过，见下）。

**连真实 Linux 后端（Docker 复现环境 `sp-linux-test` @ `127.0.0.1:3007`，登录 `admin`；库 = 39 游戏 / 1917 媒体）**

```
cd flutter && flutter test --dart-define=SP_LIVE_BASE=http://127.0.0.1:3007 test/live_backend_test.dart
```

| 断言 | 实测 |
| --- | --- |
| 列表全部可解析、每个游戏都有海报来源、且全部指向本服务端 | **39 个游戏 / 海报来源 41 张 / 无海报 0 个**，URL 全部以 `http://127.0.0.1:3007` 开头（① 数据面） |
| 逐个游戏详情都能解析 | **39/39 成功，其中 34 个带成就**（② 修复前这 34 个必失败） |
| 封面带凭证可取、不带凭证必须 401 | 抽检 10 张全部 `200 image/jpeg\|webp`；同一张**不带凭证 `401`**（证明图片凭证必需） |
| 远端 CDN 海报换代理后可取 | `https://media.rawg.io/media/games/86f/86f2dc1b9671f25a13ff92e069b51786.jpg` → 代理 `200 image/jpeg`（① 另一半根因） |
| 成就图标走 imageSource + 凭证 | 抽样：可取图 11 / 服务端数据坏 502 **13** / **鉴权失败 0**（客户端契约成立；坏数据见 §8.6） |
| 下拉刷新数据面 | `POST /api/library/scan` **24–26 ms** 返回，之后列表与统计仍可取到全量 |

**构建产物（修订 2）**

| 项 | 实测 |
| --- | --- |
| APK | `app-arm64-v8a-release.apk` 21,243,136 B、`app-armeabi-v7a-release.apk` 18,800,086 B、`app-x86_64-release.apk` 22,427,527 B（`flutter build apk --release --split-per-abi`，141 s） |
| 包信息 | `com.screenplay.app` / `versionCode 2002` / `versionName 1.3.1` / `sdkVersion 28` / `targetSdkVersion 34` / `compileSdkVersion 34`（`aapt2 dump badging`） |
| 权限（与首发包逐条相同） | `INTERNET`、`ACCESS_NETWORK_STATE`、`WRITE_EXTERNAL_STORAGE`(maxSdk 28)、`com.screenplay.app.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`、`READ_EXTERNAL_STORAGE`(maxSdk 28，插件合并带入) |
| 签名 | `apksigner verify` ⇒ `Verifies`；APK Signature Scheme **v2 = true**；证书 SHA-256 `9a1a94436902c1bc5f43e76ff0435c4b1da46dfff30d3e5a60f1cf8ea9597fe3`（debug keystore，与首发一致） |
| 校验和 | SHA-256：arm64 `720d786a7321dc2e67e0e08bc6eb64bfead01c9fd5a31f488a227ee8b43fc5df` / v7a `321ec70f0d949d1b0a1779fbd1ee80522766a0bcfda4885c57d9c72b235c5fd5` / x86_64 `91adf41e8576cd68cdb531579eb3be02913e9148c5de6de2d56186bdc3874ee1`；`flutter/dist/*.apk.sha1` 记的是 SHA-1 |

`versionCode` 是 Flutter 在 `--split-per-abi` 下按 ABI 附加的偏移（base 2 + v7a 1000 / arm64 2000 / x86_64 4000）。

**未做的验证（仍需真机）**：NAS 上没有 Android 设备/模拟器，交互层（整卡点击手感、海报滑动与长按拖拽是否互不干扰、
下拉刷新手势、launcher 图标在真机启动器上的观感、大陆网络下海报加载耗时）只做到代码 / 静态 / HTTP 层验证，
建议真机按 `docs/VERIFY.md` 清单过一遍。

### 9.4 明确未改的东西

- 后端 / Web 一行未改（源指纹 `a0e18c54d5340a97` 不变，18 项 508 断言全量回归照跑）。
- 未给 App 加任何新权限、未改 `minSdk` / `targetSdk`、未动签名配置。
- 未处理 §8.6 的成就图标数据缺陷（属后端爬虫 + 数据迁移，另行安排）。
- 详情页空海报占位、`postersProvider` 预取兜底路径、媒体清晰度策略均保持原样。
