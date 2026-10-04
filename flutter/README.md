# ScreenPlay — Flutter 客户端（安卓端 `1.3.2+3`）

个人游戏媒体图库管理器的**纯客户端**：所有数据都来自后端 HTTP API（权威契约见
[`../docs/API.md`](../docs/API.md)），本客户端**不做本地抓取或业务逻辑**，也不上传任何文件。

- 版号：**`1.3.2`**，`pubspec.yaml` 的 `version: 1.3.2+3`（`1.3.1+1` → `1.3.1+2` → 本轮 `1.3.2+3`；
  分包后 `versionCode` arm64 `2003` / v7a `1003` / x86_64 `4003`，`versionName` 用与后端同一发布版号 `1.3.2`）。
  Linux 服务端 / Docker 镜像的服务版号**不随本客户端变化**（Linux 端 `/api/health` 为 `1.3.2`），
  Windows 桌面端仍是 `1.3.1`。
- 目标平台：**Android 9.0+（minSdk 28，targetSdk 34）**。Windows 桌面端由仓库根目录的
  `windows/`（Tauri v2 外壳 + Web 前端）承担，**本目录不构建 Windows Runner**。
- 变更说明：首发（安卓端 `1.3.1+1`）与修订 2（`1.3.1+2`，连 Linux 后端五项体验修复）见
  [`docs/ANDROID-1.3.1.md`](docs/ANDROID-1.3.1.md)（修订 2 在 **§9**）；本轮 `1.3.2+3`（卡片海报区 16:9、
  自定义拖拽排序「松手即生效并持久化」、卡片轮播与 Web / Linux 端同步 + 左右滑动切图）见
  [`docs/ANDROID-1.3.2.md`](docs/ANDROID-1.3.2.md)。

---

## 支持的两类服务端

| 服务端 | 认证 | 客户端行为 |
| --- | --- | --- |
| **Linux 端 NAS 服务**（Docker 镜像 / 源码直跑） | 必须登录，账号体系与 Linux 端一致（后端 `AUTH_MODE=system` 或 `local`） | 连接页填写 `IP:端口` → 保存后探测 `GET /api/auth/session` → `enabled==true` ⇒ 进登录页；登录成功后以 Bearer 凭证调用受守卫接口 |
| **Windows 桌面端内置后端** | 免登录（外壳以 `AUTH_DISABLED=1` 启动后端） | 连接页填写 `IP:端口` → 探测到 `enabled==false` ⇒ 直接进首页 |

会话令牌在客户端**同时**以 `Authorization: Bearer <token>` 与 `Cookie: screenplay_session=<token>`
两条通道携带，服务端按哪种方式取都能识别（Cookie 优先）。

---

## 目录结构

```
flutter/
├── lib/
│   ├── main.dart                       # 入口：AppPrefs 注入 + 深色 MaterialApp + 启动路由（连接/登录/首页）
│   ├── core/
│   │   ├── api_client.dart             # Dio 实例、Bearer+Cookie 注入、错误处理、媒体 URL 拼接
│   │   ├── server_config.dart          # 默认服务器地址 + 归一化
│   │   ├── prefs.dart                  # AppPrefs：地址、会话、ServerMode、两个开关
│   │   ├── network_quality.dart        # WiFi/移动数据 → 原图/预览图
│   │   ├── image_cache.dart            # 内存 + 磁盘三级缓存（容量/过期策略、缓存键、清理）
│   │   ├── media_actions.dart          # 下载/分享/保存到相册/删除（同步或仅本地）
│   │   └── app_lifecycle.dart          # 前后台状态 → 预加载与刷新开关
│   ├── models/models.dart              # API 模型（与 /docs/API.md 对应）
│   ├── providers/api_providers.dart    # Riverpod providers（含删除、排序、海报、清晰度）
│   ├── screens/
│   │   ├── connect_screen.dart         # 服务器地址（IP + 端口）连接页
│   │   ├── login_screen.dart           # 账号密码登录（Linux 端）
│   │   ├── home_screen.dart            # 统计栏 + 搜索/筛选/排序 + 游戏网格（2/3/4 列自适应）
│   │   ├── game_detail_screen.dart     # 详情头图 + TabBar 分区 + 相册
│   │   └── settings_screen.dart        # 服务器地址、两个开关、清理图片缓存、退出登录
│   ├── widgets/
│   │   ├── authed_image.dart           # 带凭证的 CachedNetworkImage（Bearer + Cookie，全 App 图片唯一入口）
│   │   ├── brand_mark.dart             # 页内品牌标记（与 Web 页眉同源的渐变方块 + 手柄字形）
│   │   ├── brand_glyph.dart            # 品牌字形几何（由 scripts/brand-icons.mjs 生成，勿手改）
│   │   ├── game_card.dart              # 游戏卡片（海报左右滑动 / 长按拖拽排序 / 整卡可点）
│   │   ├── media_tile.dart             # 图片/视频网格单元 + 长按删除
│   │   ├── photo_viewer.dart           # 大图查看（捏合缩放、预览/原图切换）
│   │   └── video_player_screen.dart    # 全屏播放（/stream）+ 分享/保存/删除
│   └── utils/format.dart               # 时长等格式化
├── android/                            # Android 原生壳（Manifest、Gradle、wrapper）
├── docs/ANDROID-1.3.1.md               # 变更说明（1.3.1 首发 + 1.3.1+2 修订）
├── docs/ANDROID-1.3.2.md               # 变更说明（1.3.2+3：卡片比例 / 拖拽排序 / 轮播同步）
├── test/                               # Dart 单元 / 组件测试 + 真后端端到端用例（默认跳过）
├── pubspec.yaml / pubspec.lock
├── analysis_options.yaml
└── README.md
```

---

## 功能一览

- **游戏库**：默认一行 2 个卡片（宽 ≥600 三列、≥900 四列），格子比例按宽度反推；
  搜索（防抖）、平台/排序筛选（排序含「**自定义排序**」）、统计栏。
- **下拉刷新（与后端全量同步）**：首页顶部下拉 ⇒ `POST /api/library/scan`（与 Web「重新扫描」同一端点，
  后端是后台任务、实测 24–26 ms 返回）+ 重取列表与统计 + 清掉本地自定义顺序覆盖；成功后提示「已与后端同步」，
  失败提示「同步失败：…」且不清空列表。内容不足一屏也能下拉（`AlwaysScrollableScrollPhysics`）。
- **图片通道**：所有图片（卡片海报、详情头图与截图、相册封面、大图、视频封面、成就图标）统一走
  `AuthedImage` ⇒ 自动带 `Authorization: Bearer` + `Cookie: screenplay_session`；远端 CDN 图片经后端
  `/api/media/proxy` 取回（手机直连境外 CDN 在大陆网络下不可用），卡片用 `/thumbnail`（与 Web 端
  `cardFrame()` 同一套正则与取值），其余按清晰度取 `/preview` 或原图。
- **品牌图标**：应用图标（自适应图标前景 / 背景 / 单色层）与页内 `BrandMark`（首页左上角、连接页 / 登录页头图）
  都由 [`../scripts/brand-icons.mjs`](../scripts/brand-icons.mjs) 按 `web/public/favicon.svg` 生成，保证三端一致；
  `flutter test tool/render_brand_icons.dart`（在 `flutter/` 下跑）会把两者渲染成 `docs/brand-mark-192.png` 与
  `docs/brand-launcher-192.png`，供人工核对。
- **卡片**：海报**左右滑动**切换（仅多张海报时挂载滑动层，避免误触）；**整卡任意位置可点**进详情
  （海报层上的手势吸收层转交卡片的 `onTap`；只注册点击、不注册长按，以免与拖拽抢手势）；
  **长按卡片**触发拖拽排序，松手即乐观更新并 `PUT /api/games/order` 同步，失败回滚并提示。
- **相册**：图片/视频网格；**长按删除**（确认弹窗）；
  - 「删除同步到服务端」开启（默认）：调 `DELETE /api/media/:id` 删除服务端文件与索引；
  - 关闭：只清本机缓存并从列表本地隐藏，**不发网络请求**。
- **大图/视频**：`InteractiveViewer` 捏合缩放，顶栏可切「预览图 / 原图」；视频走 `/api/media/:id/stream` 全屏播放。
- **分享与保存**：单张媒体可调系统分享面板，可保存到系统相册；**客户端不存在任何上传路径**。
- **清晰度与缓存**：「WiFi 下自动加载原图」开启（默认）时 WiFi/以太网取原图、移动数据取低分辨率预览图；
  关闭后一律原图。内存 + 磁盘三级缓存，预览图与原图各自独立缓存键。
- **低功耗**：退到后台取消非必要请求并停止预加载；快速滚动时降低加载优先级、不预取离屏项；
  同步删除/刷新只在前台执行。
- **设置页**：服务器地址、两个开关、清理图片缓存、退出登录。

---

## Android 权限与 minSdk

`android/app/src/main/AndroidManifest.xml` 当前权限：

```xml
<uses-permission android:name="android.permission.INTERNET"/>
<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE"/>
<uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE"
    android:maxSdkVersion="28"/>
```

- `INTERNET`：媒体全部经 HTTP 从后端流式获取，唯一必需权限。
- `ACCESS_NETWORK_STATE`：区分 WiFi/以太网与移动数据（决定取原图还是预览图），普通权限，不弹窗。
- `WRITE_EXTERNAL_STORAGE`（仅 Android 9 及以下）：保存到系统相册；Android 10+ 走 MediaStore，不再申请。
- **不申请**：定位、相机、传感器、读取相册（`READ_EXTERNAL_STORAGE` / `READ_MEDIA_*`）。
  注：`aapt2 dump badging` 实测**合并后的 APK** 里除了上面 3 项，还有插件清单合并带入的
  `READ_EXTERNAL_STORAGE`（`maxSdkVersion=28`，仅 Android 9 及以下生效，非本端声明）与
  `com.screenplay.app.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`（Android 13+ 的接收器保护）。
- `android:usesCleartextTraffic="true"`：后端默认 `http://`（本机/局域网），保留；生产换 HTTPS 后可移除。
- `minSdk 28`（Android 9.0）、`targetSdk 34`、`compileSdk 34`、包名 `com.screenplay.app`。

---

## 构建

```bash
cd flutter

# 国内镜像（可选，仅网络受限时需要）
export FLUTTER_STORAGE_BASE_URL=https://storage.flutter-io.cn
export PUB_HOSTED_URL=https://pub.flutter-io.cn

flutter pub get
flutter analyze
flutter build apk --release --split-per-abi
# 产物：build/app/outputs/flutter-apk/app-release-{arm64-v8a,armeabi-v7a,x86_64}.apk
```

- 未开启 R8 / `minifyEnabled` / `shrinkResources`（无正式 keystore、无真机回归混淆后的插件反射），
  体积靠 `--split-per-abi` 分包与精简依赖控制。`release` 目前用 **debug keystore** 签名，可侧载，
  **不适用于上架**：正式发布请在 `android/app/build.gradle` 补 `signingConfigs.release`。
- 运行到设备：`flutter run -d <device-id>`；真机访问宿主机请填局域网 IP（如 `192.168.x.x`），不要用 `localhost`。
- 首次运行若缺 `android/local.properties` 或 wrapper，可在本目录执行
  `flutter create --org com.screenplay --project-name screenplay .` 补齐（会保留 `lib/` 源码；
  注意核对 `app/build.gradle` 的 `minSdk 28`、Manifest 权限、`usesCleartextTraffic` 未被覆盖）。

### Gradle 结构（与本项目相关的一个坑）

`android/` 已迁移到 **Flutter 3.24.5 的声明式写法**（`settings.gradle` 的
`pluginManagement{ includeBuild(<flutter sdk>/packages/flutter_tools/gradle) }` + `plugins{}`，
`app/build.gradle` 用 `plugins{}` 应用、`compileSdk = flutter.compileSdkVersion`），
**AGP 8.1.4 / Kotlin 1.9.22** 保持本项目原版本。

另外 `settings.gradle` 里有一段**必要的兜底**：Flutter 3.24.5 的 Gradle 插件只在 `:app` 上创建
`flutter` 扩展，而 `gal` / `package_info_plus` / `wakelock_plus` 在各自工程里写的是
`compileSdk flutter.compileSdkVersion`，会报
`Could not get unknown property 'flutter' ...` / `compileSdkVersion is not specified`。
兜底用 `gradle.beforeProject` 给插件工程补上同值的 `flutter`（优先复用 `:app` 的真实扩展）。
细节见 [`docs/ANDROID-1.3.1.md`](docs/ANDROID-1.3.1.md) §6.2。

---

## 视频插件选择

选择 **`video_player` + `chewie`**，而非 `better_player`：

1. `video_player` 由 Flutter 官方维护，Android 端使用原生 ExoPlayer，接口稳定、更新及时。
2. `chewie` 在 `video_player` 之上提供开箱即用的播放器 UI（播放/暂停、进度条、全屏、控制层）。
3. `better_player` 历史上曾固定较旧版本的 `video_player`，维护空窗长、依赖解析冲突多，在 Flutter 3.x 上更易踩坑。

播放器接入 `/api/media/:id/stream`（服务端支持 HTTP Range，进度可拖动）与封面
`/api/media/:id/cover`；`/api/media/:id/original` 用于「保存/分享原图」。

---

## API 客户端约定

- 相对媒体地址（`thumbnailUrl` / `previewUrl` / `streamUrl` / `coverUrl` / 海报 `url`）由
  `ApiClient.mediaUrl(id, {MediaVariant})` 与 `posterImageUrl` / `posterThumbUrl` 拼成绝对 URL；
  清晰度只决定取哪个变体，不改变后端语义。
- 错误统一转成 `ApiException`（解析后端 `{statusCode, message, error}` 的 `message`）；
  401 提示重新登录，删除时的 404 视为「服务端已无此媒体」。
- 受守卫接口一律带凭证；`/api/auth/session`、`/logout`、`/password` 与业务接口一样同时识别
  Cookie 与 `Authorization: Bearer`（见 `docs/API.md` 认证一节）。

---

## 验证

```bash
cd flutter
flutter analyze                       # 期望 0 error / 0 warning（8 条既有 info：7 条 riverpod 弃用提示 + 1 条 tool/ 下 prefer_const_constructors）
flutter test                          # 期望 52 项通过 / 1 项跳过（跳过的是真后端用例的占位）
node ../scripts/brand-icons.mjs --check   # 品牌图标产物 = web/public/favicon.svg（零依赖，漂移即 exit 1）
node ../backend/scripts/verify/media-delete-e2e.mjs    # 后端删除接口：22 项断言
node ../backend/scripts/verify/android-auth-bearer.mjs # 无 Cookie 的 Bearer 会话：19 项断言
```

`test/` 下的用例：`models_parse_test.dart`（列表 / 详情解析、snake_case ∪ camelCase 成就、逐项容错、海报列表）、
`api_client_urls_test.dart`（`resolve` / `imageSource` / `cardImageSource` / `cardPosterSources` / `imageHeaders`）、
`brand_mark_test.dart`（品牌常量、字形包围盒、20/36 比例、安卓资源同源）、`game_card_tap_test.dart`
（整卡可点：点海报区 / 信息行都进详情、吸收层不注册长按、横向滑动不进详情）、`home_reorder_test.dart`
（自定义排序拖拽：落点在卡片内立即乐观重排并提交 Web 端同款 `afterId` / `beforeId`、落点在两行间隙照样生效、
服务端顺序回来不回弹）、`game_card_carousel_test.dart`（轮播：static 无 `PageView`、slideshow 左右滑动、
3500 ms 自动翻页、手动切图后静默 2 个间隔、点海报区仍进详情、海报区 16:9）、`live_backend_test.dart`
（**真后端端到端，默认跳过**：填 `--dart-define=SP_LIVE_BASE=http://<后端>:<端口>` 才跑，覆盖「列表与详情
全量可解析 + 海报来源齐全 + 图片凭证必需（无凭证必须 401）+ 远端图经代理可取 + 成就图标鉴权失败为 0」；
复用 Docker 复现环境的跑法见 [`../docs/VERIFY.md`](../docs/VERIFY.md) 的 1.3.1+2 节）。

真机交互验收（整卡点击手感、下拉刷新手势、launcher 图标观感、移动数据下海报加载、拖拽排序手感、
系统分享面板、保存到相册等）请按 [`../docs/VERIFY.md`](../docs/VERIFY.md) 的清单执行。