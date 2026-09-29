import { useState } from "react";
import { ExternalLink, LoaderCircle, MessageSquareQuote, RefreshCw } from "lucide-react";
import { useMediaReviews, useRefreshMediaReviews } from "../api/hooks";
import { useT } from "../i18n";
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
  const query = useMediaReviews(gameId);
  const refresh = useRefreshMediaReviews(gameId);

  const reviews = query.data?.reviews ?? fallbackReviews ?? [];
  const summary = query.data?.summary ?? fallbackSummary ?? null;
  const status = summary?.status ?? null;

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

      {reviews.length === 0 ? (
        <EmptyState status={status} error={summary?.error ?? null} />
      ) : (
        <ul className="space-y-3">
          {reviews.map((review) => (
            <ReviewCard key={review.id} review={review} />
          ))}
        </ul>
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