import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";
import type {
  AchievementCandidate,
  AchievementTarget,
  AchievementsResponse,
  GameDetail,
  GameSummary,
  Media,
  Poster,
  PosterMode,
  MediaReviewsBackfillResult,
  MediaReviewsCoverage,
  MediaReviewsResponse,
  RatingCandidatesResponse,
  Stats,
} from "../types";

export type GameSortField =
  | "custom"
  | "name"
  | "created"
  | "duration"
  | "mediaCount"
  | "metacritic";
export type SortOrder = "asc" | "desc";

export interface GameFilters {
  search?: string;
  platform?: string;
  sort?: GameSortField;
  order?: SortOrder;
  yearMin?: number;
  yearMax?: number;
  minScore?: number;
  maxScore?: number;
}

function toQuery(filters: GameFilters): string {
  const params = new URLSearchParams();
  if (filters.search) params.set("search", filters.search);
  if (filters.platform) params.set("platform", filters.platform);
  if (filters.sort) params.set("sort", filters.sort);
  if (filters.order) params.set("order", filters.order);
  if (filters.yearMin != null) params.set("yearMin", String(filters.yearMin));
  if (filters.yearMax != null) params.set("yearMax", String(filters.yearMax));
  if (filters.minScore != null) params.set("minScore", String(filters.minScore));
  if (filters.maxScore != null) params.set("maxScore", String(filters.maxScore));
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export function useGames(filters: GameFilters = {}) {
  return useQuery({
    queryKey: ["games", filters],
    queryFn: () => apiFetch<GameSummary[]>(`/games${toQuery(filters)}`),
  });
}

export function useGame(id: string | undefined) {
  return useQuery({
    queryKey: ["game", id],
    queryFn: () => apiFetch<GameDetail>(`/games/${encodeURIComponent(id as string)}`),
    enabled: !!id,
    // 详情缓存：二次进入同一详情页不再重发请求。首访时这条请求要等后端在请求
    // 线程里跑完一整轮外网元数据刮削（冷刮削可达数十秒），缓存久一点能省掉重复
    // 的整轮刮削；页面本身已用列表缓存先把封面与基础信息画出来（渐进渲染）。
    // 只改这三条详情相关 query，不动 main.tsx 的全局默认值。
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
  });
}

/**
 * 相册列表。
 *
 * `options.enabled`（默认 true，既有调用点行为不变）让调用方把请求压到首屏之后；
 * 详情页保持默认（它是纯 SQLite 查询，几毫秒返回，空文件夹还要靠它立刻出空态）。
 * 缓存同上：二次进入同一详情页不再重发。
 */
export function useGameMedia(id: string | undefined, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["media", id],
    queryFn: () => apiFetch<Media[]>(`/games/${encodeURIComponent(id as string)}/media`),
    enabled: !!id && (options?.enabled ?? true),
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
  });
}

export function useAchievements(gameId: string | undefined) {
  return useQuery({
    queryKey: ["achievements", gameId],
    queryFn: () =>
      apiFetch<AchievementsResponse>(`/achievements/${encodeURIComponent(gameId as string)}`),
    enabled: !!gameId,
  });
}

/**
 * Candidate entries for the 「手动选择游戏」 picker.
 *
 * Searches every achievement source at once (Steam + the trophy sites) so the
 * user can pick the right release by eye — the fix for folder names like "007"
 * that cannot distinguish "007 First Light" from "GoldenEye 007".
 */
export function useAchievementCandidates(gameId: string | undefined, query: string) {
  const q = query.trim();
  return useQuery({
    queryKey: ["achievement-candidates", gameId, q],
    queryFn: () =>
      apiFetch<{ items: AchievementCandidate[]; target: AchievementTarget | null }>(
        `/achievements/${encodeURIComponent(gameId as string)}/candidates?q=${encodeURIComponent(q)}`,
      ),
    enabled: !!gameId && q.length > 0,
  });
}

/** The hand-picked achievement target currently saved for this game. */
export function useAchievementTarget(gameId: string | undefined) {
  return useQuery({
    queryKey: ["achievement-target", gameId],
    queryFn: () =>
      apiFetch<{ target: AchievementTarget | null }>(
        `/achievements/${encodeURIComponent(gameId as string)}/target`,
      ),
    enabled: !!gameId,
  });
}

/**
 * Save a hand-picked target and re-scrape from it.
 *
 * The backend persists the choice and re-scrapes in the same request, so the
 * returned payload is already the new data — paint it directly.
 */
/** Neighbours of a game in the current gallery order. */
export interface GameNeighbors {
  prev: { id: string; name: string } | null;
  next: { id: string; name: string } | null;
  /** -1 when the current filters hide this game. */
  index: number;
  total: number;
}

/**
 * Previous/next game in the gallery order.
 *
 * The ordering is computed on the server from the same filters the gallery is
 * using, so it stays exact beyond the loaded page and inside a filtered subset.
 */
export function useGameNeighbors(
  id: string | undefined,
  filters: GameFilters,
  options?: { enabled?: boolean },
) {
  const params = new URLSearchParams();
  if (filters.search) params.set("search", filters.search);
  if (filters.platform) params.set("platform", filters.platform);
  if (filters.minScore) params.set("minScore", String(filters.minScore));
  if (filters.sort) params.set("sort", filters.sort);
  if (filters.order) params.set("order", filters.order);
  const qs = params.toString();
  return useQuery({
    queryKey: ["game-neighbors", id, qs],
    queryFn: () =>
      apiFetch<GameNeighbors>(`/games/${encodeURIComponent(id as string)}/neighbors?${qs}`),
    enabled: !!id && (options?.enabled ?? true),
    // 详情页把这条请求延后到浏览器空闲（它只服务标题上方那两个按钮）。筛选条件
    // 已经在 queryKey 里，缓存久了也不会串味；二次进入不再重发。
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
  });
}

/**
 * Persist a drag-and-drop gallery move.
 *
 * Only the dragged id and its two new neighbours travel over the wire, so the
 * request is the same whether the gallery has 20 games or 2000 — and it stays
 * correct when a filter hides most of them.
 */
export function useReorderGames() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { gameId: string; beforeId: string | null; afterId: string | null }) =>
      apiFetch<{ ok: boolean }>("/games/order", {
        method: "PUT",
        body: JSON.stringify(vars),
      }),
    // The grid already shows the new order optimistically, so a refetch here is
    // only about agreeing with the server — no spinner, no flicker.
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["games"] });
    },
  });
}

/** Drop every hand-set position and return to the default order. */
export function useResetGameOrder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<{ ok: boolean; cleared: number }>("/games/order", { method: "DELETE" }),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: ["games"] });
    },
  });
}

/**
 * Metacritic entries the user can choose as this game's score source.
 *
 * Fetched lazily: the picker only mounts when the user opens it, and searching
 * Metacritic is not free.
 */
export function useRatingCandidates(gameId: string | undefined, query: string) {
  return useQuery({
    queryKey: ["rating-candidates", gameId, query.trim()],
    queryFn: () =>
      apiFetch<RatingCandidatesResponse>(
        `/games/${encodeURIComponent(gameId as string)}/rating-candidates?q=${encodeURIComponent(query.trim())}`,
      ),
    enabled: !!gameId,
  });
}

/** Pin this game's score to a specific Metacritic platform entry. */
export function useSetRatingTarget(gameId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      externalId: string;
      name?: string | null;
      platform?: string | null;
      metascore?: number | null;
      releaseDate?: string | null;
    }) =>
      apiFetch<GameDetail>(`/games/${encodeURIComponent(gameId as string)}/rating-target`, {
        method: "PUT",
        body: JSON.stringify(vars),
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(["game", gameId], data);
    },
    onSettled: () => {
      // Cards read the same score from the list payload, so both must refresh.
      void queryClient.invalidateQueries({ queryKey: ["game", gameId] });
      void queryClient.invalidateQueries({ queryKey: ["games"] });
    },
  });
}

/** Go back to automatic score matching. */
export function useClearRatingTarget(gameId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<GameDetail>(
        `/games/${encodeURIComponent(gameId as string)}/rating-target`,
        { method: "DELETE" },
      ),
    onSuccess: (data) => {
      queryClient.setQueryData(["game", gameId], data);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["game", gameId] });
      void queryClient.invalidateQueries({ queryKey: ["games"] });
    },
  });
}

export function useSetAchievementTarget(gameId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { source: string; externalId: string; name?: string | null }) =>
      apiFetch<AchievementsResponse>(
        `/achievements/${encodeURIComponent(gameId as string)}/target`,
        { method: "PUT", body: JSON.stringify(vars) },
      ),
    onSuccess: (data) => {
      queryClient.setQueryData(["achievements", gameId], data);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["achievements", gameId] });
      void queryClient.invalidateQueries({ queryKey: ["achievement-target", gameId] });
      void queryClient.invalidateQueries({ queryKey: ["game", gameId] });
    },
  });
}

/** Drop the manual choice and go back to automatic matching. */
export function useClearAchievementTarget(gameId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<AchievementsResponse>(
        `/achievements/${encodeURIComponent(gameId as string)}/target`,
        { method: "DELETE" },
      ),
    onSuccess: (data) => {
      queryClient.setQueryData(["achievements", gameId], data);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["achievements", gameId] });
      void queryClient.invalidateQueries({ queryKey: ["achievement-target", gameId] });
    },
  });
}

/**
 * Force a re-scrape of this game's achievements / trophies.
 *
 * The backend scrapes synchronously, so the request can take ~30s — callers must
 * render a pending state. A scrape failure still answers HTTP 200 with
 * `status: "failed"`, which means `isError` only covers transport/HTTP failures;
 * the payload itself has to be inspected for scrape errors.
 */
export function useRefreshAchievements(gameId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<AchievementsResponse>(
        `/games/${encodeURIComponent(gameId as string)}/achievements/refresh`,
        { method: "POST" },
      ),
    onSuccess: (data) => {
      // The scrape already happened, so paint the fresh payload straight away
      // instead of leaving the stale list on screen until the refetch lands.
      queryClient.setQueryData(["achievements", gameId], data);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["achievements", gameId] });
    },
  });
}

export function useStats() {
  return useQuery({
    queryKey: ["stats"],
    queryFn: () => apiFetch<Stats>("/stats"),
  });
}



export function useScanLibrary() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<{ started: boolean }>("/library/scan", { method: "POST" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["library"] });
      void queryClient.invalidateQueries({ queryKey: ["stats"] });
      void queryClient.invalidateQueries({ queryKey: ["games"] });
    },
  });
}

export function useRefreshGame(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<{ refreshed: boolean }>(`/games/${encodeURIComponent(id)}/refresh`, {
        method: "POST",
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["game", id] });
      void queryClient.invalidateQueries({ queryKey: ["media", id] });
      void queryClient.invalidateQueries({ queryKey: ["achievements", id] });
      void queryClient.invalidateQueries({ queryKey: ["games"] });
    },
  });
}

export interface GameUpdateInput {
  name?: string;
  platform?: string;
  /** Feature 6: multi-select platform override. */
  platforms?: string[];
  /** Feature 5: gallery card cover mode. */
  posterMode?: PosterMode;
}

export function useUpdateGame(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: GameUpdateInput) =>
      apiFetch<GameDetail>(`/games/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["game", id] });
      void queryClient.invalidateQueries({ queryKey: ["games"] });
    },
  });
}

export function useDeleteGame(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (opts: { deleteFiles?: boolean } = {}) =>
      apiFetch<{ deleted: boolean; removedFiles: boolean }>(
        `/games/${encodeURIComponent(id)}?deleteFiles=${opts.deleteFiles ? "true" : "false"}`,
        { method: "DELETE" },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["games"] });
      void queryClient.invalidateQueries({ queryKey: ["stats"] });
      void queryClient.invalidateQueries({ queryKey: ["library"] });
    },
  });
}

export interface ApiSettings {
  rawgApiKey: string;
  rawgProxy: string;
  igdbClientId: string;
  igdbClientSecret: string;
  steamApiKey: string;
  steamdbKey: string;
  scrapers?: string[];
}

export function useSettings() {
  return useQuery({
    queryKey: ["settings"],
    queryFn: () => apiFetch<ApiSettings>("/settings"),
  });
}

export function useSaveSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: Partial<ApiSettings>) =>
      apiFetch<ApiSettings>("/settings", { method: "PUT", body: JSON.stringify(input) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
  });
}

export function useTestRawg() {
  return useMutation({
    mutationFn: () => apiFetch<{ ok: boolean; message: string }>("/settings/test-rawg"),
  });
}

/**
 * Live Steam *achievement* test.
 *
 * Achievements come from `api.steampowered.com` while covers/prices come from
 * `store.steampowered.com` — different hosts with different reachability, so a
 * working key can still yield an empty achievements tab. This reports the real
 * HTTP status instead of leaving the user to guess.
 */
export function useTestSteamAchievements() {
  return useMutation({
    mutationFn: () =>
      apiFetch<{ ok: boolean; message: string; detail?: Record<string, unknown> }>(
        "/settings/test-steam-achievements",
      ),
  });
}

export function useTestImage() {
  return useMutation({
    mutationFn: () => apiFetch<{ ok: boolean; message: string }>("/settings/test-image"),
  });
}

export interface ProxyDiagnosis {
  ok: boolean;
  message: string;
  configured: string;
  validated: string;
  hostGateway: string | null;
  candidates: { url: string; http: boolean; https: boolean }[];
}

/** Diagnose the proxy address itself and suggest a working alternative. */
export function useTestProxy() {
  return useMutation({
    // Pass the current field value so a not-yet-saved (or invalid) address can
    // still be reported on — PUT rejects bad addresses, so it never reaches the DB.
    mutationFn: (url?: string) =>
      apiFetch<ProxyDiagnosis>(
        `/settings/test-proxy${url ? `?url=${encodeURIComponent(url)}` : ""}`,
      ),
  });
}

export function useRefreshAll() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<{ started: boolean; total: number }>("/games/refresh-all", {
        method: "POST",
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["metadata-status"] });
    },
  });
}

export interface MetadataProgress {
  running: boolean;
  total: number;
  done: number;
  current: string | null;
  failed: number;
  /** Which bulk job is running ("Refresh all" / "Completion-time backfill"). */
  label?: string | null;
}

export function useMetadataStatus() {
  return useQuery({
    queryKey: ["metadata-status"],
    queryFn: () => apiFetch<MetadataProgress>("/games/refresh-all/status"),
    // Fast while a bulk job runs (the progress bar has to move); slow when idle,
    // where nothing local can change on its own. Both mutations that START a job
    // invalidate this query, so the switch to the 1500ms cadence happens on the
    // same tick as the click — no user-visible lag.
    // (react-query also stops the interval while the tab is hidden.)
    // The idle rate is deliberately left at its pre-optimisation value: raising it
    // only trims idle requests (no memory/storage win) while making changes made by
    // *other* clients appear later, which this round's "interaction unchanged"
    // constraint rules out. See docs/perf/PERF-REPORT.md §八 for the one-line variant.
    refetchInterval: (query) => (query.state.data?.running ? 1500 : 5000),
  });
}

/**
 * How many games still lack a completion time.
 *
 * Drives the settings page's 「一键批量补全通关时长」 button, so the user can see
 * how many games the job is worth running for — and that it worked afterwards.
 */
export interface DurationCoverage {
  total: number;
  withDuration: number;
  missing: number;
  nextToTry: string[];
  sources: { source: string; count: number }[];
}

export function useDurationCoverage() {
  return useQuery({
    queryKey: ["duration-coverage"],
    queryFn: () => apiFetch<DurationCoverage>("/games/duration-coverage"),
    // Poll while there is anything left to backfill (a bulk job may be running and
    // the counter should move with the progress bar); rare poll otherwise.
    // Idle cadence kept at its pre-optimisation value for the same reason as above.
    refetchInterval: (query) => (query.state.data?.missing ? 6000 : 20000),
  });
}

/**
 * Re-fetch completion times for every game that still has none.
 *
 * Far cheaper than a full re-scrape: it runs only the duration providers, and it
 * repairs games whose first scrape happened while the duration source was
 * unreachable (they would otherwise show 「未知」 forever, because their
 * `last_meta_refresh` is already set and a scan leaves them alone).
 */
export function useBackfillDurations() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<{ started: boolean; total: number }>("/games/backfill-durations", {
        method: "POST",
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["metadata-status"] });
      void queryClient.invalidateQueries({ queryKey: ["duration-coverage"] });
    },
  });
}

export interface MatchCandidate {
  provider: string;
  externalId: string;
  name: string;
  platform: string | null;
  releaseYear: number | null;
}

export function useSearchMatches(query: string) {
  return useQuery({
    queryKey: ["match-search", query],
    queryFn: () => apiFetch<MatchCandidate[]>(`/games/match/search?q=${encodeURIComponent(query)}`),
    enabled: query.trim().length >= 2,
  });
}

export function useMatchGame(id: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { provider: string; externalId: string }) =>
      apiFetch<{
        matched: boolean;
        name?: string;
        providers?: string[];
        failed?: string[];
        missing?: string[];
        reason?: string;
      }>(
        `/games/${encodeURIComponent(id as string)}/match`,
        {
          method: "POST",
          body: JSON.stringify(input),
        },
      ),
    onSuccess: () => {
      // A re-match replaces the whole identity, so every view derived from it
      // must be re-read: detail page, gallery card, album, poster list and the
      // achievements tab. Leaving `posters` out kept the previous game's artwork
      // in the cover picker after the switch.
      void queryClient.invalidateQueries({ queryKey: ["game", id] });
      void queryClient.invalidateQueries({ queryKey: ["games"] });
      void queryClient.invalidateQueries({ queryKey: ["media", id] });
      void queryClient.invalidateQueries({ queryKey: ["posters", id] });
      void queryClient.invalidateQueries({ queryKey: ["achievements", id] });
    },
  });
}
// --- Posters (features 4 & 5) ------------------------------------------------

export function usePosters(gameId: string | undefined) {
  return useQuery({
    queryKey: ["posters", gameId],
    queryFn: () => apiFetch<Poster[]>(`/games/${encodeURIComponent(gameId as string)}/posters`),
    enabled: !!gameId,
    // The poster list drives the "取消封面" entry, so a cached copy captured
    // before a self-heal would keep the dialog showing a stale, button-less
    // state for the whole staleTime window. Always re-read when the dialog opens.
    refetchOnMount: "always",
  });
}

/**
 * Ask the server to repair a missing cover flag, then refresh the lists.
 *
 * Older rows could carry `games.poster_url` while no `game_posters` row was
 * marked `is_selected`, which left the dialog with no cancel entry at all. The
 * read path heals this too, but calling it explicitly on dialog open makes the
 * repair happen before the user looks at the list rather than after.
 */
export function useReconcilePosters(gameId: string | undefined) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: ["posters-reconcile", gameId],
    enabled: !!gameId,
    staleTime: Infinity,
    queryFn: async () => {
      const res = await apiFetch<{ repaired: boolean }>(
        `/games/${encodeURIComponent(gameId as string)}/posters/reconcile`,
        { method: "POST" },
      );
      if (res.repaired) {
        void queryClient.invalidateQueries({ queryKey: ["posters", gameId] });
        void queryClient.invalidateQueries({ queryKey: ["game", gameId] });
        void queryClient.invalidateQueries({ queryKey: ["games"] });
      }
      return res;
    },
  });
}

function usePosterMutation<TInput>(gameId: string | undefined, run: (input: TInput) => Promise<unknown>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["posters", gameId] });
      void queryClient.invalidateQueries({ queryKey: ["game", gameId] });
      void queryClient.invalidateQueries({ queryKey: ["games"] });
    },
  });
}

/** Upload a local image file as a poster. */
export function useUploadPoster(gameId: string | undefined) {
  return usePosterMutation<File>(gameId, (file) => {
    const form = new FormData();
    form.append("file", file);
    return apiFetch<{ poster: Poster }>(
      `/games/${encodeURIComponent(gameId as string)}/posters/upload`,
      { method: "POST", body: form },
    );
  });
}

/** Use one of the game's existing album images as a poster. */
export function usePosterFromMedia(gameId: string | undefined) {
  return usePosterMutation<string>(gameId, (mediaId) =>
    apiFetch<{ poster: Poster }>(
      `/games/${encodeURIComponent(gameId as string)}/posters/from-media`,
      { method: "POST", body: JSON.stringify({ mediaId }) },
    ),
  );
}

/** Choose which poster is the gallery cover. */
export function useSelectPoster(gameId: string | undefined) {
  return usePosterMutation<string>(gameId, (posterId) =>
    apiFetch<{ selected: string }>(
      `/games/${encodeURIComponent(gameId as string)}/posters/select`,
      { method: "POST", body: JSON.stringify({ posterId }) },
    ),
  );
}

/**
 * Cancel the current cover and restore the game's official poster.
 *
 * Distinct from the other poster mutations: it takes no posterId because the
 * whole selection is being given back, and the server decides what the default
 * cover should be.
 */
export function useClearPosterSelection(gameId: string | undefined) {
  return usePosterMutation<void>(gameId, () =>
    apiFetch<{ selected: string | null; posterUrl: string | null; restored: string | null }>(
      `/games/${encodeURIComponent(gameId as string)}/posters/clear-selection`,
      { method: "POST" },
    ),
  );
}

/** Include/exclude a poster from the slideshow. */
export function useTogglePosterSlideshow(gameId: string | undefined) {
  return usePosterMutation<{ posterId: string; inSlideshow: boolean }>(gameId, ({ posterId, inSlideshow }) =>
    apiFetch<{ updated: boolean }>(
      `/games/${encodeURIComponent(gameId as string)}/posters/${encodeURIComponent(posterId)}`,
      { method: "PATCH", body: JSON.stringify({ inSlideshow }) },
    ),
  );
}

export function useDeletePoster(gameId: string | undefined) {
  return usePosterMutation<string>(gameId, (posterId) =>
    apiFetch<{ removed: boolean }>(
      `/games/${encodeURIComponent(gameId as string)}/posters/${encodeURIComponent(posterId)}`,
      { method: "DELETE" },
    ),
  );
}

// --- Media library roots (feature 2) -----------------------------------------

export interface LibraryRoot {
  id: string;
  path: string;
  label: string | null;
  mediaType: "auto" | "image" | "video";
  recursive: boolean;
  enabled: boolean;
  sortOrder: number;
  source: "env" | "user";
  createdAt: string | null;
  exists: boolean;
  gameCount: number | null;
}

export interface RootCheck {
  ok: boolean;
  path: string;
  exists: boolean;
  isDirectory: boolean;
  readable: boolean;
  subdirectories: number;
  sampleNames: string[];
  mountedHint?: string | null;
  message: string;
}

export function useLibraryRoots() {
  return useQuery({
    queryKey: ["library-roots"],
    queryFn: () => apiFetch<LibraryRoot[]>("/library/roots"),
  });
}

/** Validate a path before saving (debounced by the caller). */
export function useCheckRoot(path: string) {
  return useQuery({
    queryKey: ["library-root-check", path],
    queryFn: () => apiFetch<RootCheck>(`/library/roots/check?path=${encodeURIComponent(path)}`),
    enabled: path.trim().length > 0,
    retry: false,
  });
}

export function useMountedRoots() {
  return useQuery({
    queryKey: ["library-roots-mounted"],
    queryFn: () => apiFetch<{ paths: string[] }>("/library/roots/mounted"),
  });
}

export interface SaveRootInput {
  path?: string;
  label?: string;
  mediaType?: "auto" | "image" | "video";
  recursive?: boolean;
  enabled?: boolean;
  scan?: boolean;
}

export function useAddLibraryRoot() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SaveRootInput) =>
      apiFetch<{ root: LibraryRoot; scanStarted: boolean }>("/library/roots", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["library-roots"] });
      void queryClient.invalidateQueries({ queryKey: ["library-status"] });
      void queryClient.invalidateQueries({ queryKey: ["games"] });
      void queryClient.invalidateQueries({ queryKey: ["stats"] });
    },
  });
}

export function useUpdateLibraryRoot() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SaveRootInput & { id: string }) =>
      apiFetch<{ root: LibraryRoot }>("/library/roots", {
        method: "PATCH",
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["library-roots"] });
      void queryClient.invalidateQueries({ queryKey: ["games"] });
    },
  });
}

export function useDeleteLibraryRoot() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ removed: boolean; note?: string }>(
        `/library/roots?id=${encodeURIComponent(id)}`,
        { method: "DELETE" },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["library-roots"] });
      void queryClient.invalidateQueries({ queryKey: ["games"] });
    },
  });
}

/** Distinct platforms with counts, for the gallery filter dropdown. */
export function usePlatformOptions() {
  return useQuery({
    queryKey: ["platform-options"],
    queryFn: () => apiFetch<{ value: string; count: number }[]>("/games/platforms"),
  });
}

/**
 * 媒体评价 for one game.
 *
 * Reads the panel's own endpoint rather than the game detail payload so a refresh
 * after a backfill does not re-fetch posters, achievements and media as well.
 */
export function useMediaReviews(id: string | undefined) {
  return useQuery({
    queryKey: ["media-reviews", id],
    queryFn: () => apiFetch<MediaReviewsResponse>(`/games/${encodeURIComponent(id as string)}/media-reviews`),
    enabled: !!id,
  });
}

/** Re-fetch 媒体评价 for a single game (the panel's refresh button). */
export function useRefreshMediaReviews(id: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<{ status: string; stored: number; error: string | null }>(
        `/games/${encodeURIComponent(id as string)}/media-reviews/refresh`,
        { method: "POST" },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["media-reviews", id] });
      // The Metascore lives on the same page, so it may have changed too.
      void queryClient.invalidateQueries({ queryKey: ["game", id] });
      void queryClient.invalidateQueries({ queryKey: ["media-reviews-coverage"] });
    },
  });
}

/** Coverage numbers for the settings card (how many games still have none). */
export function useMediaReviewsCoverage() {
  return useQuery({
    queryKey: ["media-reviews-coverage"],
    queryFn: () => apiFetch<MediaReviewsCoverage>("/games/media-reviews/coverage"),
  });
}

/**
 * 批量补全媒体评价 — `POST /games/backfill-ratings`.
 *
 * Unlike the other backfills this one is synchronous and returns a per-game
 * result list, because the caller needs to see WHICH games came back empty
 * versus blocked (those need different reactions), and the source site must not
 * be hit in parallel.
 */
export function useBackfillMediaReviews() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { scope?: "missing" | "all"; limit?: number } = {}) =>
      apiFetch<MediaReviewsBackfillResult>("/games/backfill-ratings", {
        method: "POST",
        body: JSON.stringify(vars),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["media-reviews-coverage"] });
      void queryClient.invalidateQueries({ queryKey: ["game"] });
      void queryClient.invalidateQueries({ queryKey: ["media-reviews"] });
    },
  });
}
