import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Images, Loader2, RotateCcw, Search, Star, Trash2, Upload, X } from "lucide-react";
import {
  useClearPosterSelection,
  useDeletePoster,
  useGameMedia,
  usePosterFromMedia,
  usePosters,
  useReconcilePosters,
  useSelectPoster,
  useTogglePosterSlideshow,
  useUpdateGame,
  useUploadPoster,
} from "../api/hooks";
import type { GameDetail, PosterMode } from "../types";
import { Button } from "./ui/Button";
import LazyImage from "./LazyImage";
import { useT } from "../i18n";

/** How many album tiles to mount at once, and how many more per "load more". */
const ALBUM_PAGE = 60;

/**
 * "编辑海报" dialog (features 4 & 5).
 *
 * Two ways to add a poster — upload a local file, or reuse one of this game's
 * album images — then pick which one is the gallery cover and decide whether
 * the card rotates through them (slideshow mode).
 *
 * Album performance: games routinely hold 100-250 screenshots. The tab used to
 * mount every tile at once, each pointing at the full-size `/preview` rendition
 * (2.5-9.8 MB for a 4K screenshot), so switching to it fired hundreds of
 * multi-megabyte requests. Now tiles are paged, lazily fetched only when they
 * scroll into view, and rendered from the ~6 KB thumbnail.
 */
export default function PosterDialog({
  game,
  onClose,
}: {
  game: GameDetail;
  onClose: () => void;
}) {
  const t = useT();
  const [tab, setTab] = useState<"upload" | "album">("upload");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [albumLimit, setAlbumLimit] = useState(ALBUM_PAGE);
  const [albumFilter, setAlbumFilter] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const { data: posters = [] } = usePosters(game.id);
  // Repair any missing cover flag as soon as the dialog opens, so a game whose
  // selection was never recorded still offers the right buttons immediately.
  useReconcilePosters(game.id);
  const { data: media = [], isPending: mediaPending } = useGameMedia(game.id);
  const upload = useUploadPoster(game.id);
  const fromMedia = usePosterFromMedia(game.id);
  const select = useSelectPoster(game.id);
  const clearSelection = useClearPosterSelection(game.id);
  const toggleSlideshow = useTogglePosterSlideshow(game.id);
  const removePoster = useDeletePoster(game.id);
  const updateGame = useUpdateGame(game.id);

  const mode: PosterMode = game.posterMode ?? "static";
  const albumImages = useMemo(() => media.filter((m) => m.type !== "video"), [media]);

  // Narrowing the list is the fastest way to reach a picture in a 248-image
  // album, and it also cuts the number of mounted tiles.
  const filteredAlbum = useMemo(() => {
    const q = albumFilter.trim().toLowerCase();
    if (!q) return albumImages;
    return albumImages.filter((m) => m.fileName.toLowerCase().includes(q));
  }, [albumImages, albumFilter]);

  // Only mount the first page; the rest appear on demand so opening the tab is
  // bounded regardless of album size.
  const visibleAlbum = useMemo(
    () => filteredAlbum.slice(0, albumLimit),
    [filteredAlbum, albumLimit],
  );

  // A new search should start from the top again.
  useEffect(() => {
    setAlbumLimit(ALBUM_PAGE);
  }, [albumFilter]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  /**
   * Shared mutation options so every poster action surfaces its error inside
   * the dialog instead of failing silently.
   */
  const opts = {
    onSuccess: () => setError(null),
    onError: (e: Error) => setError(e.message),
  };

  /**
   * Cancel the cover and report what happened.
   *
   * The previous wiring reused the generic `opts`, so a successful cancel gave
   * no feedback at all — the poster list simply re-ordered itself, which read as
   * "the button did nothing". The explicit success/error messages below make the
   * result visible, and the mutation's own `invalidateQueries` refreshes the
   * card and detail carousel without a manual reload.
   */
  const clearOpts = {
    onSuccess: () => {
      setError(null);
      setNotice(t("dialogs.poster.cancelNotice"));
    },
    onError: (e: Error) => {
      setNotice(null);
      setError(t("dialogs.poster.cancelError", { message: e.message }));
    },
  };

  // Auto-dismiss the success toast.
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 2600);
    return () => clearTimeout(timer);
  }, [notice]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
          <h3 className="min-w-0 truncate text-sm font-semibold text-zinc-100">
            {t("dialogs.poster.title", { name: game.name })}
          </h3>
          <button onClick={onClose} className="text-zinc-400 transition-colors hover:text-white">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Display mode (feature 5) */}
        <div className="flex flex-wrap items-center gap-3 border-b border-zinc-800 px-4 py-3">
          <span className="text-xs text-zinc-400">{t("dialogs.poster.displayMode")}</span>
          <div className="flex overflow-hidden rounded-md border border-zinc-700">
            {(
              [
                ["static", t("dialogs.poster.modeStatic")],
                ["slideshow", t("dialogs.poster.modeSlideshow")],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                onClick={() =>
                  updateGame.mutate(
                    { posterMode: value },
                    { onError: (e) => setError(e.message) },
                  )
                }
                className={`px-3 py-1.5 text-xs transition-colors ${
                  mode === value
                    ? "bg-sky-600 text-white"
                    : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          {mode === "slideshow" && (
            <span className="text-xs text-zinc-500">
              {t("dialogs.poster.slideshowCount", {
                n: posters.filter((p) => p.inSlideshow).length,
              })}
            </span>
          )}
          {/* 说清楚这套勾选管的是哪个轮播。
              曾经这里只写「已勾选 N 张参与轮播」，而页面上唯一会自动动的是首页
              图库卡片 —— 用户因此以为勾选在控制卡片。实际数据源已经分开（见
              GameCard / HeroPosterCarousel），文案也必须跟着说清楚。 */}
          <span className="text-xs text-zinc-500">
            {t("dialogs.poster.slideshowHint")}
          </span>
        </div>

        {/* Add a poster (feature 4) */}
        <div className="border-b border-zinc-800 px-4 py-3">
          <div className="mb-3 flex gap-2">
            {(
              [
                ["upload", t("dialogs.poster.tabUpload"), Upload],
                ["album", t("dialogs.poster.tabAlbum"), Images],
              ] as const
            ).map(([value, label, Icon]) => (
              <button
                key={value}
                onClick={() => setTab(value)}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs transition-colors ${
                  tab === value
                    ? "bg-zinc-700 text-white"
                    : "bg-zinc-800/60 text-zinc-400 hover:bg-zinc-800"
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
            ))}
          </div>

          {tab === "upload" ? (
            <div className="flex items-center gap-3">
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) upload.mutate(file, opts);
                  e.target.value = "";
                }}
              />
              <Button
                variant="secondary"
                onClick={() => fileRef.current?.click()}
                disabled={upload.isPending}
              >
                {upload.isPending ? (
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                ) : (
                  <Upload className="mr-1.5 h-4 w-4" />
                )}
                {t("dialogs.poster.chooseFile")}
              </Button>
              <span className="text-xs text-zinc-500">{t("dialogs.poster.uploadHint")}</span>
            </div>
          ) : mediaPending ? (
            <div className="flex items-center gap-2 py-6 text-xs text-zinc-500">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t("dialogs.poster.albumLoading")}
            </div>
          ) : albumImages.length === 0 ? (
            <p className="text-xs text-zinc-500">{t("dialogs.poster.albumEmpty")}</p>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
                  <input
                    value={albumFilter}
                    onChange={(e) => setAlbumFilter(e.target.value)}
                    placeholder={t("dialogs.poster.albumFilterPlaceholder", {
                      n: albumImages.length,
                    })}
                    className="w-full rounded-md border border-zinc-700 bg-zinc-800/60 py-1.5 pl-7 pr-2 text-xs text-zinc-200 placeholder:text-zinc-500 focus:border-sky-600 focus:outline-none"
                  />
                </div>
                <span className="shrink-0 text-[10px] text-zinc-500">
                  {t("dialogs.poster.albumShown", {
                    shown: visibleAlbum.length,
                    total: filteredAlbum.length,
                  })}
                </span>
              </div>

              {filteredAlbum.length === 0 ? (
                <p className="py-4 text-center text-xs text-zinc-500">
                  {t("dialogs.poster.albumNoMatch")}
                </p>
              ) : (
                <div className="grid max-h-52 grid-cols-4 gap-2 overflow-y-auto sm:grid-cols-6">
                  {visibleAlbum.map((m) => {
                    const used = posters.some((p) => p.mediaId === m.id);
                    return (
                      <button
                        key={m.id}
                        disabled={used || fromMedia.isPending}
                        onClick={() => fromMedia.mutate(m.id, opts)}
                        title={
                          used
                            ? t("dialogs.poster.alreadyAdded")
                            : t("dialogs.poster.clickToAdd")
                        }
                        className={`group relative aspect-[3/4] overflow-hidden rounded border transition-all ${
                          used
                            ? "border-emerald-600 opacity-60"
                            : "border-zinc-700 hover:border-sky-500"
                        }`}
                      >
                        {/* thumbUrl (~6 KB) rather than the multi-megabyte
                            preview: at this tile size the two are visually
                            indistinguishable. */}
                        <LazyImage src={m.thumbnailUrl} alt={m.fileName} />
                        {used && (
                          <span className="absolute inset-0 flex items-center justify-center bg-black/50">
                            <Check className="h-4 w-4 text-emerald-400" />
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}

              {visibleAlbum.length < filteredAlbum.length && (
                <Button
                  variant="secondary"
                  onClick={() => setAlbumLimit((n) => n + ALBUM_PAGE)}
                  className="mx-auto"
                >
                  {t("action.loadMore", {
                    n: Math.min(ALBUM_PAGE, filteredAlbum.length - visibleAlbum.length),
                  })}
                </Button>
              )}
            </div>
          )}
        </div>

        {error && (
          <p className="border-b border-zinc-800 bg-red-950/40 px-4 py-2 text-xs text-red-300">
            {error}
          </p>
        )}

        {notice && (
          <p className="border-b border-emerald-900/60 bg-emerald-950/40 px-4 py-2 text-xs text-emerald-300">
            {notice}
          </p>
        )}

        {/* Poster list (features 4 & 5) */}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {posters.length === 0 ? (
            <p className="py-8 text-center text-sm text-zinc-500">
              {t("dialogs.poster.empty")}
            </p>
          ) : (
            <div className="flex flex-col gap-4">
              {(
                [
                  ["scraped", t("dialogs.poster.sourceScraped")],
                  ["upload", t("dialogs.poster.sourceUpload")],
                  ["media", t("dialogs.poster.sourceMedia")],
                ] as const
              ).map(([source, label]) => {
                const group = posters.filter((p) => p.source === source);
                if (!group.length) return null;
                return (
                  <div key={source} className="flex flex-col gap-2">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium text-zinc-300">{label}</span>
                      <span className="text-[10px] text-zinc-500">
                        {t("dialogs.poster.imageCount", { n: group.length })}
                      </span>
                    </div>
                    <div className="grid grid-cols-3 gap-3 sm:grid-cols-4">
                      {group.map((p) => (
                <div
                  key={p.id}
                  className={`group relative overflow-hidden rounded-lg border-2 transition-all ${
                    p.isSelected ? "border-sky-500" : "border-zinc-800"
                  }`}
                >
                  <div className="aspect-[3/4] bg-zinc-800">
                    {/* thumbUrl: the ~6 KB thumbnail instead of the 2.5-9.8 MB
                        preview. These tiles are ~90px wide, so the full-size
                        rendition bought nothing but bandwidth and jank. */}
                    <LazyImage
                      src={p.thumbUrl || p.url}
                      alt={t("dialogs.poster.imageAlt")}
                      rootMargin="150px"
                    />
                  </div>

                  {p.isSelected && (
                    // Spell out which kind of cover this is. "默认封面" tells the
                    // user the game is already on its official artwork, so the
                    // absence of a cancel button reads as intentional rather than
                    // broken.
                    <span
                      className={`absolute left-1.5 top-1.5 flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-white ${
                        p.isCover ? "bg-sky-600" : "bg-zinc-600"
                      }`}
                    >
                      {p.isCover ? (
                        <Star className="h-3 w-3 fill-current" />
                      ) : (
                        <Check className="h-3 w-3" />
                      )}
                      {p.isCover
                        ? t("dialogs.poster.badgeCover")
                        : t("dialogs.poster.badgeDefaultCover")}
                    </span>
                  )}
                  <span className="absolute right-1.5 top-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-zinc-300">
                    {p.source === "upload"
                      ? t("dialogs.poster.tagUpload")
                      : p.source === "media"
                        ? t("dialogs.poster.tagMedia")
                        : t("dialogs.poster.tagScraped")}
                  </span>

                  <div className="flex items-center justify-between gap-1 bg-zinc-900/95 px-1.5 py-1.5">
                    {/* The cancel entry is offered only for a NON-official cover
                        (p.isCover). Offering it on the official poster was the
                        reported "取消封面没反应": cancelling legitimately
                        restores the official artwork, so that poster stayed
                        selected and the button appeared to do nothing. */}
                    {p.isCover ? (
                      <button
                        onClick={() => clearSelection.mutate(undefined, clearOpts)}
                        disabled={clearSelection.isPending}
                        title={t("dialogs.poster.cancelCoverHint")}
                        className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-sky-400 transition-colors hover:bg-zinc-800 hover:text-sky-300 disabled:opacity-50"
                      >
                        {clearSelection.isPending ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <RotateCcw className="h-3 w-3" />
                        )}
                        {t("dialogs.poster.cancelCover")}
                      </button>
                    ) : p.isSelected ? (
                      // Already the official default — cancelling would restore
                      // this same poster, so no button is offered.
                      <span
                        className="px-1.5 py-0.5 text-[10px] text-zinc-500"
                        title={t("dialogs.poster.defaultCoverHint")}
                      >
                        {t("dialogs.poster.isDefault")}
                      </span>
                    ) : (
                      <button
                        onClick={() => select.mutate(p.id, opts)}
                        disabled={select.isPending}
                        title={t("dialogs.poster.setCoverHint")}
                        className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-white disabled:opacity-50"
                      >
                        {select.isPending && select.variables === p.id ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : null}
                        {t("dialogs.poster.setCover")}
                      </button>
                    )}

                    {/*
                      轮播勾选框**始终渲染**，不再包在 `mode === "slideshow"` 里。
                      
                      这是「相册截图勾选后无法取消」的直接原因：静态模式下整个
                      label 都不渲染，用户根本找不到可点的勾选框 —— 不是状态回弹，
                      而是控件不存在。
                      
                      两件事必须分开：
                        · 勾选 → 这张图是否进入**详情页大图区**的集合（本控件）
                        · 展现模式 → 这套集合是否**自动切换**（上方的按钮组）
                      把它们绑在一起，等于「不自动轮播就不许你挑选哪些图」。
                    */}
                    <label
                      className="flex cursor-pointer items-center gap-1 text-[10px] text-zinc-400"
                      title={t("dialogs.poster.slideshowItemHint")}
                    >
                      <input
                        type="checkbox"
                        checked={p.inSlideshow}
                        onChange={(e) =>
                          toggleSlideshow.mutate(
                            { posterId: p.id, inSlideshow: e.target.checked },
                            opts,
                          )
                        }
                        className="h-3 w-3 accent-sky-500"
                      />
                      {t("dialogs.poster.slideshow")}
                    </label>

                    {/*
                      删除按钮对**所有来源**都提供，包括相册截图。

                      以前这里排除了 `source === 'media'`，理由大概是「相册截图删了
                      就没法恢复」。那个理由不成立：`remove` 只是删掉 game_posters
                      里那一行，删完这张图在相册选择器里立刻变回可点（它的
                      `used` 判据是 `posters.some(p => p.mediaId === m.id)`），
                      再点一下就重新登记 —— 所以「取消展示」和「重新展示」共用同
                      一个入口，不需要为取消单独造一套状态。

                      也不会回弹：`ensureScrapedPosters` 只处理 source='scraped'
                      的行，且从不删除任何东西，永远不会把相册行重新登记回来。
                    */}
                    <button
                      onClick={() => removePoster.mutate(p.id, opts)}
                      disabled={removePoster.isPending}
                      className="text-zinc-500 transition-colors hover:text-red-400 disabled:opacity-50"
                      title={
                        p.source === "media"
                          ? t("dialogs.poster.deleteMediaPoster")
                          : t("dialogs.poster.deletePoster")
                      }
                      data-testid={`poster-remove-${p.source}`}
                    >
                      {removePoster.isPending && removePoster.variables === p.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </div>
                </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-zinc-800 px-4 py-3">
          <span className="text-xs text-zinc-500">{t("dialogs.poster.footerHint")}</span>
          <Button onClick={onClose}>{t("dialogs.poster.done")}</Button>
        </div>
      </div>
    </div>
  );
}