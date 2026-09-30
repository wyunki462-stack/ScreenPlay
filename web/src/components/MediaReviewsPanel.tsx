import { useEffect, useMemo, useState } from "react";
import { ExternalLink, LoaderCircle, MessageSquareQuote, RefreshCw } from "lucide-react";
import { useMediaReviews, useRefreshMediaReviews } from "../api/hooks";
import { useT } from "../i18n";
import {
  ALL_PLATFORMS,
  FIRST_PAGE_COLLAPSED,
  PAGE_SIZE,
  filterByPlatform,
  paginateReviews,
  platformOptions,
  slicePage,
} from "../lib/review-pagination";
import { cn, metacriticTone } from "../lib/utils";
import type { MediaReview, MediaReviewsSummary } from "../types";
import { Button } from "./ui/Button";

/** Colours for the score chip, so a 90 and a 40 are distinguishable at a glance. */
const scoreChipClass: Record<ReturnType<typeof metacriticTone>, string> = {
  green: "border-emerald-700/60 bg-emerald-950/40 text-emerald-300",
  yellow: "border-amber-700/60 bg-amber-950/40 text-amber-300",
  red: "border-rose-800/60 bg-rose-950/40 text-rose-300",
  none: "border-zinc-700 bg-zinc-900/60 text-zinc-400",
};

/**
 * 「媒体评价」 tab: media name, media score, and the review text itself.
 *
 * Reads its own endpoint (`/games/:id/media-reviews`) instead of the component's
 * `game` prop so pressing refresh updates only this panel — refetching the game
 * would re-download posters, screenshots, achievements and the media list.
 *
 * The empty state is deliberately not a single message. `summary.status` tells
 * apart three situations that look identical in the data but need different
 * reactions from the user:
 *   - never fetched  → offer the fetch button;
 *   - fetched, none  → 「暂无媒体评价」 is the honest final answer;
 *   - fetch failed   → show the reason and say retrying is safe.
 * Showing a bare 「暂无媒体评价」 for all three is what makes users think the
 * feature is broken when it is merely unconfigured.
 *
 * 分页而不是一次性全渲染：M 站一部热门游戏能有 60-100 家媒体，全部铺开会把整个
 * 详情页拉成一条长滚动条，也让每一次 `refetch` 都要重建上百个 DOM 节点。
 */
export default function MediaReviewsPanel({
  gameId,
  fallbackReviews,
  fallbackSummary,
}: {
  gameId: string;
  /** Reviews already present in the detail payload, shown before the panel loads. */
  fallbackReviews?: MediaReview[];
  fallbackSummary?: MediaReviewsSummary;
}) {
  const t = useT();
  const [notice, setNotice] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState(false);
  const [platform, setPlatform] = useState<string>(ALL_PLATFORMS);
  const query = useMediaReviews(gameId);
  const refresh = useRefreshMediaReviews(gameId);

  const reviews = query.data?.reviews ?? fallbackReviews ?? [];
  const summary = query.data?.summary ?? fallbackSummary ?? null;
  const status = summary?.status ?? null;

  // 换了游戏就把分页与平台筛选都收回初始值，否则会停在上一个游戏的选择上 ——
  // 而平台是游戏特有的（上一个游戏有 PC 评价、新的未必有），留着会把新游戏
  // 筛成空列表，看起来像「这个游戏没有媒体评价」。
  useEffect(() => {
    setPage(1);
    setExpanded(false);
    setPlatform(ALL_PLATFORMS);
  }, [gameId]);

  // 可选平台取自「评价里真实出现过的平台」，不是游戏自身的平台列表 ——
  // 详见 `platformOptions` 的说明。
  const platforms = useMemo(() => platformOptions(reviews), [reviews]);

  // 当前平台在可选列表里已经不存在时（重新抓取后该平台的评价没了）回落到「全部」，
  // 避免停在一个空选项上。用「派生值」而不是再写一次 state，就不会有中间态闪烁。
  const activePlatform = platforms.some((p) => p.value === platform) ? platform : ALL_PLATFORMS;
  const filtered = useMemo(
    () => filterByPlatform(reviews, activePlatform),
    [reviews, activePlatform],
  );

  // 重新抓取后条数可能从 1 条涨到 60 条，也可能反过来变少；两种情况下停在
  // 越界的页码都会让面板空白，所以页码由 `paginateReviews` 夹回合法范围 ——
  // 渲染时一律用它返回的 `page`，不用本地那份可能越界的 state。
  const paginate = paginateReviews(filtered.length, page, expanded);
  const safePage = paginate.page;

  const onFirstPage = safePage === 1;
  const visible = slicePage(filtered, safePage).slice(
    0,
    onFirstPage && !expanded ? FIRST_PAGE_COLLAPSED : PAGE_SIZE,
  );
  const canExpand = paginate.canExpand;
  const pageCount = paginate.pageCount;

  const onRefresh = () => {
    setNotice(null);
    refresh.mutate(undefined, {
      onSuccess: (res) => {
        if (res.status === "failed") {
          setNotice(t("detail.reviews.refreshFailed", { reason: res.error ?? "—" }));
        } else if (res.status === "skipped") {
          setNotice(t("detail.reviews.refreshFailed", { reason: res.error ?? "—" }));
        } else {
          setNotice(t("detail.reviews.refreshed", { count: res.stored }));
        }
      },
      onError: (err) =>
        setNotice(t("detail.reviews.refreshFailed", { reason: (err as Error).message })),
    });
  };

  return (
    <div className="space-y-4" data-testid="media-reviews-panel">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 text-sm text-zinc-400">
          <MessageSquareQuote className="h-4 w-4 text-zinc-500" />
          <span className="font-medium text-zinc-300">{t("detail.reviews.title")}</span>
          {reviews.length > 0 && (
            <span data-testid="media-reviews-count" className="text-xs text-zinc-500">
              {t("detail.reviews.count", { count: reviews.length })}
            </span>
          )}
          {summary?.fetchedAt ? (
            <span className="text-xs text-zinc-600">
              {t("detail.reviews.fetchedAt", {
                time: new Date(summary.fetchedAt).toLocaleString(),
              })}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {summary?.sourceUrl && (
            <a
              href={summary.sourceUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1 text-xs text-zinc-500 transition-colors hover:text-zinc-300"
            >
              {t("detail.reviews.source")}
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={onRefresh}
            disabled={refresh.isPending}
            data-testid="media-reviews-refresh"
          >
            {refresh.isPending ? (
              <LoaderCircle className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            )}
            {refresh.isPending ? t("detail.reviews.refreshing") : t("detail.reviews.refresh")}
          </Button>
        </div>
      </div>

      {notice && (
        <div
          data-testid="media-reviews-notice"
          className="rounded-lg border border-zinc-700 bg-zinc-900/70 px-4 py-2.5 text-sm text-zinc-300"
        >
          {notice}
        </div>
      )}

      {/* 平台切换。只在真的有多个平台可选时才出现 —— 一个游戏只有单一平台的评价时，
          这个下拉框没有可切的东西，摆在那里只是噪音。
          这里用的是原生 <select> 而不是自绘下拉：它自带键盘操作、移动端会唤起系统
          选择器，而本组件在手机上同样会被用到。 */}
      {reviews.length > 0 && platforms.length > 2 && (
        <div className="flex flex-wrap items-center gap-2">
          <label
            htmlFor="media-reviews-platform"
            className="text-xs text-zinc-500"
          >
            {t("detail.reviews.filterPlatform")}
          </label>
          <select
            id="media-reviews-platform"
            data-testid="media-reviews-platform-select"
            value={activePlatform}
            onChange={(e) => {
              setPlatform(e.target.value);
              // 换了平台就回到第一页的初始形态：新平台下页码很可能越界，
              // 而且用户期待的是「从头看这个平台的评价」。
              setPage(1);
              setExpanded(false);
            }}
            className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200 outline-none transition-colors hover:border-zinc-600 focus:border-cyan-700"
          >
            {platforms.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.value === ALL_PLATFORMS
                  ? t("detail.reviews.platformCount", {
                      platform: t("detail.reviews.allPlatforms"),
                      count: opt.count,
                    })
                  : t("detail.reviews.platformCount", {
                      platform: opt.value,
                      count: opt.count,
                    })}
              </option>
            ))}
          </select>
          {/* 当前筛选下有几条 —— 让「切过去变空了」这件事有明确解释。 */}
          {activePlatform !== ALL_PLATFORMS && (
            <span className="text-xs text-zinc-600" data-testid="media-reviews-platform-active">
              {activePlatform}
            </span>
          )}
        </div>
      )}

      {reviews.length === 0 ? (
        // 这个游戏一条评价都没有：靠 `status` 区分「从没抓过 / 抓过但没有 / 抓取失败」。
        <EmptyState status={status} error={summary?.error ?? null} />
      ) : filtered.length === 0 ? (
        // 游戏有评价、但当前平台一条都没有：说清是筛选造成的，不要复用
        // 「暂无媒体评价」—— 那句话会让用户以为这个游戏根本没有媒体评价。
        <div
          data-testid="media-reviews-platform-empty"
          className="rounded-lg border border-dashed border-zinc-800 p-8 text-center text-sm text-zinc-500"
        >
          <div className="font-medium text-zinc-400">{t("detail.reviews.platformEmpty")}</div>
          <div className="mt-1 text-xs">{t("detail.reviews.platformEmptyHint")}</div>
        </div>
      ) : (
        <>
          <ul className="space-y-3" data-testid="media-reviews-list">
            {visible.map((review) => (
              <ReviewCard key={review.id} review={review} />
            ))}
          </ul>

          <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
            {canExpand && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setExpanded(true)}
                data-testid="media-reviews-expand"
              >
                {t("detail.reviews.expand", { n: PAGE_SIZE })}
              </Button>
            )}

            {pageCount > 1 && (
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={safePage <= 1}
                  onClick={() => {
                    setPage(safePage - 1);
                    // 翻页后回到「默认 5 条」的初始形态。
                    setExpanded(false);
                  }}
                  data-testid="media-reviews-prev"
                >
                  {t("detail.reviews.prevPage")}
                </Button>
                <span
                  className="text-xs text-zinc-500"
                  data-testid="media-reviews-page"
                >
                  {t("detail.reviews.pageOf", { page: safePage, total: pageCount })}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={safePage >= pageCount}
                  onClick={() => {
                    setPage(safePage + 1);
                    setExpanded(false);
                  }}
                  data-testid="media-reviews-next"
                >
                  {t("detail.reviews.nextPage")}
                </Button>
              </div>
            )}
          </div>

          {/* 告诉用户「当前显示了几条 / 一共几条」，否则翻页时看不出还剩多少。
              分页控件只在多于 1 页时出现，这条提示则始终显示。
              数字取自 `filtered`：选了平台之后，用户关心的是**这个平台**有多少条，
              而不是全部平台的总数（总数在上方的标题行里另有一处）。 */}
          <p
            className="text-center text-[11px] text-zinc-600"
            data-testid="media-reviews-shown"
          >
            {t("detail.reviews.shown", { shown: visible.length, total: filtered.length })}
          </p>
        </>
      )}
    </div>
  );
}

function ReviewCard({ review }: { review: MediaReview }) {
  const t = useT();
  const tone = metacriticTone(review.score);
  return (
    <li
      data-testid="media-review-card"
      className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4 transition-colors hover:border-zinc-700"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        {/* 媒体名称 */}
        <div className="min-w-0">
          <div
            data-testid="media-review-outlet"
            className="text-sm font-semibold text-zinc-100"
          >
            {review.outlet}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500">
            {review.platform && (
              <span>
                {t("detail.reviews.platform")}: {review.platform}
              </span>
            )}
            {review.author && (
              <span>
                {t("detail.reviews.author")}: {review.author}
              </span>
            )}
            {review.publishedAt && <span>{review.publishedAt}</span>}
          </div>
        </div>

        {/* 媒体打分 */}
        <div className="flex shrink-0 items-center gap-2">
          {review.score != null ? (
            <span
              data-testid="media-review-score"
              className={cn(
                "inline-flex h-9 min-w-[2.75rem] items-center justify-center rounded-md border px-2 text-lg font-black",
                scoreChipClass[tone],
              )}
            >
              {review.score}
            </span>
          ) : (
            <span className="rounded-md border border-zinc-800 bg-zinc-950/60 px-2 py-1 text-xs text-zinc-500">
              {review.verdict ?? t("detail.reviews.noScore")}
            </span>
          )}
        </div>
      </div>

      {/* 媒体评价原文 */}
      {review.text ? (
        <blockquote
          data-testid="media-review-text"
          className="mt-3 border-l-2 border-zinc-700 pl-3 text-sm leading-relaxed text-zinc-300"
        >
          {review.text}
        </blockquote>
      ) : (
        <p className="mt-3 text-xs italic text-zinc-600">{t("detail.reviews.noScore")}</p>
      )}

      {review.url && (
        <a
          href={review.url}
          target="_blank"
          rel="noreferrer noopener"
          className="mt-2 inline-flex items-center gap-1 text-xs text-zinc-500 transition-colors hover:text-cyan-400"
        >
          {t("detail.reviews.readOriginal")}
          <ExternalLink className="h-3 w-3" />
        </a>
      )}
    </li>
  );
}

/**
 * The three empty cases, spelled out.
 *
 * `null` status means the game predates this feature entirely (no fetch was ever
 * attempted on its behalf), which is the same user-facing situation as
 * `neverFetched`.
 */
function EmptyState({ status, error }: { status: string | null; error: string | null }) {
  const t = useT();

  if (status === "failed") {
    return (
      <div
        data-testid="media-reviews-empty"
        className="space-y-2 rounded-lg border border-amber-900/50 bg-amber-950/20 p-6 text-center"
      >
        <p className="text-sm text-amber-300">
          {t("detail.reviews.failed", { reason: error ?? "—" })}
        </p>
        <p className="text-xs text-zinc-400">{t("detail.reviews.failedHint")}</p>
      </div>
    );
  }

  if (status === "unsupported") {
    return (
      <div
        data-testid="media-reviews-empty"
        className="rounded-lg border border-dashed border-zinc-800 p-8 text-center text-sm text-zinc-500"
      >
        {t("detail.reviews.unsupported")}
      </div>
    );
  }

  if (status === "empty") {
    return (
      <div
        data-testid="media-reviews-empty"
        className="rounded-lg border border-dashed border-zinc-800 p-8 text-center text-sm text-zinc-500"
      >
        <div className="font-medium text-zinc-400">{t("detail.reviews.empty")}</div>
        <div className="mt-1 text-xs">{t("detail.reviews.noneFound")}</div>
      </div>
    );
  }

  // null / "ok"-with-no-rows / never fetched.
  return (
    <div
      data-testid="media-reviews-empty"
      className="rounded-lg border border-dashed border-zinc-800 p-8 text-center text-sm text-zinc-500"
    >
      <div className="font-medium text-zinc-400">{t("detail.reviews.empty")}</div>
      <div className="mt-1 text-xs">{t("detail.reviews.neverFetched")}</div>
    </div>
  );
}