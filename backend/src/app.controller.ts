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
  'scraped-posters-all',
  'duration-cache-guard',
  // 本轮新增/明确的能力。单独列出来，是为了让「部署的镜像是不是这一版」变成
  // 一条 curl 就能判断的事：前端产物在 public/ 里，后端产物在 dist/ 里，
  // 两者都可能被旧镜像覆盖，而 features 列表一定跟着镜像走。
  'hero-poster-carousel', // 详情页大图区官方海报轮播（左右箭头 + x/y 计数，循环）
  'duration-coverage-api', // GET /api/games/duration-coverage（设置页补全卡片的数据源）
  'duration-backfill-ui', // 设置页「一键批量补全通关时长」按钮
  // 本轮（第四轮）修「只有个别游戏能翻页」时新增的能力。
  'poster-rotation-all-games', // 官方刮取到的海报/截图全部登记且默认进轮播
  // 第五轮：按需求 21 收口轮播归属。
  //
  // 原来的 `poster-rotation-floor` 标记的正是「官方图不足时用本地相册截图补齐
  // 轮播」这个行为 —— 它已按需求移除（相册截图不再自动进轮播，只有用户勾选才
  // 加入），所以标记也跟着换名。沿用旧名会让人以为补齐逻辑还在。
  'poster-rotation-cover-only', // 只有封面默认进轮播；相册截图仅用户勾选才加入
  'poster-rotation-user-decided', // 取消勾选（含封面）不会被刮削/启动期修复改回
  'card-carousel-vs-hero-carousel', // 首页卡片用完整海报集，详情页大图用轮播勾选集
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
  'card-arrows-need-slideshow', // 首页卡片只有设了轮播才显示上一张/下一张

  // 第九轮（0.6.4）：详情页评分区与媒体评价面板的三处改动。
  //
  // 0.6.3 只改到「抓得全不全」，没动界面本身。这一轮动的是**看得见的东西**，
  // 所以三个标记分开列：任何一个缺了，都说明镜像不是这一版 —— 前端产物在
  // public/ 里、后端在 dist/ 里，各自都可能被旧镜像盖住。
  'ratings-no-user-score', // 详情页评分区不再显示「用户评分」那一列（M 站没有可用的用户分）
  'reviews-ui-search-sort', // 媒体评价面板支持按媒体名搜索 + 五种排序
  'reviews-page-jump', // 媒体评价页码可点，直接跳到第 N 页（不再是纯文本）
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