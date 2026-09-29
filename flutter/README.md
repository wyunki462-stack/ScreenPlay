# ScreenPlay — Flutter 客户端（Phase 2）

个人游戏媒体图库管理器的 **纯客户端**。所有数据均来自后端 HTTP API
（见 `/docs/API.md` 的权威契约），本客户端 **不做本地抓取或业务逻辑**。

- 平台目标：**Windows（桌面，鼠标）** 与 **Android（触屏，API ≥ 9.0 / minSdk 28）**
- UI 与 Web 前端保持一致：深色「游戏图库」主题（紫罗兰 / 青色种子色，Material 3）

---

## 目录结构

```
flutter/
├── lib/
│   ├── main.dart                       # 入口：ProviderScope + 深色 MaterialApp + 路由
│   ├── core/
│   │   ├── api_client.dart             # Dio 实例、错误处理、相对媒体 URL 转绝对
│   │   └── server_config.dart          # 服务器地址 Riverpod StateProvider
│   ├── models/models.dart             # API 模型类（fromJson 与 /docs/API.md 对应）
│   ├── providers/api_providers.dart   # Riverpod FutureProvider + AsyncNotifier 变更
│   ├── screens/
│   │   ├── home_screen.dart           # 统计栏 + 搜索 + 过滤 + 游戏网格
│   │   └── game_detail_screen.dart    # 详情头图 + 截图轮播 + TabBar 分区
│   ├── widgets/
│   │   ├── game_card.dart             # 游戏卡片（海报 / 时长 / Metacritic 徽章）
│   │   ├── media_tile.dart            # 图片 / 视频混合网格单元（封面 + 播放角标）
│   │   ├── video_player_screen.dart   # 全屏播放器（/stream + 封面）
│   │   ├── photo_viewer.dart          # 分页图片查看器（捏合缩放 / 原图）
│   │   └── settings_screen.dart       # 运行时修改服务器地址
│   └── utils/format.dart              # 时长（秒 → 「3天12小时」）等格式化
├── pubspec.yaml
├── analysis_options.yaml
└── README.md
```

---

## 视频插件选择

选择 **`video_player` + `chewie`**，而非 `better_player`：

1. `video_player` 是 Flutter 官方维护的插件，Android 端使用原生 ExoPlayer，接口稳定、
   更新及时；是社区事实标准。
2. `chewie` 基于 `video_player` 提供开箱即用的播放器 UI（播放/暂停、进度条、全屏、
   控制层），无需手写控制栏。
3. `better_player` 历史上一度固定较旧版本的 `video_player`，存在较长的维护空窗与
   依赖解析冲突，在较新的 Flutter 3.x / Dart 3.x 下更容易踩到版本问题，依赖树也更重。

> **Windows 桌面注意**：`video_player` 原生支持 Android（与 iOS/Web）。
> Windows 上播放视频需要额外的后端实现（如 `video_player_win` 或 `media_kit`）——
> 本脚手架未内置，正式交付 Windows 播放前需补上。播放器代码已正确接入
> `/api/media/:id/stream`（服务端支持 HTTP Range，保证拖动进度）与封面：
> `watch 截图/封面` → `/api/media/:id/cover`。

---

## 原生工程生成（首次运行前）

本目录已内置 `lib/`（纯 Dart 客户端）与 Android 原生壳
（`android/app/src/main/AndroidManifest.xml` 含**唯一** `INTERNET` 权限、
`android/app/build.gradle` 已设 `minSdkVersion 28`）。

首次构建前，用 Flutter 补齐平台胶水文件（`local.properties`、gradle wrapper
jar、以及 Windows Runner）：

```bash
# 在本目录生成缺失的原生工程文件（会保留上面的 Dart/lib 源码）
flutter create --org com.screenplay --project-name screenplay .

# 如需 Windows 桌面 Runner（CMake + VS 工程）：
flutter create --platforms=windows --org com.screenplay --project-name screenplay .
```

> `android/` 与 `windows/` 均由上述命令生成/补齐；`Flutter 3.x` 会自动产生
> 正确的 `local.properties`（指向 SDK）与 gradle wrapper。

## 运行

```bash
# 1) 获取依赖（Flutter 3.x / Dart 3 环境）
flutter pub get

# 2) Windows 桌面
flutter run -d windows

# 3) Android（连接设备或模拟器，API ≥ 28 即 Android 9.0）
flutter run -d <android-device-id>
```

### 指向后端地址

默认后端地址为 `http://localhost:3000`，可用两种方式覆盖：

1. **编译期参数**（推荐）：
   ```bash
   flutter run -d windows --dart-define=SCREENPLAY_API_URL=http://<后端主机IP>:3000
   ```
2. **运行时设置**：应用内右上角 ⚙ 进入「设置」，修改服务器地址并保存
   （通过 `shared_preferences` 持久化，跨启动生效）。运行时设置优先于默认值。

> Android 真机访问宿主机时，请使用局域网 IP（如 `192.168.x.x`），不要用 `localhost`。

---

## 构建产物

```bash
# Windows：debug/build/windows/runner/Release 下生成 exe
flutter build windows

# 便携式（portable，可选，与 exe 同级）
flutter build windows --release

# Android：build/app/outputs/flutter-apk/app-release.apk
flutter build apk --release
```

---

## Android 权限与 minSdk

- **网络权限**：需要在 `android/app/src/main/AndroidManifest.xml` 添加，且**应为唯一权限**：
  ```xml
  <uses-permission android:name="android.permission.INTERNET"/>
  ```
  无需存储 / 相机 / 定位等任何其它权限（媒体文件由后端经 HTTP 流式下发）。

- **minSdk 28（Android 9.0）**：在 `android/app/build.gradle` 中设置：
  ```gradle
  defaultConfig {
      minSdkVersion 28
      targetSdkVersion 34
  }
  ```

> 说明：`video_player` 的 Android 实现推荐 minSdk 21+，但本项目按需求统一为 **28**，
> 与「API ≥ 9.0」的验收口径一致。

- **明文 HTTP（开发期）**：后端默认走 `http://`（本机或局域网）。Android 9（API 28）起
  默认禁止明文流量，开发联调时需在 `<application>` 上开启：
  ```xml
  <application android:usesCleartextTraffic="true" ...>
  ```
  生产环境建议改用 HTTPS 后移除该项。

---

## API 客户端约定

- 所有相对媒体地址（`posterUrl` / `streamUrl` / `thumbnailUrl` / `coverUrl` 等）
  由 `ApiClient.resolve()` 拼接为绝对 URL。
- 错误统一转为 `ApiException`（解析后端 `{statusCode, message, error}` 中的 `message`）。
- 重新扫描 / 强制刷新元数据完成后会自动刷新对应缓存（`libraryStatus` / `games` / `gameDetail`）。