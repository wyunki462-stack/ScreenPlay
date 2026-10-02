import { Controller, Get } from '@nestjs/common';

/**
 * Marker of the capabilities this build contains.
 *
 * Bump a value here whenever a page-visible feature ships: it turns "did the new
 * build actually get deployed?" from an argument into a one-line check.
 */
export const BACKEND_FEATURES = [
  'game-neighbors',
  'duration-backfill',
  'scraped-posters-all', // 刮削到的海报/截图全部**登记**（只讲登记，不含「默认进轮播」——那是已退役的 poster-rotation-all-games）
  'duration-cache-guard',
  // 本轮新增/明确的能力。单独列出来，是为了让「部署的镜像是不是这一版」变成
  // 一条 curl 就能判断的事：前端产物在 public/ 里，后端产物在 dist/ 里，
  // 两者都可能被旧镜像覆盖，而 features 列表一定跟着镜像走。
  'hero-poster-carousel', // 详情页大图区官方海报轮播（左右箭头 + x/y 计数，循环）
  'duration-coverage-api', // GET /api/games/duration-coverage（设置页补全卡片的数据源）
  'duration-backfill-ui', // 设置页「一键批量补全通关时长」按钮
  // 第四轮修「只有个别游戏能翻页」时新增的能力。
  //
  // 原 `poster-rotation-all-games`（「官方刮取到的海报/截图全部登记且默认进轮播」）
  // 已退役：官方图仍然**全部登记**，但不再默认进轮播 —— 见下面的
  // `card-rotation-user-ticks`。
  'card-rotation-user-ticks', // 首页卡片只轮播用户在「编辑海报」里勾选的图
  // 第五轮：按需求 21 收口轮播归属；本轮把两套轮播彻底拆开。
  //
  // 原来的 `poster-rotation-floor` 标记的正是「官方图不足时用本地相册截图补齐
  // 轮播」这个行为 —— 它已按需求移除。`poster-rotation-cover-only` 也随之退役：
  // 封面现在是**结构性**地在卡片集合里（判据 `is_selected = 1 OR in_slideshow = 1`），
  // 不再需要一条「把封面补进轮播」的修复规则，见 `card-rotation-cover-always`。
  'card-rotation-cover-always', // 封面始终是卡片集合的第一帧（结构性，不靠标志位）
  'card-rotation-user-decided', // 勾选/取消（含封面）记为用户决定，刮削与启动期清理都不改回
  'hero-rotation-all-official', // 详情页大图默认轮播全部官方海报（scraped/upload），无需配置
  'card-carousel-vs-hero-carousel', // 首页卡片=封面+勾选集；详情页大图=全部官方海报
  'review-pagination', // Metacritic 媒体评价按 critic-reviews 分页全量拉取
  'poster-config-protected', // 用户取消勾选的轮播项不会被重新刮削自动加回
  // 第六轮：界面细节三则。
  'card-carousel-no-dots', // 首页卡片轮播不再显示底部圆点（详情页大图仍保留）
  'album-frame-removable', // 相册截图可逐张「取消展示」，删完可从相册重新添加
  'review-paged-ui', // 媒体评价默认 5 条 / 展开 10 条 / 每页最多 10 条
  'boot-purge-logged', // 启动期清理数量会写进日志（此前 purged 漏进日志条件）
  // 本轮新增：Metacritic 媒体评价（「媒体评价」标签页 + 批量补全）。
  // 早先占位的 `critic-reviews` 从未实现，已由下面三个按交付面拆分的名字取代：
  // 这样「接口在不在」「前端在不在」「覆盖率接口在不在」可以分别判断。
  'media-reviews-api', // GET /api/games/:id/media-reviews + POST /api/games/backfill-ratings
  'media-reviews-ui', // 详情页「媒体评价」标签页（媒体名称 / 媒体打分 / 评价原文）
  'media-reviews-coverage-api', // GET /api/games/media-reviews/coverage（设置页补全卡片）
  // 第七轮（0.6.2）。
  //
  // `review-pagination` 只证明「会翻页」，不证明「落地页没有分页器时也会去翻」——
  // 而这正是线上「65 家媒体只抓到 1 条」的真正原因（分页器长在 critic-reviews
  // 列表页上，落地页不带）。所以单独一个标记，让「这次部署到底有没有修好」
  // 在 health 里就能读出来。
  'review-listing-fallback', // 落地页无分页器时补探 critic-reviews 列表页并翻页
  'review-platform-filter', // 媒体评价面板按平台筛选（选项取自评价里出现过的平台）

  // 第八轮（0.6.3）。
  //
  // 上面两个标记都没有兑现「抓全」：它们只在 HTML 里翻页，而真实站点早已把评价列表
  // 改成由 Nuxt 客户端调一个 JSON 接口渲染，HTML 里的旧选择器一条都匹配不上，而且
  // `?page=` / `?offset=` 在 HTML 路由上不再生效（详见 CHANGELOG 0.6.3）。所以这一轮
  // 直接改成调用站点自己的接口 —— 下面的标记就是「镜像里有没有这条新链路」的判据。
  'reviews-api-source', // 媒体评价改从 Metacritic 官方 JSON 接口抓（HTML 解析退为兜底）
  'card-arrows-need-slideshow-mode', // 首页卡片箭头只在「首页卡片轮播」开关（posterMode）开启时显示

  // 第九轮（0.6.4）：详情页评分区与媒体评价面板的三处改动。
  //
  // 0.6.3 只改到「抓得全不全」，没动界面本身。这一轮动的是**看得见的东西**，
  // 所以三个标记分开列：任何一个缺了，都说明镜像不是这一版 —— 前端产物在
  // public/ 里、后端在 dist/ 里，各自都可能被旧镜像盖住。
  'ratings-no-user-score', // 详情页评分区不再显示「用户评分」那一列（M 站没有可用的用户分）
  'reviews-ui-search-sort', // 媒体评价面板支持按媒体名搜索 + 五种排序
  'reviews-page-jump', // 媒体评价页码可点，直接跳到第 N 页（不再是纯文本）

  // 改密工作流。
  'password-change-api', // POST /api/auth/password 已可用于生产：原密码校验（scrypt）+ 新密码长度下限/上限、业务失败一律 2xx + {ok,code,error}（不用 401，避免被 Web 端当成会话失效）、成功后注销该账户其它会话、NAS 系统账户返回 not_local
  'password-change-ui', // 设置页「修改密码」卡片（原密码 + 新密码 + 确认，按后端 code 本地化提示，无需重启即生效）
] as const;

@Controller()
export class AppController {
  @Get('api/health')
  health(): Record<string, unknown> {
    return {
      status: 'ok',
      uptime: process.uptime(),
      // 版本号由镜像构建期通过 BUILD_VERSION 注入（Dockerfile 从根 package.json
      // 读取），而不是依赖 npm_package_version —— 容器里跑的是
      // `node dist/main.js`，npm 环境变量并不存在，那样只会永远回退到常量。
      // 兜底值用 'unknown' 而不是某个版本号字面量：写死一个号会在「没注入 BUILD_VERSION」
      // 时假装成那个版本，而这恰恰是排障时最不能出错的一处。
      version: process.env.BUILD_VERSION ?? process.env.npm_package_version ?? 'unknown',
      // Build stamp. `npm_package_version` is only set when npm runs the process,
      // which is NOT the case in the container (`node dist/main.js`), so it always
      // fell back to a constant and could not distinguish builds. These two can:
      // BUILD_TIME is baked in at image build time, and the feature list makes a
      // stale deployment obvious from a single curl instead of a code review.
      buildTime: process.env.BUILD_TIME ?? 'dev',
      features: BACKEND_FEATURES,
    };
  }
}