# `1.3.2+3` 安卓端 —— 卡片比例 / 拖拽排序 / 卡片轮播三项交互修复

本轮只修安卓端（Flutter）交互，`backend/src` 与 `web/src` **一行未改**：三项报障都是「手机端没对齐
Web 端」，所以修法一律以 Web 端既有实现为基准，并补了离线回归用例把基准钉住。

- 用户报障（原话要点）：①卡片比例统一 —— 游戏卡片改为与 Web 端一致的 16:9、替换长条状样式、海报完整展示；
  ②自定义拖拽排序修复 —— 能拖但松手后位置不更新、排序不生效；要求松手立即更新并持久化、重启后不丢；
  ③卡片轮播修复与同步 —— Linux / Web 端设的首页卡片轮播状态要在移动端实时生效，且能左右滑动切上一张 / 下一张。
- 验收要求（原话要点）：不影响现有功能、全量回归验证通过、数据与 Web 端 / Linux 端保持一致。

---

## 0. 版号与范围

| 项 | 值 |
| --- | --- |
| Flutter 版号 | `flutter/pubspec.yaml`：`1.3.1+2` → **`1.3.2+3`**（`versionCode` 3、`versionName` 1.3.2） |
| 改动文件 | `flutter/lib/models/models.dart`、`flutter/lib/widgets/game_card.dart`、`flutter/lib/screens/home_screen.dart`；新增测试 `flutter/test/home_reorder_test.dart`、`flutter/test/game_card_carousel_test.dart` |
| 后端 / Web | 本轮未改（发布时现场值：源码指纹 `521c4985d95f713c`，137 文件；服务端 1.3.2 的图标修复与本轮无关）。**同日稍后的 Windows 桌面端轮次**改了 `web/src` 登录页与 `backend/src` 鉴权 ⇒ 当前指纹 `f9864755a02c7576`，与本轮 APK 无关 |
| Windows / Linux 桌面端 | 本轮未改（当时 `windows/` 仍 `1.3.1`；同日稍后 Windows 提升到 `1.3.2`，见 `windows/docs/RELEASE-1.3.2.md`） |
| 为什么与后端同版号 | 同一发布轮次的两端载体：服务端 `1.3.2`（成就图标归一化）+ 安卓端 `1.3.2+3`。安装包版本号只影响 App，不影响任何 HTTP 契约 |

---

## 1. 三端一致性

| 维度 | 结论 |
| --- | --- |
| HTTP 接口 | **零改动**：仍只用 `GET /api/games`（含 `sort=custom`）、`PUT /api/games/order`、`GET /api/games/:id`、`GET /api/stats`、`PATCH /api/games/:id`（`posterMode`）等既有端点与既有 DTO |
| 数据库 | **零改动**：只读服务端数据；排序落库继续走服务端 `custom_order`（`ORDER_GAP = 1024`） |
| 排序数据 | 与 Web 端**同一份**：`PUT /api/games/order` 的 `afterId` = 结果里排在拖动卡上方的邻居、`beforeId` = 下方的邻居。手机端提交的邻居语义与 Web 端 `Home.tsx:149-177` 完全一致 ⇒ 两端互相能看到对方的排序，重启不丢（顺序在服务端） |
| 轮播状态 | 与 Web 端**同一份**：内容 = `[posterUrl, ...posters]` 去重（`cardPosterSources`，媒体帧 `/preview` → `/thumbnail`），开关 = `posterMode`（`static` / `slideshow`）。手机端只读，不写 |
| 卡片视觉 | 海报区 16:9（Web `aspect-video`）、横版铺满、竖版居中裁切（Web `object-cover object-center`）；首页卡片不显示底部圆点（Web `showDots={false}`） |
| 既有功能 | 整卡点击进详情、长按拖拽、下拉刷新、平台 / 排序切换、预加载窗口、图片鉴权缓存（`AuthedImage`）行为不变，均有测试覆盖 |

---

## 2. ① 卡片海报区 16:9（原来被拉成竖长条）

**根因**：`home_screen.dart` 的 `_childAspectRatioFor` 按「海报 2:3」估算格子高度
（旧式：`cellHeight = cellWidth * 1.5 + infoHeight`，结果夹在 `0.40 ~ 0.62`），而 `GameCard` 内部**根本没有
`AspectRatio`** —— 海报区高度由外层格子高度倒推，于是被拉伸成竖长条，与 Web 端 `aspect-video` 完全不同。

**修法**（由海报区反推格子高度，而不是相反）：

```dart
// GameCard 新增常量（与 Web 端 aspect-video 同规格）
static const double posterAspectRatio = 16 / 9;

// home_screen.dart::_childAspectRatioFor
final double posterHeight = cellWidth / GameCard.posterAspectRatio;
final double cellHeight = posterHeight + infoHeight;
return (cellWidth / cellHeight).clamp(_kMinAspectRatio, _kMaxAspectRatio);
// _kMinAspectRatio = 0.55（极窄屏兜底）、_kMaxAspectRatio = GameCard.posterAspectRatio
```

- 卡片里海报区现在真的是 `AspectRatio(aspectRatio: posterAspectRatio, child: _PosterSlideshow(...))`，
  外层只负责给宽，高度由 16:9 决定 ⇒ Web / 安卓海报框尺寸比例一致。
- 横版海报铺满、竖版海报由 `BoxFit.cover` **居中裁切**（绝不拉伸），与 Web `object-cover object-center` 同语义。
- 实测格子长宽比：360dp / 2 列 ≈ 0.97，600dp / 3 列 ≈ 1.03，1000dp / 4 列 ≈ 1.11（夹取上限不会触发）。
- 顺带给每张卡片加了 `key: ValueKey<String>(game.id)`：排序变化后卡片状态不会跟错游戏。

---

## 3. ② 自定义拖拽排序「能拖但松手不生效」

**根因（1.3.1 的真凶，之前没跑过拖拽路径）**：`_buildDraggableCell` 的 `onWillAcceptWithDetails` 里做了
`context.findRenderObject() as RenderBox?`。itemBuilder 的 `BuildContext` 属于 `GridView` 的 sliver 元素，
拿到的其实是 `RenderSliverGrid`，强转立刻抛：

```
type 'RenderSliverGrid' is not a subtype of type 'RenderBox?'
#0 _HomeScreenState._hoverRightHalfFor (home_screen.dart:625)
#4 _DragTargetState.didEnter (drag_target.dart:733)
#7 _DragAvatar.updateDrag (drag_target.dart:897)
```

异常发生在手势回调里，**指针一进入任何卡片就抛** ⇒ `DragTarget` 进不了 entered 态、框架里
`_activeTarget` 恒为 `null` ⇒ 松手既不重排、也不显示插入指示条 —— 与用户看到的「可拖动、但松手后位置不更新」
完全吻合。（框架顺序是 `didDrop` → `onDragEnd`，所以「onDragEnd 把 hover 状态清了」并不是原因。）

**修法（三层兜底，任一命中即提交）**：

1. **落点由网格几何反推**：`_cellRectFor(int index)` 用网格自己的 `_gridKey`（这个 `RenderBox` 强转是安全的）
   按 `_cellWidth` / `_cellHeight` / `_kGridSpacing` / `_kGridPadding` / `_scrollOffset` 算出该格矩形；
   `_dropCellFrom(Offset global)` 把它反过来用：由落点算「第几列、第几行、格内左半还是右半」。
   per-item 的 `BuildContext` 再也不碰。
2. **以被接受的 DragTarget 的下标为准**：`onAcceptWithDetails` 用闭包里的 `index` + 松手点的左右半
   （`_rightHalfOfCell`），不再读易失的 `_hoverIndex`。
3. **空隙兜底**：新增 `onDragUpdate` 记录指针真实全局坐标；`onDragEnd` 在「落点没被任何 DragTarget 接受」时
   （两格之间 12px 间隙、网格 16px 留白、落回自身）按指针所在格提交 —— 与 Web 端网格层
   `onDragOver` + `preventDefault` 兜住空隙落点是同一语义（`web/src/pages/Home.tsx:307-314`）。
   `_dropHandled` 标记保证不会重复提交。

**另外修掉一个「回弹闪动」**：`_onReorder` 成功分支原来在 `PUT` 返回后立刻清掉本地乐观顺序，但
`invalidate(gamesProvider)` 之后 provider 会先用旧数据渲染一帧（`AsyncValue` 的 `skipLoadingOnRefresh`）⇒
卡片先弹回原位、下一帧再跳到新位。现在改为「服务端返回的 id 序列追平本地才退休」
（`_sameIdOrder(a, b)`），失败时仍回滚并弹「排序同步失败」提示。

**邻居语义（与 Web 端逐字对齐，传反会 500）**：`afterId` = 结果里排在拖动卡**上方**的邻居、
`beforeId` = **下方**的邻居。

---

## 4. ③ 卡片轮播：数据同步 + 左右滑动

**数据侧根因**：模型层**完全不解析** `posterMode`（`GameSummary` 里根本没这个字段，只有测试夹具里有），
所以无论 Linux / Web 端怎么开「首页卡片轮播」，手机端都只显示静态封面。

**修法**：

- `GameSummary` 增加 `posterMode`（缺省 `'static'`，来自 `GET /api/games` 的 DTO）与
  `slideshowEnabled => posterMode == 'slideshow'`。
- 首页在这些时机重取列表：**回到前台**（`ref.listen(isForegroundProvider)`）、下拉刷新、切页返回
  （`gamesProvider` 是 autoDispose family）、以及停留期间的 **30 秒静默轮询**（`_kSyncInterval`；
  只在应用前台、非快速滚动、首页是当前路由时才发请求，避免后台耗电与无谓流量）。
- 交互：`slideshow` 且海报 ≥ 2 张时建 `PageView` —— **左右滑动切上一张 / 下一张**，左右回环
  （与 Web 箭头 `(i + delta + count) % count` 同语义）；每 **3500 ms** 自动翻页（同
  `web/src/lib/hooks.ts:38-57`）；手动切图后静默约 2 个间隔再恢复（同 Web
  `resumeAt.current = Date.now() + intervalMs * 2`，实现为「跳过 N 次 tick」，不依赖墙钟，设备休眠唤醒也稳）；
  左上角常显「当前张 / 总张数」计数徽章；手指按住期间不翻页、卡片滚出屏幕不翻页、离屏不挂定时器。
- **1.3.1 的滑动其实是死的**：海报区最上层那层
  `Positioned.fill(GestureDetector(behavior: HitTestBehavior.opaque))` 会终止命中测试，`PageView` 收不到指针
  事件（该层在 1.3.1 未经真机验证）。该层已删除；整卡点击继续由外层 `Card > InkWell(onTap)` 承担，
  「点海报区进详情」有测试保护。底部圆点也删了（对齐 Web 首页卡 `showDots={false}`）。

---

## 5. 与 Web 端的逐条对照

| 规格 | Web（基准） | 安卓 `1.3.2+3` |
| --- | --- | --- |
| 海报框比例 | `GameCard.tsx:157` `aspect-video`（16:9） | `GameCard.posterAspectRatio = 16 / 9` + `AspectRatio` |
| 填充方式 | `object-cover object-center` | `BoxFit.cover`（居中裁切，不拉伸） |
| 海报集合 | `[game.posterUrl, ...game.posters]` 去重，`/preview` → `/thumbnail` | `api.cardPosterSources(game)`（同规则，1.3.1 已实现） |
| 轮播开关 | `posterMode === 'slideshow'` | `game.slideshowEnabled` |
| 自动间隔 | `intervalMs = 3500` | `_kRotationInterval = 3500ms` |
| 手动切换后静默 | `resumeAt = now + intervalMs * 2` | `_kManualSkipTicks = 1` ⇒ 跳过 1 次 tick（等价 2 个间隔） |
| 手动切换方式 | 左右箭头按钮（触屏无） | **左右滑动**（触屏语义，回环） |
| 计数徽章 | `browsable` 即显示 `{i+1}/{count}`（`PosterCarousel.tsx:165-170`） | 仅 `slideshow && 海报 ≥ 2` 时显示（见下） |
| 底部圆点 | 首页卡 `showDots={false}` | 不显示（对齐） |
| 排序落库 | `PUT /api/games/order`，`afterId` 上方 / `beforeId` 下方 | 同（含空隙兜底） |
| 列表刷新 | react-query 失效重取 | 前台恢复 / 下拉刷新 / 返回首页 / 30 秒轮询 |

**一处有意差异**：计数徽章手机端只在「`slideshow` 且海报 ≥ 2 张」时显示，Web 端对 static 多海报卡也显示计数。
触屏没有箭头、没有悬停，一个翻不动也点不动的计数器看起来像 bug，故手机端不显示。
（如果希望完全一致，把 `game_card.dart` 里 `Stack` 的计数徽章条件由 `slideshow` 改成 `urls.length > 1` 即可。）

---

## 6. 离线验证（本轮实测）

```bash
cd flutter
source /tmp/sp-android/env.sh   # 本机 Flutter 3.24.5 / JDK 17 / SDK 34
flutter analyze                 # 0 error / 0 warning（8 条既有 info）
flutter test                    # 52 项通过 / 1 项跳过 / 0 失败
cd .. && bash scripts/verify-suites.sh          # 19 项通过 / 0 项失败（当时）
node scripts/gen-source-hash.mjs --check        # ✓ 521c4985d95f713c（137 文件，本轮未变）
```

> 上面两行是**本轮发布时的现场值**：`verify-suites.sh` 当时 19 项、指纹 `521c4985d95f713c`。
> 同日稍后的 **Windows 桌面端 1.3.2 轮次**改了 `web/src`（登录页「创建账户」）与 `backend/src`
> （`AUTH_ALLOW_SETUP`），所以现在 `--check` 期望 **`f9864755a02c7576`**、套件为 **20 项**
> —— 这不影响本轮三个 APK（安卓端不打包 `web/src`，服务端接口形状未变）。

- 新增 9 条用例（`1.3.1+2` 为 43 通过 + 1 跳过）：
  - `flutter/test/home_reorder_test.dart`（3 条）：①拖到卡片 C 右半 → 立刻乐观重排（`A.left > C.left`）
    且只提交一次 `{gameId:'g1', afterId:'g3', beforeId:'g4'}`，服务端顺序回来后**不回弹**；
    ②拖到两行之间的 12px 间隙 → 照样提交 `{gameId:'g6', afterId:'g1', beforeId:'g2'}` 并落成
    `[g1,g6,g2,g3,g4,g5]`（**修复前静默失效的现场**）；③海报区 `AspectRatio` = 16:9。
  - `flutter/test/game_card_carousel_test.dart`（6 条）：static 模式无 `PageView` 与计数；slideshow 左右
    滑动切图并显示 `2/3`；3500 ms 自动翻页（再一个间隔到 `3/3`）；手动切图后静默 2 个间隔；
    点海报区仍触发整卡 `onTap`；海报区 16:9。
- 全量回归不影响既有功能：`flutter test` 其余 43 条（含 `game_card_tap_test.dart` 的整卡点击 / 拖拽不误触）
  与 `scripts/verify-suites.sh` 的 19 套后端 + Web 套件全部通过。

### 产物（`flutter/dist/`）

| ABI | 文件 | 字节 | SHA-1 | `versionCode` |
| --- | --- | --- | --- | --- |
| arm64-v8a | `app-arm64-v8a-release.apk` | 21,243,136 | `e4d0629206b0b981a7fcd82a7c4b9d3e0e168b4b` | 2003 |
| armeabi-v7a | `app-armeabi-v7a-release.apk` | 18,816,470 | `662580dfac8170a12bdc2c2ac3f47f5e95d7fb1d` | 1003 |
| x86_64 | `app-x86_64-release.apk` | 22,427,527 | `53c329fdfdb1b51f848caf36d1ed2fbdbe2fdf7a` | 4003 |

- 三个包 `versionName` 都是 `1.3.2`，`minSdk 28` / `targetSdk 34`；`apksigner verify` 退出码 0，
  证书仍是 debug keystore（SHA-256 `9a1a9443…597fe3`，与 `1.3.1+2` 同一把）。
- 每个 `.apk` 旁有同名 `.sha1`（40 位哈希 + 换行）：`sha1sum -c` 或直接比对上面的值。
- 打包命令（本机）：`source /tmp/sp-android/env.sh && cd flutter && flutter build apk --release --split-per-abi`。

---

## 7. 真机验收清单（待用户设备执行）

1. **比例**：首页任意屏宽下海报完整显示、卡片为横向 16:9，与 Web 端同款观感；竖版海报居中裁切、不拉伸。
2. **拖拽排序**：选「自定义排序」→ 长按卡片拖动，拖动过程中目标位置有插入指示条；**松手即生效**
   （不必等网络），松手后列表顺序立即更新；**杀掉 App 重开**顺序仍是刚才那套（顺序在服务端）；
   在 Web 端刷新首页 → 看到同一套顺序；反向亦然（Web 端拖完，手机端下拉刷新 / 回到前台即同步）。
3. **轮播数据同步**：在 Linux / Web 端给某游戏开「首页卡片轮播」并勾选 ≥ 2 张海报 → 手机端回到前台
   或下拉刷新后，该卡片开始每 3.5 秒自动翻页；在 Web 端关掉开关 → 手机端该卡片回到单张静态封面。
4. **轮播交互**：在开启轮播的卡片上左右滑动能切上一张 / 下一张（回环）；切完手指离开约 7 秒内不再自动
   翻页（与 Web 端「手动操作后停两个间隔」一致）；此时**轻点海报区仍能进详情**（滑动不误触发点击）。
5. **既有功能**：下拉刷新、平台切换、排序切换、图片鉴权加载（海报不裂图）、详情页成就图标正常。

---

## 8. 已知的有意差异与后续可选项

- 见 §5 的计数徽章差异（有意）。
- 若日后要「完全等同 Web」，可选加：卡片轮播的左右箭头（触屏通常不需要）、计数器对 static 多海报卡也显示、
  下拉刷新时的骨架屏。
- 说明：`release` 变体目前仍用 **debug keystore** 签名（可侧载、不可上架），与 1.3.1 首发一致；
  正式发布需在 `android/app/build.gradle` 补 `signingConfigs.release`。