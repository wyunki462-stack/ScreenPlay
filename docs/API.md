# ScreenPlay API Reference

Base URL: `http://<host>:<port>` — all JSON endpoints are under `/api`, media
files are streamed under `/api/media`.

All responses are JSON unless otherwise stated. Dates use ISO-8601 UTC strings.
Durations are seconds (number) plus a pre-formatted `*Text` field for display.

---

## Model shapes

### GameSummary
```ts
{
  id: string;                 // game id
  name: string;               // normalized display name
  platform: string | null;    // detected platform (PC/PS5/Xbox/...)
  posterUrl: string | null;   // poster/cover thumbnail url
  mediaCount: number;         // number of media files in the folder
  durationSeconds: number;    // real-world completion duration (max-mtime - min-ctime)
  durationText: string;       // e.g. "3天 12小时"
  metacriticScore: number | null;
  firstPlayedAt: string | null; // ISO
  lastPlayedAt: string | null;  // ISO
}
```

### Media
```ts
{
  id: string;
  gameId: string;
  fileName: string;
  type: "image" | "video" | "gif";
  mimeType: string;
  width: number | null;
  height: number | null;
  sizeBytes: number;
  createdAt: string;            // ISO (file creation time)
  durationSeconds: number | null; // videos only
  streamUrl: string;            // /api/media/:id/stream  (Range supported)
  thumbnailUrl: string;         // /api/media/:id/thumbnail
  coverUrl: string | null;      // video cover (same-name image or extracted frame)
}
```

### Achievement
```ts
{
  id: string;                    // `${gameId}:${source}:${externalId}`
  gameId: string;
  name: string;
  description: string | null;
  iconUrl: string | null;
  globalPercent: number | null;  // global unlock rate (%)
  tier: 'platinum' | 'gold' | 'silver' | 'bronze' | null;  // trophies only
  rarity: string | null;         // e.g. 极为珍贵 / 非常珍贵 / 珍贵 / 一般
  source: 'steam' | 'psnine' | string;
  unlocked: boolean;
  sortOrder: number;
  dlcAppId: number | null;       // Steam DLC achievements
  dlcName: string | null;
}
```

### AchievementsPayload
Returned by the achievements endpoints — a list plus a screen-ready summary.
```ts
{
  items: Achievement[];          // ordered by sortOrder, then name
  counts: { platinum: number; gold: number; silver: number;
            bronze: number; total: number };
  status: 'ok' | 'empty' | 'pending' | 'failed' | 'unsupported';
  error: string | null;          // human-readable reason when status is not ok
  source: string | null;         // e.g. 'psnine'
}
```

`status` is never silently blank: `failed` carries the provider's reason,
`unsupported` means no achievement source applies to this game's platforms, and
`pending` means it has not been scraped yet. The UI renders each case explicitly.

`error` is **for the logs and for troubleshooting, not for the screen**: it names
the upstream site and quotes the raw failure. The 「成就」 tab deliberately ignores
it and shows one fixed message instead (「加载成就失败」 + 「当前游戏成就数据暂不可用，
请尝试手动选择游戏或稍后重试」), so the user is never asked to interpret a site name
they cannot act on.

### AchievementTarget
A hand-picked achievement/trophy entry, stored in the `achievement_links` table.

```ts
{
  gameId: string;
  source: string;        // 'steam' | 'psnine'
  externalId: string;
  name: string | null;
}
```

It lives in its own table rather than in `game_links` on purpose: `game_links` is
rewritten by the automatic matcher on every provider fetch, so an auto-match would
silently overwrite the user's explicit choice.

### Rating
```ts
{
  source: "metacritic";
  metascore: number | null;       // 0-100
  criticCount: number | null;
  userScore: number | null;       // 0.0-10.0
  userCount: number | null;
  ratingClass: string | null;     // "universal acclaim" etc.
}
```

### MediaReview（媒体评价）
```ts
{
  id: string;
  gameId: string;
  source: string;                 // "metacritic"
  outlet: string;                 // 媒体名称，例如 "IGN"
  score: number | null;           // 该媒体的打分，0-100（未打分时为 null）
  verdict: string | null;         // 没有数字分数时的文字判定，例如 "Mixed"
  text: string | null;            // 媒体评价原文（截断到 1200 字）
  url: string | null;             // 该媒体原文链接
  author: string | null;          // 评论作者
  platform: string | null;        // 该评价对应平台
  publishedAt: string | null;     // 发布日期
  fetchedAt: number;              // 抓取时间（epoch ms）
}
```

### MediaReviewsSummary（媒体评价的抓取状态）
```ts
{
  status: "ok" | "empty" | "failed" | "unsupported" | null;
  error: string | null;           // status 为 failed/unsupported 时的原因，直接展示给用户
  fetchedAt: number | null;       // 最近一次抓取时间（epoch ms）
  sourceUrl: string | null;       // 数据来源页面（面板上的「数据来源」链接）
  count: number;                  // 当前库里的评价条数
}
```

`status` 的四态是这一块的**关键设计**，因为「面板为什么是空的」有四种完全不同的
答案，而用户需要做出不同的动作：

| status | 含义 | 界面表现 |
| --- | --- | --- |
| `null` | 从未抓取过（老数据，或数据源未启用） | 「暂无媒体评价」+ 提示去点补全 |
| `ok` | 最近一次抓取拿到了评价 | 正常列表 |
| `empty` | **抓到了页面，但页面里确实没有评价** | 「暂无媒体评价」+ 说明数据源没有收录 |
| `failed` | 抓取失败（403 / 限流 / 不可达） | 「抓取失败：<原因>」+ 提示重试是安全的 |
| `unsupported` | 还没有可抓取的条目：游戏没绑定评价站条目（`未绑定媒体评价站条目`），或绑定后在该站找不到对应条目 | 「未找到对应条目」+ 提示去「手动匹配」 |

其中 `empty` 与 `failed` 的区分最重要：合并成一个「暂无数据」会让用户在一个只是
**需要代理**的环境里以为功能坏了。

`unsupported` 与 `failed` 的区分同样重要：前者重试永远不会成功（要做的是去
「手动匹配」），后者值得重试。因此 `unsupported` 也会被记进 `reviews_status`
（与成就/奖杯的处理口径一致），计入覆盖率卡片的「待补全」，
但重试时**不发网络请求**——绑定判断排在抓取之前。

### Price
```ts
{
  source: "steam";
  currency: string | null;
  currentPrice: number | null;    // in currency units (e.g. USD)
  initialPrice: number | null;
  discountPercent: number | null;
  historicalLow: number | null;
  lastUpdated: string | null;
}
```

### GameDetail (extends GameSummary with full data)
```ts
{
  ...GameSummary,
  folderName: string;
  folderPath: string;
  aliases: string[];
  summary: string | null;          // IGDB/HLTB description
  developers: string[];
  publishers: string[];
  releaseDate: string | null;      // ISO date
  voiceActors: string[];
  screenshots: string[];           // poster/screenshot urls (max ~5)
  youTubeTrailers: string[];       // urls (optional)
  mainStoryHours: number | null;   // HLTB main story (hours)
  mainPlusExtraHours: number | null;
  completionistHours: number | null;
  ratings: Rating[];
  mediaReviews: MediaReview[];            // 「媒体评价」标签页的数据
  mediaReviewsSummary: MediaReviewsSummary;
  prices: Price[];
  achievements: Achievement[];
  timeline: TimelineEvent[];
  cachedAt: string | null;
  lastMetadataRefresh: string | null;
}
```

### TimelineEvent
```ts
{
  date: string;             // ISO
  type: "first_media" | "last_media" | "milestone" | "note";
  title: string;
  description: string | null;
}
```

---

## Endpoints

### `GET /api/health`
Liveness/readiness probe.
```json
{
  "status": "ok",
  "uptime": 123.4,
  "version": "0.1.0",
  "buildTime": "2026-09-29T05:00:00Z",
  "features": [
    "game-neighbors", "duration-backfill", "scraped-posters-all",
    "duration-cache-guard",
    "hero-poster-carousel", "duration-coverage-api", "duration-backfill-ui",
    "card-rotation-user-ticks", "card-rotation-cover-always",
    "card-rotation-user-decided", "hero-rotation-all-official",
    "card-carousel-vs-hero-carousel",
    "review-pagination", "poster-config-protected",
    "card-carousel-no-dots", "album-frame-removable",
    "review-paged-ui", "boot-purge-logged",
    "media-reviews-api", "media-reviews-ui", "media-reviews-coverage-api",
    "password-change-api", "password-change-ui"
  ]
}
```

`features` 是**部署新鲜度**的判据：镜像里的后端 `dist/` 与前端 `public/` 都可能被
旧产物覆盖，而这个列表一定跟着镜像走。部署后先跑一次：

```bash
curl -s http://<主机>:3001/api/health | grep -o 'card-rotation-user-ticks'
```

看不到 `card-rotation-user-ticks` / `card-rotation-cover-always` /
`card-rotation-user-decided` / `hero-rotation-all-official` / `review-pagination` /
`poster-config-protected`
就说明跑的还是旧镜像，需要重新 `docker compose build && docker compose up -d`。

> 两套轮播职责拆分后，`poster-rotation-all-games` / `poster-rotation-cover-only` /
> `poster-rotation-user-decided` 几个旧标记已退役，由 `card-rotation-user-ticks` /
> `card-rotation-cover-always` / `card-rotation-user-decided` / `hero-rotation-all-official`
> 取代（`card-carousel-vs-hero-carousel` 保留，含义更新为「首页卡片 = 封面 + 勾选集；
> 详情页大图 = 全部官方海报」）。改密的两个标记是 `password-change-api` / `password-change-ui`。

同理，看不到 `media-reviews-api` 就说明镜像里还没有「媒体评价」这一块。
早先占位的 `critic-reviews` 从未实现，已由上面三个按交付面拆分的名字取代。

界面细节三则（第六轮）各有一个标记，用来区分「后端新了、前端还是旧的」这种最容易
误判的情况 —— 这三项都在前端产物里：

| 标记 | 对应界面行为 |
| --- | --- |
| `card-carousel-no-dots` | 首页卡片轮播不再显示底部圆点（详情页大图仍保留） |
| `album-frame-removable` | 相册截图可逐张「取消展示」，删完可从相册重新添加 |
| `review-paged-ui` | 媒体评价默认 5 条 / 展开 10 条 / 每页最多 10 条 |
| `boot-purge-logged` | 启动期清理数量会写进日志（此前 `purged` 漏进日志条件，清理生效却报 nothing to repair） |

### `POST /api/library/scan`
Trigger a (re)scan of configured media directories. Scans are idempotent and
run asynchronously; returns immediately.
```json
{ "started": true }
```

### `GET /api/library/status`
```json
{ "scanning": false, "lastScanAt": "ISO", "totalGames": 3, "totalMedia": 152 }
```

### `GET /api/games`
Query params (all optional):
- `search=<text>` — fuzzy name search
- `platform=<text>` — platform filter
- `sort=name|created|duration|mediaCount|metacritic` (default `name`)
- `order=asc|desc` (default `asc`)
- `yearMin`, `yearMax` — release year range
- `minScore`, `maxScore` — metacritic range

Returns `GameSummary[]` (mediaCount/duration included, no heavy fields).

### `GET /api/games/:id`
Returns `GameDetail`. On first request, lazily fetches metadata from configured
providers (cached per the TTL rules).

### `PATCH /api/games/:id`
Body: `{ "name": "corrected name", "platforms": ["PlayStation 5"], "posterMode": "slideshow" }`
— manually override the matched name, the play platforms (multi-select) and the
**首页卡片轮播**模式（`posterMode`：首页图库卡片是否自动切换封面并显示左右箭头；
**不影响详情页大图区**，后者恒定自动轮播全部官方海报）。Re-running a scan will not overwrite manual fixes.
Passing `platforms: []` clears the override and restores the auto-detected value.

### `POST /api/games/:id/refresh`
Force refresh metadata from all providers (bypasses cache).
Body optional: `{ "providers": ["igdb","hltb","steam","metacritic"] }`.
Returns `{ "refreshed": true }`.

### `GET /api/games/:id/media`
Returns `Media[]` for a game, sorted by creation time ascending.

### `GET /api/achievements/:gameId`
Returns an `AchievementsPayload` (see above) — the items plus the per-tier
`counts`, `status`, `error` and `source` the detail page's 「成就」 tab renders.

### `POST /api/games/:id/achievements/refresh`
Re-scrapes this game's achievements/trophies regardless of freshness, then
returns the new `AchievementsPayload`. Steam achievements come from
`api.steampowered.com`; PlayStation trophies from a public Chinese trophy site
(psnine) when the game's platforms include a PlayStation one.

When the game has a hand-picked target (see the `/target` endpoints below) that
choice wins: the scrape uses the chosen entry, the platform gate is skipped, and
the achievements written by automatic matching are ignored — so a full scrape can
never quietly undo the user's selection.

### `GET /api/achievements/:gameId/candidates?q=`
Searches **every** achievement source at once and returns one uniform list, backing
the detail page's 「手动选择游戏」 picker.

```ts
{
  items: {
    source: string;        // 'steam' | 'psnine'
    sourceLabel: string;   // display name, e.g. 'PSNINE（PSN中文站）'
    externalId: string;    // appid, or the site's numeric game id
    name: string;
    platform?: string | null;
    releaseYear?: number | null;
    detail?: string | null;  // disambiguator, e.g. 'appid 220'
  }[];
  target: AchievementTarget | null;   // what is currently hand-picked
}
```
A source that fails contributes nothing rather than failing the search, and an empty
`q` returns an empty list without touching the network.

### `PUT /api/achievements/:gameId/target`
Body `{ source, externalId, name? }`. Saves the hand-picked target **and re-scrapes
immediately**, returning the fresh `AchievementsPayload` — so the tab updates in one
round trip. The choice is persisted in `achievement_links`, which means later full
scrapes (`POST /api/games/refresh-all`) and single-game refreshes
(`POST /api/games/:id/refresh`) all reuse it instead of reverting to automatic
matching.

### `DELETE /api/achievements/:gameId/target`
Drops the manual choice and clears the recorded status, returning the game to
automatic matching. Returns the current `AchievementsPayload`.

### `GET /api/achievements/:gameId/target`
Returns `{ target }` — the saved choice, or `null` when the game is on auto. The
picker uses it to show what is currently selected.

### `GET /api/settings/test-steam-achievements?appid=620`
Diagnostic for the Steam achievement API specifically. Achievement data lives on
`api.steampowered.com`, which is a **different host** from the
`store.steampowered.com` host used for covers and prices — so metadata can work
perfectly while achievements return nothing. Returns `{ ok, message, detail }`
with an actionable reason (a rejected key reports the HTTP status and the key
length; an unreachable host suggests configuring a proxy).

### `GET /api/games/platforms`
Returns `[{ value, count }]` — distinct platforms for the gallery filter
dropdown. Counts include user-set platforms (feature 6).

### `GET /api/library/roots`
Returns every configured media library root (both `env` from `MEDIA_DIRS` and
`user` rows added from the web UI).

### `GET /api/library/roots/check?path=`
Validates a path before saving: existence, readability, subdirectory count and
sample folder names, plus a mount hint when the path is not visible in the
container. Never throws for a bad path — inspect `ok` and `message`.

### `GET /api/library/roots/mounted`
Returns `{ "paths": [...] }` — directories already mounted inside the container,
used to suggest valid paths in the UI.

### `GET /api/library/roots/browse?path=`
Read-only, single-level directory listing powering the “浏览…” folder picker.
Only subdirectories are returned (files, hidden dot-directories and OS noise such
as `$RECYCLE.BIN` are filtered out); at most 2000 entries per level.

Returns
`{ ok, path, parent, entries: [{ name, path, isDirectory }], roots: [{ label, path }], exists, readable, message }`.
`parent` is the parent directory when it is still inside the allow-list, else
`null`. `roots` lists the allowed top-level shortcuts. Omitting `path` (or passing
an empty string) starts at the first allowed root.

Access is restricted to an allow-list: `LIBRARY_BROWSE_ROOTS` (comma separated)
when set, otherwise the configured media roots plus the usual mount points
(`/media /mnt /vol2 /home`, or drive letters on Windows). Symlinks are resolved
before the check. Bad input / disallowed / missing / unreadable paths never throw
— they return `ok: false` with a Chinese `message`.

### `POST /api/library/roots`
Body: `{ "path", "label"?, "mediaType"?: "auto"|"image"|"video", "recursive"?, "enabled"?, "scan"? }`.
Adds a library root. With `scan: true` (default) a scan starts immediately, so
the new library takes effect without rebuilding the container.

### `PATCH /api/library/roots`
Body: same fields plus `"id"`. Edits an existing root (works for `env` roots too,
which can be disabled but not deleted).

### `DELETE /api/library/roots?id=`
Removes a user-added root. Returns `400` for `env:` ids, because those come from
`MEDIA_DIRS` and must be changed in `docker-compose.yml`.

### `GET /api/games/:id/posters`
Returns `Poster[]` for a game, selected one first.

### `POST /api/games/:id/posters/upload`
`multipart/form-data` with field `file` (≤20MB). Stored under `DATA_DIR/posters`
and normalised to WebP.

### `POST /api/games/:id/posters/from-media`
Body: `{ "mediaId" }` — reuse one of the game's album images as a poster.

### `POST /api/games/:id/posters/select`
Body: `{ "posterId" }` — choose the gallery cover. Mirrored onto
`games.poster_url` so cards and the detail header update together.

### `POST /api/games/:id/posters/clear-selection`
取消封面并恢复默认。清除全部 `is_selected` 标记后，优先选中该游戏的**官方刮削海报**；
若没有官方海报则回退到本地首图。**只清标记、不删除任何海报记录与文件**，
三种来源（官方 / 上传 / 相册）均可取消。

```bash
curl -X POST http://127.0.0.1:3001/api/games/<gameId>/posters/clear-selection
# → {"selected":"<official-poster-id>",
#    "posterUrl":"https://media.rawg.io/...",
#    "restored":"<原封面海报id，供界面提示用>"}
```

注意：若封面**本来就是官方海报**，取消后选中的仍是它——「取消」的语义是撤销用户的自定义选择，
而不是让游戏没有封面。界面通过 `isCover` 区分这两种情况并隐藏该入口，所以不会出现「点了没反应」。

### `POST /api/games/:id/posters/reconcile`
修复「`games.poster_url` 已设置，但没有任何海报行 `is_selected=1`」的历史状态
（生产库 39 个游戏中有 34 个如此，导致界面看不到取消封面入口）。
读取海报列表时**自动执行**，此端点供批量修复使用。幂等，且只提升 URL 与当前封面一致的那一行，
不会改变实际显示效果。

```bash
curl -X POST http://127.0.0.1:3001/api/games/<gameId>/posters/reconcile
# → {"repaired":true}   // 本次是否修复
```

### `PATCH /api/games/:id/posters/:posterId`
Body: `{ "inSlideshow": boolean }` — 是否把这张海报勾选进**首页卡片**轮播集合。
它**不影响详情页大图区** —— 大图区恒定自动轮播全部官方海报（`source` 为 `scraped` / `upload`，
不含 `media` 相册截图），与这里的勾选无关。

### `DELETE /api/games/:id/posters/:posterId`
Removes a poster (and its uploaded file); promotes the next one if it was the
selected cover.

### `GET /api/posters/:posterId/image`
Serves an uploaded poster image (WebP, cacheable).

### `GET /api/stats`
```json
{
  "totalGames": 3,
  "totalMedia": 152,
  "totalImages": 140,
  "totalVideos": 12,
  "totalSizeBytes": 10485760,
  "totalPlayTimeSeconds": 123456,
  "platforms": { "PC": 2, "PS5": 1 }
}
```

---

## Media streaming endpoints

### `GET /api/media/:id/stream`
Serves the original media file. Supports HTTP `Range` requests (required for
video scrubbing). Returns 206 Partial Content with `Content-Range`,
`Accept-Ranges: bytes`.

### `GET /api/media/:id/thumbnail`
Serves the cached thumbnail. For videos returns the cover frame (same-name image
or extracted first frame). JXR sources are decoded server-side and output as
WebP.

返回 `Cache-Control: public, max-age=2592000, immutable`：缩略图一旦生成内容即固定，
浏览器可长期复用。此前缺少该头，导致每次打开「编辑海报」都要重新下载整屏缩略图。
`/api/media/:id/cover` 同样带此头。

### `GET /api/media/:id/cover`
Video cover image (same-name sibling image or first-frame extraction), WebP.

### `GET /api/media/:id/preview`
Browser-safe full-size image. JXR/WDP/HD Photo sources are decoded server-side
and returned as WebP (`415` when the variant cannot be decoded); other formats
are passed through unchanged. Use this for lightboxes and "view original".

### `GET /api/media/:id/original`
Forces serving the original bytes (for "view original" in the image viewer),
with correct `Content-Type`.

### `DELETE /api/media/:id`
删除一个媒体（安卓端相册「长按删除」同步到服务端）。一次请求会清掉：
`media` 索引行、库根目录里的**原图**、`DATA_DIR` 下的**缩略图**（含 JXR 变体）/
**封面** / **预览**缓存，以及 `game_posters` 中指向该媒体的**悬空海报引用**；
若该媒体正是游戏封面，会按海报删除的同一规则提升下一张海报，否则回退到该游戏
仍在库中的首张本地图片（不会留下 404 的 `poster_url`）。

```bash
curl -b /tmp/sp.jar -X DELETE http://127.0.0.1:3001/api/media/<id>
# → {"ok":true,"id":"<id>","deleted":true,
#    "removedFiles":5,"postersRemoved":1,"originalSkipped":false}
```

| 字段 | 说明 |
| --- | --- |
| `ok` / `deleted` | 成功恒为 `true` |
| `removedFiles` | 真正从磁盘删除的文件数（原图 + 缓存，静默忽略删除失败） |
| `postersRemoved` | 被一并清掉的悬空 `game_posters` 行数 |
| `originalSkipped` | 原图 `file_path` 不在任何库根目录（`library_roots` / `MEDIA_DIRS`）之下时为 `true`，跳过删除以防 `../` 逃逸 |

`404`：该 `id` 在 `media` 表中不存在（重复删除也返回 404）。

**鉴权**：与其它 `/api/*` 一致，仅在 `/api/auth/*` 与 `/api/health` 之外受全局会话守卫。
带凭证（Linux/Web 端会话 Cookie 或 `Authorization: Bearer`）才能删。自 `1.3.2` 起，Windows 桌面端
默认 `host=0.0.0.0`（局域网可访问）+ `auth=local`，**首次启动在网页里创建账户**，删除同样需要凭证
（只有同时把 `host` 改回 `127.0.0.1` 并设 `auth=off`，`AUTH_DISABLED=1` 才会生效、无凭证放行）。

---

## Error format
```json
{ "statusCode": 404, "message": "Game not found", "error": "Not Found" }
```

Standard HTTP codes: 400 (bad request), 404 (not found), 500 (server error),
429 (external provider rate-limited — retried internally).

### POST /api/games/backfill-ratings

**批量补全媒体评价。** 同步执行、返回逐游戏结果。

请求体（全部可选）：

```jsonc
{
  "scope": "missing",   // missing（默认）| all
  "limit": 0            // >0 时只处理这么多款游戏；0/省略 = 不限制
}
```

| `scope` | 处理哪些游戏 |
| --- | --- |
| `missing`（默认） | 还没有任何评价的游戏，**加上**上次抓取失败的游戏。已抓到评价和确认「数据源没有收录」的都不会重复访问 |
| `all` | 全部游戏。解析器修好之后用它修复「抓过了但没解析出评价」的存量数据 |

响应：

```bash
curl -X POST http://127.0.0.1:3001/api/games/backfill-ratings \
     -H 'content-type: application/json' -d '{"scope":"missing"}'
```
```json
{
  "processed": 38,
  "gained": 31,
  "reviewsStored": 268,
  "failed": 4,
  "skipped": 3,
  "remaining": 3,
  "total": 41,
  "results": [
    { "id": "…", "name": "血源诅咒", "status": "ok", "count": 43, "error": null },
    { "id": "…", "name": "某独立游戏", "status": "empty", "count": 0, "error": null },
    { "id": "…", "name": "某新作", "status": "failed", "count": 0,
      "error": "Metacritic 页面抓取失败：https://…" },
    { "id": "…", "name": "尚未匹配的游戏", "status": "unsupported", "count": 0,
      "error": "未绑定媒体评价站条目" }
  ]
}
```

为什么这个接口**不像其它补全那样后台跑**（`backfill-durations` 返回 `{started:true}`）：

1. 调用方需要知道**哪些游戏仍然没有**评价，以及原因是「数据源确实没有」还是
   「被挡住了」——这两种情况用户要做的事完全不同；
2. 数据源是有速率限制的网站，串行是特性而不是缺陷（共享的按域名限速器会强制
   间隔），并发只会更快被封；
3. 同步执行天然限定了工作量，大库可以用 `limit` 分块处理。

`remaining` 是"再按一次按钮仍会处理"的游戏数，与设置页卡片上显示的 `awaiting`
用同一个表达式（`reviews_fetched_at IS NULL OR reviews_status IN ('failed','unsupported')`），
两者必须一起改，详见 `GET /api/games/media-reviews/coverage`。

失败**不会**清空已经抓到的评价（见 `MediaReviewsSummary.status`）。
数据源站点通常需要代理才能访问，全部失败时请先检查设置页的「RAWG 代理地址」
（媒体评价源沿用同一个代理配置）。

`POST /api/games/backfill-scores` 是原来那个「只补 Metascore 聚合分数」的接口
（纯后台任务、返回 `{started,total}`），媒体评价上线后仍然保留。

### GET /api/games/media-reviews/coverage

媒体评价的覆盖率，用于设置页的补全卡片。

```bash
curl http://127.0.0.1:3001/api/games/media-reviews/coverage
```
```json
{
  "total": 41,
  "withReviews": 31,
  "awaiting": 6,
  "failed": 4,
  "lastFetchedAt": 1790675941755,
  "nextToTry": ["某独立游戏", "某新作"]
}
```

`awaiting` 与 `POST /api/games/backfill-ratings`（`scope=missing`）的候选条件**逐字一致**
（`reviews_fetched_at IS NULL OR reviews_status IN ('failed','unsupported')`），
所以卡片上的数字就是按下按钮后实际会访问的游戏数，按完就能落到 0。

三条设计决定，都是为了「数字按得掉」：

| 状态 | 算不算 `awaiting` | 为什么 |
| --- | --- | --- |
| 从未抓取过 | ✅ | 按下去就会去抓 |
| 上次失败 `failed` | ✅ | 临时封锁值得重试 |
| 没有绑定条目 `unsupported` | ✅ | 确实还没抓到评价，算「已完成」会让用户以为它已经有评价了 |
| 页面没有评价 `empty` | ❌ | 数据源已经回答过了，重复问一个限速站点是纯浪费 |
| 抓到了 `ok` | ❌ | 同上 |

无对应条目的游戏会被反复列入候选，但**零成本**：绑定判断排在网络请求之前，
不产生任何页面请求（`e2e` 里对桩服请求计数做了断言），所以一个几百款的库
每次补全不会为这些游戏白等限速间隔。

`backfill-ratings` 返回的 `remaining` 用的是与 `awaiting` 完全相同的表达式，
两处一旦改歪，用户就会看到「还有 3 款」但按按钮什么也不发生。

### GET /api/games/:id/media-reviews

单个游戏的媒体评价 + 抓取状态。面板用它刷新自己，从而不必重新拉取整个详情
（海报、成就、媒体列表都不需要重下）。

```bash
curl http://127.0.0.1:3001/api/games/<id>/media-reviews
```
```json
{
  "reviews": [ { "outlet": "IGN", "score": 90, "platform": "PS5",
                 "text": "…", "url": "…" } ],
  "summary": { "status": "ok", "error": null, "fetchedAt": 1790675941755,
               "sourceUrl": "https://www.metacritic.com/game/bloodborne/", "count": 43 }
}
```

排序：有分数的在前（分高优先），没分数的在后，同分按媒体名称。游戏不存在返回
404（而不是一个空数组——空数组会被误读成「这个游戏没有评价」）。

`platform` 是抓取时由 `normalisePlatform()` 归一化后的短名（`PS5` / `PS4` /
`Xbox Series X|S` / `Switch` / `PC` …），可能为 `null`（站点没标注该评价属于哪个
平台）。

**界面上的「按平台查看」是在前端对这个字段做筛选的**，接口本身不接受平台参数：
抓取侧的条数上限发生在去重之后，若改成后端按平台查询就得再叠一层 `LIMIT`，会让
「明明有却查不到」。因此本接口的返回体与 `summary.count`（全局总数）都不受界面
筛选影响。

### POST /api/games/:id/media-reviews/refresh

重新抓取单个游戏的媒体评价。「媒体评价」面板上的按钮调它。

```bash
curl -X POST http://127.0.0.1:3001/api/games/<id>/media-reviews/refresh
# → {"status":"ok","stored":43,"error":null,"summary":{…}}
```

`status` 与 `MediaReviewsSummary.status` 同义。抓取失败时返回 `failed` 并附
`error`，**但库里已有的评价保持不动**。

### POST /api/games/backfill-scores

补全缺失的 Metacritic 评分（聚合 Metascore）。只处理 `ratings` 中没有非空
`metascore` 的游戏，逐条清除旧的 provider 绑定以强制重新检索，并在批量结束后
自动对仍失败的游戏重试一轮。纯后台任务：

```bash
curl -X POST http://127.0.0.1:3001/api/games/backfill-scores
# → {"started":true,"total":38}
```

进度查询（与 `refresh-all` 共用）：

```bash
curl http://127.0.0.1:3001/api/games/refresh-all/status
# → {"running":false,"total":38,"done":38,"current":null,"failed":0}
```

### POST /api/games/:id/match

手动绑定到指定数据源实体，并**整体替换**该游戏的身份数据。

替换顺序（清除在前、写入在后，中间不留半成品状态）：

1. 用该 `externalId` 向数据源确认条目的真实标题，取不到就 **400 中止**（此时还没改任何数据）；
2. 清空全部 provider 绑定，写入新绑定；
3. 清空 `games` 行上的身份字段（简介/封面/开发商/发行商/截图/评分/价格/发售日/配音/时长）；
4. 删除 `source='scraped'` 的旧海报，并依据「仍处于选中态的海报」重新镜像 `games.poster_url`；
5. **删除该游戏全部 `achievements` 行、清除 `achievement_links`、重置四个成就状态列**
   （旧游戏的奖杯列表不会跟着新条目留下来）；
6. 全量刷新所有已启用数据源。

**刻意保留**：`source IN ('upload','media')` 的海报及其选中态、`media` 表全部行、
`duration_seconds` 等本地时长字段、`custom_platform` / `poster_mode`。
这些是用户配置与本地数据，不属于刮削内容。

```bash
curl -X POST http://127.0.0.1:3001/api/games/<gameId>/match \
  -H 'Content-Type: application/json' \
  -d '{"provider":"rawg","externalId":"274755"}'
# → {"matched":true,"name":"Hades",
#    "providers":["hltb","rawg","steam","metacritic"],
#    "failed":[],"missing":[],"reason":""}
```

| 字段 | 含义 |
|---|---|
| `matched` | 是否至少取到一个字段。全部落空时为 `false` |
| `failed` | 全部数据源都失败时列出其名称 |
| `missing` | 未取到的字段：`poster`/`summary`/`developers`/`rating`/`screenshots` |
| `reason` | 中文原因说明，完整匹配时为空串 |

无法解析该 `externalId` 时返回 **400** 并附中文原因（常见原因 + 可再试的关键词方向），
且在改动任何数据**之前**中止，因此不会留下半成品状态。

> 提示里给出的关键词来自共享的 `titleQueryVariants()`，例如
> `无法在 metacritic 上读取该条目（id=…），已取消绑定。常见原因：该条目已被站点下架，
> 或这个 id 属于另一个平台的版本。可换个关键词再搜：「Pokemon Violet」、…`

RAWG / Steam 按拉丁标题相似度排序，中文查询会命中无关游戏（`命运2` → `Fateline(命运线)`）。
现在两者都会先尝试 `titleQueryVariants()` 解析出的英文别名，与 Metacritic 使用同一套别名表。

### GET /api/games/:id/rating-candidates

「手动选择评分」弹窗的候选列表。`?q=` 覆盖搜索关键词，缺省用游戏自身名称。

```bash
curl 'http://127.0.0.1:3001/api/games/<gameId>/rating-candidates?q=Hades'
# → {"query":"Hades",
#    "current":null,
#    "automatic":{"metascore":93,"criticCount":88},
#    "candidates":[{"externalId":"hades","name":"Hades","platform":"PC",
#                   "metascore":93,"releaseDate":"Sep 17, 2020"}, ...]}
```

同一款游戏在不同平台的 Metacritic 条目与分数是分开的，这个接口让用户挑与实际
游玩平台相符的那一条。`platform` / `metascore` / `releaseDate` 都来自搜索结果
卡片本身（`title="Metascore 93 out of 100"` 等），因此**不会为每个候选额外抓详情页**。

没有评分的候选也会返回（`metascore: null`），由前端过滤掉。

### PUT /api/games/:id/rating-target

把该游戏的评分固定到指定的 Metacritic 条目。

```bash
curl -X PUT http://127.0.0.1:3001/api/games/<gameId>/rating-target \
  -H 'Content-Type: application/json' \
  -d '{"externalId":"hades","name":"Hades","platform":"PC","metascore":93,"releaseDate":"Sep 17, 2020"}'
# → 完整 detail 对象，其中 metacriticScore=93、metacriticManual=true、
#   metacriticPlatform="PC"、metacriticSource="metacritic"
```

若该条目没有媒体评分（`metascore` 为空且回查也拿不到），返回 **400** 并说明原因 ——
存一个没有分数的覆盖值只会让评分标识再次消失。

用户选择存在独立的 `rating_targets` 表，**不是 `games` 的列**：`games` 每次刮削都会
被重写，做成列就有被覆盖的风险。这正是「全量刮削 / 单游戏刷新都不重置用户选择」
能成立的原因。手动选择在读取时优先于刮削结果（`GamesService.toSummary()`）。

### DELETE /api/games/:id/rating-target

删除覆盖值，回到系统自动匹配。「恢复自动匹配」按钮调用它。

## GET /api/games/:id/neighbors

详情页「上一个 / 下一个」的数据来源。接受与图库列表**完全相同**的筛选参数
（`search` / `platform` / `minScore` / `sort` / `order`），因此导航顺序与图库所见一致。

```bash
curl 'http://127.0.0.1:3001/api/games/<gameId>/neighbors?sort=name&order=asc'
# → {"prev":{"id":"…","name":"Astro Bot"},
#    "next":{"id":"…","name":"Bloodborne"},
#    "index":4,"total":12}
```

- 在**完整筛选结果集**上计算，不受图库分页（每页最多 100 条）限制。
- 首尾**环绕**：第一个的 `prev` 是最后一个，最后一个的 `next` 是第一个。
- 被当前筛选隐藏的游戏返回 `index: -1` 且 `prev`/`next` 均为 `null`，
  前端据此自动禁用按钮，不会跳到筛选结果之外的游戏。
- 前端把图库当前的 `search/platform/sort/order/minScore` 镜像在
  `sessionStorage`（`web/src/lib/galleryState.ts`），详情页据此发请求，
  所以「在图库里筛选之后点进详情页，上一个/下一个仍然只在该筛选结果里走」。

> 一个已知的时序特征：**首次**打开某款游戏的详情页会触发一次元数据刮削，而刮削
> 可能把中文目录名规范成官方标题（「血源诅咒」→「Bloodborne」）。邻居是按**请求
> 时刻**的库内名称排序算出来的，所以刮削进行中渲染的页面可能短暂显示上一轮排名；
> 刮削结束后（或刷新一次）即稳定。这不影响功能，验证脚本 `scripts/verify-browser.mjs`
> 会先做一次「页面 ↔ 接口」对齐再断言。

## GET /api/games/duration-coverage

设置页「平均通关时长补全」卡片的数据来源：告诉用户还差几款、以及补全之后是否真的变好了。

```bash
curl http://127.0.0.1:3001/api/games/duration-coverage
# → {"total":39,"withDuration":31,"missing":8,
#    "nextToTry":["Astro's Playroom","Hades", …],
#    "sources":[{"source":"hltb","count":24},{"source":"rawg","count":7}]}
```

- `missing` 与 `POST /api/games/backfill-durations` 使用的筛选条件**完全相同**，
  所以按钮上显示的数字就是这次任务会真正处理的条数，不会差一。
- `sources` 让「弱来源」（RAWG 的平均游玩时长）与权威来源（HLTB 主线时长）一眼可分。
- 该路由声明在 `@Get(':id')` **之前** —— Nest 按声明顺序匹配，否则会被 `:id` 吞掉。

## POST /api/games/backfill-durations

给所有「还没有平均通关时长」或「时长来自较低优先级来源」的游戏重跑时长来源。

```bash
curl -X POST http://127.0.0.1:3001/api/games/backfill-durations
# → {"started":true,"total":12}
```

进度与 `refresh-all` 共用 `GET /api/games/refresh-all/status`；该接口的 `label`
字段会区分当前跑的是哪个任务（`Refresh all` / `Completion-time backfill`），
设置页据此显示对应的进度条语义。它**只跑时长来源**（HLTB → RAWG），比全量重刮
便宜得多，用来修复搬家前因网络问题没抓到时长的存量库。

前端入口：设置页 →「平均通关时长补全」→「一键批量补全通关时长」按钮。

> 时长来自较低优先级来源的也会被纳入：RAWG 的 `playtime` 是全体玩家平均游玩时长，
> 与真实主线通关时长差距可能很大 —— 实测 Hades 为 RAWG 10h vs HLTB 23.6h。
> 这类值会被更强的来源替换，但**不会被清空**。

## 时长缓存规则

provider 返回的片段只有在**确实带有该来源应提供的数据**时才会写入缓存
（见 `MetadataService.isCacheableFragment`）。

时长来源的 `fetch()` 内部会重新查询一次自己的搜索接口，这次查询是尽力而为的 ——
失败时时间字段为空。若把这种空片段缓存下来，整个 TTL 内的所有非强制刷新都会持续读到
它，**一次网络抖动就能让一款游戏长期显示「未知」**。空片段同样不入缓存：它表示
「这次请求没产生任何东西」，不是一个值得记住的事实。

三重保险（`backend/scripts/verify/duration-cache-e2e.mjs` 用桩服逐条实测）：

1. **写入侧**：`isCacheableFragment()` 对时长来源要求 `mainStoryHours != null`，空片段不写；
2. **读取侧**：命中缓存后仍会复检，读到空的旧记录直接当 miss 处理，顺手重查；
3. **重试侧**：`HltbProvider` 对网络异常最多重试 3 次，403（token 失效）会**换新 token**
   再试 —— 换 token 这件事只能由 provider 自己做，通用退避重试给不了新 token。
   批量补全另外对仍然缺失的行做 3 轮串行重试（`RETRY_ROUNDS`）。

已有时长永远不会被空结果清空：补全只写入成功取到的值。

## 详情页大图区海报轮播

大图区使用 `web/src/components/HeroPosterCarousel.tsx`，图片集合来自
`GameDetail.heroPosters()`：

```
全部官方海报（source = scraped 或 upload，不含 source='media' 的相册截图）
  → 当前封面排首位 → 去重
```

**大图区与「编辑海报」面板彻底解耦**：默认自动轮播全部官方海报（3.5 秒一张、可循环），
左右箭头与 `x/y` 计数常驻；面板里的展现模式开关与轮播勾选**只管首页卡片**，不影响这里。
组件甚至没有 `mode` 属性 —— `HeroPosterCarousel.tsx:75` 是 `const rotating = count > 1;`，
张数多于 1 就自动切换。只有**官方集合为空**时才回退到 `posterUrl` / `screenshots`，
保证大图区不空白。

> 历史坑：这里一度改成「`posterList` 全部塞进来、不做任何过滤」，又被改成「只认
> `in_slideshow` 勾选」。两种都是把两套轮播的职责搅在一起。现在的分工是：
> **详情页大图 = 全部官方海报，恒定自动；首页卡片 = 勾选 ∪ 当前封面，由 `posterMode`
> 决定是否自动切换。** 两者数据源不同，互不影响。

关键约束：

- 左右箭头**循环**且永不禁用（旧实现到首/末张就 `disabled`，看起来像没有轮播）；
- 箭头与 `x/y` 计数**常驻可见**，不依赖 hover；
- 加载失败的图（`onError`）会被跳过并从计数里剔除，用户不会翻到空白帧；
- 计数分母是「当前能显示的张数」而非登记总数 —— 剔除坏图后它会变小，这是既定行为。

### 两套轮播各自的集合怎么来

- **详情页大图区（自动翻页）**：`HeroPosterCarousel` 直接消费 `GameDetail.heroPosters()`
  = 全部官方海报，**不读 `in_slideshow`** —— 官方海报有多少张，大图区就能翻多少张；
- **首页图库卡片（可选自动切换）**：消费 `GameSummary.posters`，由后端 `cardPosters()`
  给出，判据是 `in_slideshow = 1 OR is_selected = 1`（勾选 ∪ 当前封面，封面恒在集合里），
  空则回退 `games.poster_url`。是否自动切换由 `games.poster_mode`（`posterMode`）决定。

```bash
# 看清某个游戏登记了哪些、其中几张被勾选参与首页卡片轮播
curl -s http://<主机>:3001/api/games/<gameId>/posters \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);print("登记",len(d),"勾选",len([p for p in d if p["inSlideshow"]]))'
```

## 海报注册

`ensureScrapedPosters(gameId, urls[])` 注册 provider 返回的**全部**美术资源，
而不只是封面：调用方传入 `[封面, ...screenshots]`，封面排在第一位。

- 只有封面能在用户未选过封面时占据封面位；
- **新登记的官方海报不再默认进轮播**（`in_slideshow` 默认 0）。轮播归属是**纯用户配置**：
  勾选即加入首页卡片轮播集合，取消即移出；详情页大图不受影响（它用全部官方海报）；
- **这里从不删除任何行**。曾经的剪枝逻辑用「封面原始字符串是否还在本次入参里」判断
  海报是否过时，而一次刮削会写入多个 provider 的分片、其中带封面的分片彼此不一致，
  于是后一个分片把前一个刚登记的官方截图整批删掉了 —— 实测
  「赛博朋克2077」`call 1 in=7 wanted=7` 之后 `call 2 in=1 wanted=1`，6 张截图消失，
  20/20 个游戏最终都只剩 1 张在轮播。这就是「只有 007 和宝可梦能翻」的根因；
- 身份变更（用户手动换绑到另一个游戏）由 `resetForRematch()` 负责清理，**这是唯一的
  清理入口**，它按游戏 id 整体重置，不会误伤同一身份的其它海报；
- ~~兼容旧库：扫描时留下的、用户从未动过的旧行会被回填为 `in_slideshow = 1`~~
  → **已移除**。回填会把用户刚取消掉的又打开，是「勾选后无法取消」的来源之一；
- 启动期修复会把历史上**程序替用户决定**的轮播行摘出（只动 `slideshow_user_set = 0` 的行，
  用户亲手勾选/取消的保留），官方海报与相册截图都在此列。

### 相册截图不再自动补轮播（需求 21）

这一版把「谁能自动进轮播」收到了一条规则上：**没有任何海报会被自动加入**，轮播归属
一律等用户勾选 —— 只有当前封面靠 `is_selected = 1` 恒在首页卡片集合里（不靠 `in_slideshow`）。

改之前的行为（两个地方都在自动加相册截图）：

| 位置 | 旧行为 | 现在 |
| --- | --- | --- |
| `POST /posters/from-media`（「从相册添加」） | 插入 `in_slideshow = 1`，且不标记用户决定 | 插入 `in_slideshow = 0` 且 `slideshow_user_set = 1` |
| `ensureRotationFloor`（刮削后兜底） | 相册图不足时自动补到 `min(2 + 相册数, 8)` | 改名为 `ensureCoverInRotation`，**只把封面放进轮播**，不碰相册图 |
| 启动期 `repairPosterRotation` | 每次开机都按上面的目标补相册帧 | 只补「封面不在轮播里」的游戏 |
| `ensureScrapedPosters` 的旧行回填 | 把 `slideshow_user_set = 0` 的旧行打开 | 整段删除 |

**取舍（真实存在，已接受）**：provider 只返回一张官方图、用户又没勾任何东西的游戏，
首页卡片只有一张静态封面（没有箭头）；详情页大图也只有那一帧官方海报（以前会显示若干
本地相册帧）。这是「不主动勾就不加入」的代价。缓解措施：`games.posterList` 始终带全部
登记海报 + 相册，所以「编辑海报」里永远能勾到它们；详情页在**官方集合为空**时才回退到
`screenshots`。

**封面也会尊重用户**：`ensureCoverInRotation` 遇到 `slideshow_user_set = 1` 的行直接返回，
不再强推。否则「用户取消勾选的正好是封面」时，每次刷新都会被改回来 —— 实测就是这样：

```
取消勾选后   slide=0 uset=1   ← 用户的选择
重新匹配后   slide=1 uset=1   ← 被兜底逻辑改回（修复前）
```

用户配置的保护由两个**语义不同**的列承担，不要混用：

| 列 | 含义 | 谁写 |
| --- | --- | --- |
| `is_user_choice` | 用户把这张**设为封面** | `POST /api/games/:id/posters/select` |
| `slideshow_user_set` | 用户**亲自决定过**这张的轮播归属（勾或取消都算） | `PATCH /api/games/:id/posters/:posterId`，以及「从相册添加」 |

`ensureScrapedPosters` / `ensureCoverInRotation` 只回填 `slideshow_user_set = 0` 的行，
用户手动关掉的（`in_slideshow = 0` 且 `slideshow_user_set = 1`）**永远不会被自动打开**。

### 两个轮播互不相干

「编辑海报」里的展现模式开关与轮播勾选只决定**首页图库卡片**（自动切换 + 显示箭头、
集合成员）；详情页大图区恒定自动轮播**全部官方海报**，不受面板任何设置影响。消费方式：

| 界面 | 数据源 | 自动切换 |
| --- | --- | --- |
| 首页图库卡片 `PosterCarousel` | `GameSummary.posters` = `cardPosters()`（`in_slideshow = 1 OR is_selected = 1`，勾选 ∪ 当前封面，封面优先；空则回退 `games.poster_url`） | 由 `posterMode`（「首页卡片轮播」开关）决定；集合 ≤1 张时不渲染箭头 |
| 详情页大图区 `HeroPosterCarousel` | `heroPosters()` = 全部官方海报（`source` 为 `scraped`/`upload`，不含 `media`），当前封面在前 | **恒定自动**（>1 张即轮播）；无 `mode`/`data-mode`，与面板无关 |
| 详情页信息卡缩略图 | `detailPosters()`（全部登记海报 + 相册） | 由 `posterMode` 决定 |

> 历史坑：`GameSummary.posters` 以前在「全部登记海报」与「`in_slideshow` 子集」之间来回
> 摇摆，导致「勾选改的到底是哪套轮播」始终说不清。现在的分工是：**勾选 + 开关 = 首页卡片；
> 全部官方 = 详情页大图**，各自数据源不同，不靠约定。

弹窗本来就按 `source` 分组，所以官方海报会统一归入「官方刮取」一组。

## 游戏名称与手动修改保护（manual_override）

**扫描与刮削都不会覆盖用户手动改过的名称。** 判定依据是 `games.manual_override`
（SQLite 布尔列），而不是「名字看起来像不像目录名」这类启发式。

| 动作 | 是否改 `name` | 是否置 `manual_override = 1` |
| --- | --- | --- |
| `POST /api/library/scan`（新目录首次入册） | 是（写入目录名规范化结果） | 否（保持 0） |
| `POST /api/library/scan`（已存在且 `manual_override = 0`） | 是（每次重新规范化，修旧版本落下的脏名字） | 否 |
| `POST /api/library/scan`（已存在且 `manual_override = 1`） | **否** | 保持 1 |
| `PATCH /api/games/:id` 带 `name`（＝界面里改名） | 是 | **是**（自动置位） |
| `PATCH /api/games/:id` 带 `platform` / `platforms` | 否 | **是**（同样是用户手动覆盖） |
| 元数据刮削 `applyCanonicalName()` | `manual_override = 1` 时**直接 return** | 保持 1 |

```bash
# 手动改名（界面「编辑」对话框走的就是这一条）
curl -X PATCH http://127.0.0.1:3001/api/games/<gameId> \
  -H 'Content-Type: application/json' -d '{"name":"血源诅咒（我的命名）"}'
# → 200；随后无论 refresh 还是 scan，名称都保持不动
```

`manual_override` 目前**不返回**给前端（`GameDetail` 里没有这个字段）：
界面不需要它做判断，改名即覆盖是唯一语义。需要排查时可以直连数据库确认：

```bash
sqlite3 /path/to/data/screenplay.db \
  "SELECT name, manual_override FROM games WHERE name LIKE '%我的命名%';"
```

## 自定义排序（拖拽）

`GET /api/games?sort=custom` 按 `games.custom_order` 升序返回；**未摆放过的游戏
（`custom_order` 为空）排在已摆放的之后，按名称排序**，因此新扫描进来的游戏会稳定
出现在末尾，不会插到用户排好的顺序前面。

### PUT /api/games/order

```bash
curl -X PUT http://127.0.0.1:3001/api/games/order \
  -H 'Content-Type: application/json' \
  -d '{"gameId":"被拖动的id","beforeId":"落在它下面的那张","afterId":"落在它上面的那张"}'
# → {"ok":true,"gameId":"…","customOrder":1024}
```

`afterId` = 落在它**上面**的那张卡，`beforeId` = 落在它**下面**的那张卡。
两者都可以为 `null`：`afterId: null` 表示拖到最前，`beforeId: null` 表示拖到最后。

用「邻居」而不是「第 N 位」表达落点，是它在**筛选与分页下依然正确**的原因 ——
序号会随过滤结果变化，而邻居是一对 id；位置是一套全局序列，所以第 2 页的拖动
相对第 1 页的顺序依然正确。

相邻位置间隔 1024，落在中间时取中点；中点用尽时会自动整体重新编号（导出的顺序与
界面所见完全一致，因此无可见变化）。

### DELETE /api/games/order

清除所有自定义位置，恢复系统默认顺序。

```bash
curl -X DELETE http://127.0.0.1:3001/api/games/order
# → {"ok":true,"cleared":6}
```

### 拖拽只在「自定义排序」模式生效

其他排序模式仍按各自规则排序。卡片只有在 `sort=custom` 时才可拖动。

> 语义上需要注意：`sort=custom` 与 `sort=name` 在**用户尚未拖动过任何卡片**时结果相同
> —— 这不是 bug，而是「未摆放的按名称排」这条规则的自然结果。

## 时长来源

`games.duration_source` 记录时长由哪个库提供（`hltb` / `rawg`），并透出到 DTO 的
`durationSource` 字段。

兜底链按 `DURATION_SOURCE_ORDER` 依次尝试，第一个有结果即采用：

1. **hltb** — HowLongToBeat，真实「主线通关时长」，覆盖 PC / PlayStation / Xbox / Switch，
   提供主线 / 主线+支线 / 完美通关三个维度。
2. **rawg** — RAWG 的 `playtime`，是全体玩家平均游玩时长而非通关时长，只作为兜底，
   且只填补强源缺失的维度。

### 中文游戏名怎么拿到时长

时长库只索引拉丁标题，而媒体库目录名常常是中文（「刺客信条 奥德赛」）。三层保障：

1. **别名解析**：`queryVariants()` 先试英文别名再试原名（与 RAWG / Steam / Metacritic 共用
   同一张 `metacritic-aliases` 表）。
2. **标点直引号化**：别名表里的弯引号（`’`）会导致 HLTB 字面匹配失败，查询前统一成 ASCII。
3. **规范化名称后的二次补抓**：`backfillDuration()` 在 `applyCanonicalName()` 之后，
   用刮削得到的拉丁名再问一次时长库 —— 别名表没收录的标题也能补上。

> 注意 `library.service.ts` 会在**每次扫描时**把 `games.name` 重置为规范化后的目录名
> （除非 `manual_override`），所以刮削得到的拉丁名不会长期留在库里。上面第 1、3 条
> 正是针对这一点设计的：无论库里是中文名还是拉丁名，都能取到时长。

## 评分完整性（重要）

Metacritic 对「有用户评分但媒体评测还不足」的页面会解析出
`{metascore: null, criticCount: 3, userScore: 8.4}` —— **这不是 null 对象**。
早期实现整个数组替换，于是这样一次抓取会把先前有效的 Metascore 抹成 null，
而 `firstRating()` 只认 `metascore != null` 的条目，评分标识随即消失。

现在的规则（`metadata-merge.ts`）：

1. 按 `source` 合并，**任何字段只有在本次确实有值时才覆盖**；
2. 合并对象是**库里当前的值**，不是刷新开始前的快照（各 provider 并行写入）；
3. 每次更新前后做完整性校验：更新后若没有 Metascore 而更新前有，则恢复并记 WARN。

`games.ratings` 仍是一个 JSON 数组（没有独立的分数列），格式不变。

## 时长来源

`games.duration_source` 记录时长由哪个库提供（`hltb` / `rawg`），并透出到 DTO 的
`durationSource` 字段。

- **hltb**：HowLongToBeat，真实「主线通关时长」，覆盖 PC / PlayStation / Xbox / Switch。
  接口需要 token（见下），优先级最高。
- **rawg**：RAWG 的 `playtime`，是全体玩家的平均游玩时长而非通关时长，因此只作为兜底。

合并按时长来源优先级进行，而不是 `COALESCE` 的「谁先返回谁赢」——
各 provider 并行写入，先到先得会让弱源压过强源。弱源只能填补强源缺失的维度。

> HowLongToBeat 的搜索接口现在需要：
> `GET /api/search/site/init?t=<当前毫秒>` 取 token，
> 再带 `x-auth-token` 头 POST `/api/search/site`，403 时重新取 token 重试。
> 旧的 `/api/search` 已废弃（对所有请求返回 403）。`t` 必须是当前时间戳。

### GET /api/games/match/search

手动匹配弹窗的候选检索，会并行询问所有已启用数据源。

```bash
curl 'http://127.0.0.1:3001/api/games/match/search?q=宝可梦%20紫'
# → 18 条候选，rawg 10 条 + metacritic 8 条
```

**每个数据源会返回多条候选**（RAWG 最多 10 条，Metacritic 最多 8 条），不再只有一条最佳猜测 ——
只有一条时，用户一旦不同意那个猜测就没有别的选择，这正是任天堂游戏此前无法手动匹配的实际原因。

某个数据源失败或超时时只记日志并跳过，不影响其它数据源的候选。

排序（RAWG，`searchAll`/`search` 共用同一套评分）：

| 分值 | 条件 |
|---|---|
| 5 | 标题 key 与查询完全相同 |
| 4 | 包含关系，**且短串至少占长串 60%** |
| 0~3 | 查询里的关键词有多少出现在标题里（比例 × 3，四舍五入） |

同分时依次比较 fuzzy 分数、RAWG 返回顺序。**不无条件相信 fuzzy**：
实测 `fuzzyMatch('Pokemon Violet', …)` 会选出 `Pokémon Colosseum`（0.517）而丢掉正确的
`Pokémon Scarlet and Violet`；RAWG 自己的返回顺序在两次请求之间也不稳定。

### Metacritic 的两个已知坑（均已修复）

- **`fetch()` 必须返回 `canonicalName`**。`resolveMatchName()` 只读这个字段，
  而 metacritic 原先只返回 `rating`，导致手动绑定到**任何** metacritic 条目都报
  「无法在 metacritic 上找到该条目」——即使页面和评分都抓到了。
  （自动匹配不经过 `resolveMatchName`，所以 PC/PS 平时看不出问题。）
- **搜索结果要限定在结果卡片内**。页面级的 `a[href*="/game/"]` 会把导航与推荐位的
  `/game/pc/all/` 也当成候选。

## 认证（本地登录）

开启认证后，除 `/api/health` 与 `/api/auth/*` 外，所有 `/api/*` 接口都要求有效会话。
会话凭据放在 **httpOnly Cookie** `screenplay_session` 中（浏览器 JS 读不到），
也接受 `Authorization: Bearer <token>`（登录接口返回的会话令牌）。`GET /api/auth/session`、
`POST /api/auth/logout`、`POST /api/auth/password` 与受守卫的业务接口一样，两种凭据都识别
（Cookie 优先，其次 Bearer）—— 安卓端不保存 Cookie，靠 Bearer 判断会话状态与登出。

`AUTH_DISABLED=1` 时全部放行，便于忘记密码时应急。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/auth/session` | 当前会话与登录方式（公开）：`enabled`/`mode`/`provider`/`systemAvailable`/`reason`/`users`/`authenticated`/`user` |
| POST | `/api/auth/login` | `{username, password, remember?}` → 成功后 `Set-Cookie` |
| POST | `/api/auth/logout` | 销毁会话并清除 Cookie |
| POST | `/api/auth/password` | `{current, next}` 修改**本地账户**密码（设置页「修改密码」调用的就是它）。成功 `{ok:true}`；失败**一律 2xx + `{ok:false, code, error}`**，`code` ∈ `unauthenticated` / `not_local` / `wrong_current` / `blank` / `too_short` / `too_long` / `same` —— 故意不用 401：Web 端把任何 401 当作「会话已失效」并跳回登录页，用户输错一次原密码就会被登出。新密码 4~128 位、不能与原密码相同；成功后**注销该账户的其它会话**（被盗 cookie 立刻失效），只保留发起改密的当前会话；NAS 系统账户返回 `not_local` |
| DELETE | `/api/media/:id` | 删除媒体（索引行 + 原图 + 缩略图/封面/预览缓存 + 悬空海报引用）。与其它 `/api/*` 一样**受全局会话守卫**：带 Cookie/`Bearer` 才能删；自 `1.3.2` 起 Windows 桌面端默认 `host=0.0.0.0`（局域网可访问）+ `auth=local`，首次启动在网页里创建账户，删除同样需要凭证（`AUTH_DISABLED=1` 只在同时把 `host` 改回 `127.0.0.1` 并设 `auth=off` 时才会开启，届时无凭证放行）。返回 `{ok,id,deleted,removedFiles,postersRemoved,originalSkipped}`，`404` 表示媒体不存在（详见「Media streaming endpoints」） |

```bash
# 登录并保存 Cookie
curl -c /tmp/sp.jar -X POST http://127.0.0.1:3001/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"你的NAS用户名","password":"密码","remember":true}'

# 之后带 Cookie 访问
curl -b /tmp/sp.jar http://127.0.0.1:3001/api/games

# 修改本地账户密码（设置页「修改密码」调用的就是它）
curl -b /tmp/sp.jar -X POST http://127.0.0.1:3001/api/auth/password \
  -H 'Content-Type: application/json' \
  -d '{"current":"旧密码","next":"新密码"}'
# 成功 → {"ok":true}；失败仍是 2xx，形如 {"ok":false,"code":"wrong_current","error":"…"}
```

`user.provider` 为 `system`（NAS 系统账户）或 `local`（应用内账户）。
密码使用本机 `crypt(3)` 哈希校验（`$6$` SHA-512 / `$5$` / `$1$`），
**密码本身不落库、不记日志、不出现在任何响应中**；本地账户用 scrypt 哈希存储。
`$y$`（yescrypt）无法在纯 JS 中校验，此时会返回明确提示而非"密码错误"。

> **改了密码就不用再翻启动日志**：未设 `AUTH_ADMIN_PASSWORD` 时随机生成的 `admin` 初始密码
> 只在首次灌库时打印一次。登录后在 **设置页 →「修改密码」** 填原密码 + 新密码即可改成自己的，
> 立即生效、重启或重建容器后仍然是新密码（`AUTH_DISABLED=1` 只是应急免登录开关，不是改密替代）。

### 界面偏好

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/settings/preferences` | `{language}`，默认 `zh-CN` |
| PUT | `/api/settings/preferences` | `{language:"zh-CN"\|"en"}`；其他值返回 400 |

语言偏好存在 SQLite `settings` 表（键 `ui.language`），随数据卷持久化，
换浏览器或重启容器都保持。

### 海报接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/games/:id/posters` | 海报列表（选中项排首位，读取时自动修复缺失的选中标记） |
| POST | `/api/games/:id/posters/upload` | 上传自定义海报（支持 JXR，自动转 WebP） |
| POST | `/api/games/:id/posters/from-media` | 用相册图片作为海报 |
| POST | `/api/games/:id/posters/select` | 设为封面（同步 `games.poster_url`） |
| POST | `/api/games/:id/posters/clear-selection` | 取消封面并恢复官方默认（只清标记，不删文件） |
| POST | `/api/games/:id/posters/reconcile` | 修复缺失的封面选中标记（幂等） |

每张海报返回：

| 字段 | 含义 |
|---|---|
| `url` | 实际图片地址。相册来源指向 `/preview`（4K 原尺寸，2.5–9.8 MB） |
| `thumbUrl` | **同一张图的小图**（约 6 KB）。网格/缩略图请用这个，点击看大图时再用 `url` |
| `source` | `scraped` 官方刮削 / `upload` 用户上传 / `media` 相册截图 |
| `isSelected` | 是否当前卡片封面 |
| `isCover` | **用户自己**设定的封面（`is_selected=1` 且 `is_user_choice=1`）。界面据此显示「取消封面」 |
| `inSlideshow` | 是否被用户勾选参与**首页卡片**轮播（详情页大图不受它影响） |

> `isCover` 不看 `source`，而看一个独立的 `game_posters.is_user_choice` 标记：
> 光看 source 是错的 —— 当游戏**没有官方海报**时，取消封面会回退到本地首图（一张 `media` 海报），
> 那一行会立刻被重新标记为选中，于是"取消封面"按钮又冒出来，看起来像点了没反应。
> 现在 `clearSelection` 会同时清掉 `is_user_choice`，回退出来的封面一律算"默认封面"。

> **不变式**：`source='scraped'` 的行必须是**真正的抓取图**，绝不能指向本机文件。
> 早期版本把 `games.poster_url` 直接登记为官方海报，而该列在"没有官方图"时是本地首图
> （`/api/media/<id>/thumbnail`）、在用户选了相册图后是 `/api/media/<id>/preview`，
> 于是取消封面等于把用户自己那张图又选了一遍 —— 表现为"点取消没反应"。
> 现在 `/api/media/<id>/…` 与 `/api/posters/<id>/…` 一律被拒（`/api/media/proxy?url=…`
> 是代理过的抓取图，仍然允许），启动时会自动修复历史脏数据。

> 为什么需要 `thumbUrl`：给 90px 的小格子加载 4K 预览图，一个 120 张截图的相册弹窗
> 首屏就要传 **607 MB**；改用 `thumbUrl` 后约 **5 KB**（实测相差 11375×），
> 画面上看不出区别。
| PATCH | `/api/games/:id/posters/:posterId` | 切换是否参与**首页卡片**轮播（勾选） |
| DELETE | `/api/games/:id/posters/:posterId` | 删除海报 |
| GET | `/api/posters/:posterId/image` | 读取海报图片 |
| PATCH | `/api/games/:id` | `{"posterMode":"static"｜"slideshow"}` 首页卡片轮播开关（不影响详情页大图） |

### JXR 转码

`/api/media/:id/thumbnail`、`/preview`、`/original` 对 `.jxr/.wdp/.hdp` 一律返回
`image/webp`（魔数 `52494646`），转码结果按 `mediaId@宽度v2.webp` 缓存；
真正无法解码的变体返回 **415**。

支持 8bit / 16bit / **32bit 浮点 HDR** 三种位深。HDR（Xbox 游戏栏截图常见）会经
extended Reinhard 色调映射后再 sRGB 编码，白点由像素采样自动确定。

**第 4 通道必须整体忽略**：`jpegxr` 的 32Float 输出没有写入该通道，它是 WASM 堆上的
残留内存（首次解码为全 0，之后是上一张图的像素）。实测「落在 (0,1) 的像素占比」随解码
顺序在 0%–95.7% 之间变化，而参考解码器对同批文件给出 alpha 恒为 1.0。把它当预乘 alpha
做除法会提亮 30%–41% 的像素，即「过曝」现象。

缓存文件名中的 `v2` 是色调映射版本号（`JXR_PIPELINE_VERSION`），算法变更即自动作废旧缓存。

**扫描阶段预热**：扫描时用一次解码同时产出三种尺寸（缩略图 / 宽 2560 / 全尺寸），
因此首次访问即为缓存命中——实测 3.7–9.6ms，此前约 4s。三档共用同一份色调映射结果，
亮度最大差仅 0.4。注意 `/original` 不传宽度、走 `@full` 键，同样会被预热。

源 `.jxr` 文件字节与 mtime 均不被改动。

---

## 数据表：`media_reviews`（媒体评价）

媒体评价单独一张表，而不是塞进 `games.ratings` 那个 JSON 数组。理由有两层：

1. **一条评价是一个实体**（媒体名称 + 打分 + 原文 + 链接 + 作者 + 平台 + 日期），
   放进 JSON 里就没法按媒体查询、没法去重、也没法单独标记某条抓取失败；
2. **生命周期不同**。`games.ratings` 每次刷新都会被重写，而评价抓一次要访问一次
   数据源页面 —— 必须保证「刷新没抓到」不会把已经拿到的评价抹掉。

```sql
CREATE TABLE media_reviews (
  id           TEXT PRIMARY KEY,   -- uuid_v5(game_id + outlet + url)，重复抓取幂等
  game_id      TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  source       TEXT NOT NULL,      -- 'metacritic'
  outlet       TEXT NOT NULL,      -- 媒体名称
  score        INTEGER,            -- 该媒体的打分 0-100
  verdict      TEXT,               -- 无数字分时的文字判定
  review_text  TEXT,               -- 评价原文（最多 1200 字）
  url          TEXT,               -- 该媒体原文链接
  author       TEXT,
  platform     TEXT,
  published_at TEXT,
  sort_order   INTEGER,            -- 数据源给出的顺序
  fetched_at   INTEGER NOT NULL
);
CREATE INDEX idx_media_reviews_game ON media_reviews(game_id);
CREATE UNIQUE INDEX idx_media_reviews_unique
  ON media_reviews(game_id, outlet, COALESCE(url, ''));
```

**`id` 用 uuid v5（命名空间 + `game_id + outlet + url`）而不是自增**：这样爬虫脚本
（`backend/scripts/crawlers/metacritic-media-reviews.mjs`）和后端写入的同一行是同一个
id，两边都会走 upsert 更新同一行，而不是各写一行导致面板出现重复评价。

**唯一索引带 `COALESCE(url, '')`**：`url` 为空时 SQLite 里 `NULL != NULL`，
不加这个包裹，同一媒体的无链接评价会被重复插入。

### `games` 表上新增的四列

| 列 | 类型 | 含义 |
| --- | --- | --- |
| `reviews_fetched_at` | INTEGER | 最近一次抓取尝试的时间。`NULL` = 从未抓过 |
| `reviews_status` | TEXT | `ok` / `empty` / `failed` / `unsupported`，语义见 `MediaReviewsSummary` |
| `reviews_error` | TEXT | 失败原因（原样展示给用户） |
| `reviews_source_url` | TEXT | 数据来源页面，面板上的「数据来源」链接 |

这四列由 `DatabaseService` 的迁移块以 `addColumnIfMissing` 方式补齐，因此**已有的库
直接升级即可**，不需要重建、不会丢数据。老库升级后所有游戏都是
`reviews_fetched_at IS NULL`，界面显示「还没有抓取过媒体评价」，点一次设置页的
「一键批量补全媒体评价」就补齐了。

### 写入规则（`MediaReviewsService`）

| 情况 | 结果 |
| --- | --- |
| 抓到 N 条 | 按 id upsert N 行，`reviews_status='ok'`，清空 `reviews_error` |
| 抓到了页面但没有评价 | `reviews_status='empty'`，**不动已有行** |
| 抓取失败（403/429/5xx/不可达） | `reviews_status='failed'` + `reviews_error`，**不动已有行** |
| 没有绑定数据源条目，或绑定后在该站找不到条目 | `unsupported` |
| 重新绑定游戏（手动匹配） | 旧评价被删除，然后按新条目重新抓取 |

「空结果不清空、失败不清空」是这一块最容易写错、后果也最严重的一条：一次被限流
就抹掉用户正在看的评价列表，比留着一点旧数据糟糕得多。
