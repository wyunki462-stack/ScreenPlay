/**
 * SSR 验证用的 API hooks 桩。
 *
 * `PosterDialog` 的海报列表来自 tRPC 查询（`usePosters` / `useGameMedia`）。
 * 在 SSR 里没有 QueryClientProvider 的预取数据，这些查询会一直是 pending ——
 * 组件按 `posters.length === 0` 渲染空状态，于是「勾选框在不在」根本测不到。
 *
 * 这里把数据源直接喂给组件，让它渲染出真实的分组和控件；其余 mutation 一律返回
 * 惰性 no-op（本轮断言不涉及写操作，写路径由 poster-rotation-e2e.mjs 覆盖）。
 */

export const SSR_POSTERS = [
  { id: 'p-official', url: '/p0.png', source: 'scraped', mediaId: null, isSelected: true, inSlideshow: true, slideshowUserSet: false },
  { id: 'p-media-1', url: '/p1.png', source: 'media', mediaId: 'm1', isSelected: false, inSlideshow: false, slideshowUserSet: true },
  { id: 'p-media-2', url: '/p2.png', source: 'media', mediaId: 'm2', isSelected: false, inSlideshow: false, slideshowUserSet: true },
];

export const SSR_MEDIA = [
  { id: 'm1', type: 'image', url: '/p1.png', fileCreatedAt: 1 },
  { id: 'm2', type: 'image', url: '/p2.png', fileCreatedAt: 2 },
];

const noop = () => ({ mutate: () => {}, mutateAsync: async () => ({}), isPending: false, variables: undefined });

export const usePosters = () => ({ data: SSR_POSTERS, isPending: false, isLoading: false, error: null });
export const useGameMedia = () => ({ data: SSR_MEDIA, isPending: false, isLoading: false, error: null });

// 其余 hook：SSR 只渲染，不需要真实行为。
export const useUploadPoster = noop;
export const useDeletePoster = noop;
export const useSelectPoster = noop;
export const useClearPosterSelection = noop;
export const useTogglePosterSlideshow = noop;
export const useUpdateGame = noop;
export const usePosterFromMedia = noop;
export const useReconcilePosters = noop;
export const useSearchPosters = noop;
export const usePosterSearch = noop;

// ── 媒体评价 ──────────────────────────────────────────────────────────────────
//
// `MediaReviewsPanel` 的数据同样来自 query hook。SSR 里没有 QueryClient 预取，
// 不喂数据的话它会渲染空状态，「条数 / 分页 / 平台筛选」就都断言不到。
//
// 评测数据由 `makeReviews()` 按平台生成：**每条都带 platform**，这样才能验证
// 「切到某个平台后只剩该平台的评价」这条要求。故意留三条 `platform: null`
// （真实站点上部分评价没有平台归属），用来确认这些评价不会被任何平台筛掉、
// 也不会被误算进某个平台。
export function makeReviews() {
  // 每条日期都不同，且序号 i 越小越新。
  //
  // 为什么要互不相同：本轮新增了「按时间排序」。如果 13 条全是同一天，切到
  // 「时间从新到旧」后界面看起来什么都没变 —— 浏览器断言就分辨不出它是真的按
  // 日期重排了、还是压根没生效。互不相同之后，newest 应等于原始顺序、oldest
  // 应等于原始顺序的倒序，一眼可验。
  const reviewDate = (i) => new Date(Date.UTC(2024, 8, 30) - i * 86_400_000).toISOString().slice(0, 10);
  const mk = (outlet, score, platform, i) => ({
    id: `r-${i}`,
    gameId: 'g-1',
    source: 'metacritic',
    outlet,
    score,
    verdict: null,
    text: `${outlet} 的评价原文。`,
    url: `https://www.metacritic.com/review/${i}`,
    author: null,
    platform,
    publishedAt: reviewDate(i),
    fetchedAt: 1,
  });
  const ps5 = ['IGN', 'GameSpot', 'Push Square', 'Eurogamer', 'The Guardian', 'Digital Trends']
    .map((o, i) => mk(o, 90 - i, 'PS5', i));
  const pc = ['PC Gamer', 'Rock Paper Shotgun', 'PCGamesN'].map((o, i) => mk(o, 80 - i, 'PC', 100 + i));
  const sw = ['Nintendo Life', 'God is a Geek'].map((o, i) => mk(o, 70 - i, 'Switch', 200 + i));
  const none = [mk('Unknown Outlet A', 60, null, 300), mk('Unknown Outlet B', 55, null, 301)];
  return [...ps5, ...pc, ...sw, ...none];
}

export const SSR_REVIEWS = makeReviews();
export const SSR_REVIEWS_SUMMARY = {
  status: 'ok',
  error: null,
  fetchedAt: 1_700_000_000_000,
  sourceUrl: 'https://www.metacritic.com/game/astro-bot/',
  count: SSR_REVIEWS.length,
};

export const useMediaReviews = () => ({
  data: { reviews: SSR_REVIEWS, summary: SSR_REVIEWS_SUMMARY },
  isPending: false,
  isLoading: false,
  error: null,
});
export const useRefreshMediaReviews = noop;

// ── GameCard 依赖链上的 hook ──────────────────────────────────────────────────
//
// 卡片会渲染 `GameMenu`，而 `GameMenu` 又引 `MatchDialog`。浏览器打包会**真的**
// 沿着这条链解析 import，缺任何一个具名导出都会让打包直接失败 —— 所以即使本轮
// 不测菜单，这几个也必须在这里存在。
//
// （这也暴露了 `poster-ui-ssr.mjs` 的一个盲区：它把裸包名设成 external，esbuild
//   于是不深挖依赖图，桩里少几个导出照样能过。浏览器打包把这个盲区补上了。）
export const useDeleteGame = noop;
export const useRefreshGame = noop;
export const useMatchGame = noop;
export const useSearchMatches = () => ({ data: [], isPending: false, isLoading: false, error: null });