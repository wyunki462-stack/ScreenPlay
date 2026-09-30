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