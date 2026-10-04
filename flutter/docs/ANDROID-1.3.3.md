# `1.3.3+4` 安卓端 —— 详情页分区 / 数据同步 / 视频播放三项修复

本轮只修安卓端（Flutter），后端与 Web 端同轮另有改动（见 [`CHANGELOG.md`](../../CHANGELOG.md) 的
`[1.3.3]` 条目与 [`windows/docs/RELEASE-1.3.3.md`](../../windows/docs/RELEASE-1.3.3.md)）；安卓端**只读**服务端
既有接口，HTTP 契约未变。三项报障都可归到「手机端没跟上 Web / Linux 端」或「Android 播放器与浏览器行为不同」，
修法一律以 Web 端既有实现与后端既有契约为基准。

- 详情页信息分区调整 —— 「通关时长 (HLTB) / 价格」不再混在评分区，评分区只留评分并新增「媒体评价」区块；
- 数据同步 —— 成就接口响应是对象而不是数组，客户端取错字段；下拉刷新 / 顶栏刷新要能一次刷全详情、成就、媒体评论；
- 视频播放修复 —— 后端要求会话，播放器请求不带凭证导致 `error 10`。

---

## 0. 版号与范围

| 项 | 值 |
| --- | --- |
| Flutter 版号 | `flutter/pubspec.yaml`：`1.3.2+3` → **`1.3.3+4`**（`versionName` 1.3.3） |
| versionCode 对应关系 | `+4` 是**基础** versionCode；`--split-per-abi` 会按 ABI 放大：arm64-v8a = **2004**、armeabi-v7a = **1004**、x86_64 = **4004**（`aapt dump badging` 实测，见 §4） |
| 改动文件 | `flutter/lib/screens/game_detail_screen.dart`、`flutter/lib/core/api_client.dart`、`flutter/lib/widgets/video_player_screen.dart`（外加状态层 `RefreshGameNotifier` 相关文件）；新增测试 `flutter/test/models_parse_test.dart`、`flutter/test/api_client_urls_test.dart` |
| 后端 / Web | 同轮 `1.3.3` 有新接口与行为变更（`GET /api/library/roots/browse`、成就 TTL 复用），但安卓端**未依赖**这些；安卓端用的仍是既有端点（见 §2） |
| 参考基线 | Web 端详情页与 `mediaReviews` 交互、后端 `/api/games/:id` 的 `achievements` 响应形状与 `/api/media/*` 的鉴权约定 |

---

## 1. ① 详情页信息分区调整

**现状顺序**（`flutter/lib/screens/game_detail_screen.dart` 的 `_InfoSection`）：

文件夹 → **通关时长 (HLTB)** → **价格** → 元数据刷新

- 「通关时长 (HLTB) / 价格」从**评分（媒体评价）区**移到「元数据刷新」**上方**。
- 评分页只剩评分 + 新增 **「媒体评价」区块**（`_MediaReviewsSection`），含综合分、抓取时间，
  并区分失败 / 不支持 / 空态（与 Web 端媒体评价面板的语义对齐，只是不做分页，见 §6）。

---

## 2. ② 数据同步

**缺陷 1：成就接口响应是对象，客户端当数组取。** 后端 `/api/games/:id` 的成就字段响应形如
`{items,counts,status,error,source}`，而客户端此前按纯数组解析。

**修法**：`flutter/lib/core/api_client.dart` 的 `achievements()` 改为取 `items`，同时**兼容纯数组**
（老后端 / 桩数据仍能解析）。

**缺陷 2：刷新不覆盖完整数据。** 下拉刷新与 AppBar 刷新此前只刷一部分。

**修法**：

- 新增 `mediaReviews()` / `refreshMediaReviews()` / `refreshAchievements()` 与 `mediaReviewsProvider`；
- 下拉刷新与 AppBar 刷新改为走 `RefreshGameNotifier.run()`，它现在**依次**刷新
  游戏详情 / 成就 / 媒体评论，并 `invalidate` 共 **5 个** provider：
  `gameDetail` / `games` / `gameMedia` / `achievements` / `mediaReviews`。

---

## 3. ③ 视频播放修复

**报障**：`PlatformException (VideoError, Video player had error 10: Source error, null, null)`。

**根因**：`/api/media/*` 受全局会话守卫，必须带凭证；而 `VideoPlayerController` 发起的请求没有带上
鉴权头 ⇒ 401 ⇒ ExoPlayer 报 `error 10`（浏览器端的 `<video>` 走的是同源 Cookie，所以 Web 端不暴露这个问题）。

**修法**（`flutter/lib/widgets/video_player_screen.dart`）：

- `VideoPlayerController.networkUrl` 现在带上 `httpHeaders: api.imageHeaders`（Bearer + Cookie，
  与图片加载**同源**，复用既有鉴权头拼装）。
- 对 `.avi` / `.rmvb` 等被判为 `application/octet-stream` 的容器，给出「格式不受支持」的**明确提示**
  （不再笼统报错）。
- 顺带修 URL 拼装：`api_client.dart` 的 `resolve()` 改为对路径**逐段** `Uri.encodeComponent`
  （避免含空格 / 中文 / 特殊字符的媒体路径被截断或转义错误）。

---

## 4. 离线验证（本轮实测）

```bash
cd flutter
source /tmp/sp-android/env.sh                   # 本机 Flutter 3.24.5 / JDK 17 / SDK 34
flutter analyze                                 # 0 error / 0 warning + 8 条既有 info
                                                #   （7 条 Riverpod *ProviderRef deprecated + 1 条 prefer_const_constructors）
flutter test --no-pub                           # 58 项通过 / 1 项跳过
```

- 新增测试文件（本轮）：
  - `flutter/test/models_parse_test.dart` —— 成就对象响应 `{items,counts,status,error,source}` 取 `items`、
    以及纯数组兼容；
  - `flutter/test/api_client_urls_test.dart` —— `resolve()` 逐段 `Uri.encodeComponent` 的 URL 拼装。
- 全量回归：1.3.2 时是 52 通过 / 1 跳过，本轮增至 **58 通过 / 1 跳过**（新增 6 条，含上述两个文件）。

---

## 5. 产物（`flutter/dist/`）

| ABI | 文件 | 字节 | SHA-1 | `versionCode` |
| --- | --- | --- | --- | --- |
| arm64-v8a | `app-arm64-v8a-release.apk` | 21,308,672 | `cb28dd6e536858a0741eb378921c0446f4cd7180` | 2004 |
| armeabi-v7a | `app-armeabi-v7a-release.apk` | 18,849,238 | `a0f521691a1135aace169408ee9e5149efa6ef64` | 1004 |
| x86_64 | `app-x86_64-release.apk` | 22,427,527 | `aa96fe9e25eb074fc77a8a7cbe9d105380b83736` | 4004 |

- 三个包 `versionName` 都是 `1.3.3`，`minSdk 28` / `targetSdk 34`，仍是 **debug keystore** 签名
  （**可侧载、不可上架**，与 1.3.1 首发一致）。
- `versionCode` 现场值由 `aapt dump badging <apk>` 复核：
  `package: name='com.screenplay.app' versionCode='2004' versionName='1.3.3'`（其余两个同理）。
- **`flutter/pubspec.yaml` 的 `1.3.3+4` 与 versionCode 的对应**：`+` 后是基础 versionCode `4`；
  `--split-per-abi` 按 ABI 放大成 `2004` / `1004` / `4004`（arm64-v8a 在 `2000 + base`、armeabi-v7a 在
  `1000 + base`、x86_64 在 `4000 + base`）。这就是「`1.3.3+4` ↔ versionCode **2004**（arm64-v8a）」的来源。

### 校验 `.sha1` 文件

每个 `.apk` 旁有同名 `.sha1`，**文件内容只有 40 位十六进制哈希**（没有文件名），因此不能直接
`sha1sum -c`。两种等价做法：

```bash
cd flutter/dist

# 做法一：比对内容
for f in app-*.apk; do
  [ "$(sha1sum "$f" | cut -d' ' -f1)" = "$(tr -d '\n' < "$f.sha1")" ] && echo "OK  $f" || echo "BAD $f"
done

# 做法二：拼成 sha1sum 能认的格式
for f in app-*.apk; do echo "$(cat "$f.sha1")  $f" | sha1sum -c -; done
```

### 打包命令（本机）

```bash
source /tmp/sp-android/env.sh && cd flutter && flutter build apk --release --split-per-abi
```

---

## 6. 真机验收清单（待用户设备执行）

1. **详情页分区**：进任意游戏详情，顺序为 文件夹 → 通关时长 (HLTB) → 价格 → 元数据刷新；
   评分区只剩评分 + 「媒体评价」区块（综合分 / 抓取时间 / 失败或空态提示）。
2. **成就显示**：详情页成就列表能正常显示（对象响应取 `items`），不再因字段读错而空白。
3. **刷新覆盖全量**：下拉刷新或点顶栏刷新后，详情、成就、媒体评论三者都跟着更新（无需分别点）。
4. **视频播放**：打开一个需要鉴权的视频能正常播放（不再 `error 10`）；打开 `.avi` / `.rmvb` 等
   不受支持的容器会看到「格式不受支持」的明确提示，而不是笼统报错。
5. **既有功能**：登录、图库两列网格、卡片 16:9、长按拖拽排序、卡片轮播、分享 / 存相册、删除媒体均不变。

---

## 7. 未做项 / 有意保留（记录在案）

- **媒体评价未分页**：安卓端「媒体评价」区块一次展示，未做分页；**Web 侧分页为 10 条/页**。
  本轮以「先能看、能刷新」为准，分页留待后续。
- **「查看原文」外链未做**：为避免新增 `url_launcher` 依赖（会牵动权限与商店审核面），
  安卓端不提供跳转 Metacritic 原文的按钮。
- **成就 / 媒体评论未做离线缓存**：手机端只读服务端数据，离线时不展示历史快照（与 1.3.2 的在线优先策略一致）。
- **仍是 debug keystore 签名**：正式上架前需在 `android/app/build.gradle` 补 `signingConfigs.release`。