import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from "react";
import { PhotoSlider } from "react-photo-view";
import "react-photo-view/dist/react-photo-view.css";
import { ChevronLeft, ChevronRight, ExternalLink, Play, X, ZoomIn, ZoomOut } from "lucide-react";
import { useT } from "../i18n";
import type { Media } from "../types";
import { formatClock } from "../lib/format";
import LazyImage from "./LazyImage";

/**
 * The player is only mounted after a video is clicked (see the render below), so
 * keeping it out of the initial graph is free: plyr + plyr-react + plyr.css are by
 * far the heaviest single feature in the app (~116 KB JS, 32 KB CSS — a fifth of
 * the bundle) and the gallery never needs them. Loading it lazily moves all of that
 * into a chunk that is fetched the first time a video is actually opened.
 *
 * `PhotoSlider` keeps its static import (17 KB, always in the graph) but is now
 * mounted only after the viewer is opened for the first time: mounting it up front
 * handed react-photo-view every full-size `/preview` URL of the game on page load,
 * which a 4K-heavy album does not need before the user asks to look at a picture.
 * Once opened it stays mounted, so open/close keeps its transition.
 */
const VideoPlayer = lazy(() => import("./VideoPlayer"));

type SortKey = "default" | "time" | "name" | "size";

/** Labels are dictionary keys — resolved with `t` inside the component. */
const sortOptions: { value: SortKey; labelKey: string }[] = [
  { value: "default", labelKey: "media.sort.default" },
  { value: "time", labelKey: "media.sort.time" },
  { value: "name", labelKey: "media.sort.name" },
  { value: "size", labelKey: "media.sort.size" },
];

function sortMedia(list: Media[], key: SortKey): Media[] {
  const arr = [...list];
  if (key === "name") {
    return arr.sort((a, b) =>
      a.fileName.localeCompare(b.fileName, undefined, { numeric: true, sensitivity: "base" }),
    );
  }
  if (key === "time") {
    return arr.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  }
  if (key === "size") {
    return arr.sort((a, b) => b.sizeBytes - a.sizeBytes);
  }
  return arr;
}

function ToolbarButton({ onClick, label, children }: { onClick: () => void; label: string; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="flex h-10 w-10 items-center justify-center rounded-full bg-black/60 text-white transition-colors hover:bg-black/80"
    >
      {children}
    </button>
  );
}

export interface MediaGridProps {
  media: Media[];
}

export default function MediaGrid({ media }: MediaGridProps) {
  const t = useT();
  const [sortKey, setSortKey] = useState<SortKey>("default");
  const sortedMedia = useMemo(() => sortMedia(media, sortKey), [media, sortKey]);
  const imageMedia = useMemo(() => sortedMedia.filter((m) => m.type !== "video"), [sortedMedia]);
  const [photoIndex, setPhotoIndex] = useState(0);
  const [photoVisible, setPhotoVisible] = useState(false);
  /**
   * 查看器第一次被打开之前不挂载。`images` 里装的是每张图的 `/preview`
   * （4K 截图 2.5–9.8 MB），只有真要看图时才需要构造；打开过之后保持挂载，
   * 关闭/再打开仍走原来的过渡动画。
   */
  const [viewerMounted, setViewerMounted] = useState(false);
  const [activeVideo, setActiveVideo] = useState<Media | null>(null);

  // Use previewUrl, not streamUrl: JXR/WDP originals are not decodable by any
  // browser and are transcoded to WebP by the backend on this endpoint.
  const images = viewerMounted
    ? imageMedia.map((m) => ({ key: m.id, src: m.previewUrl || m.streamUrl }))
    : [];

  useEffect(() => {
    if (!photoVisible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") setPhotoIndex((i) => Math.max(0, i - 1));
      else if (e.key === "ArrowRight") setPhotoIndex((i) => Math.min(imageMedia.length - 1, i + 1));
      else if (e.key === "Escape") setPhotoVisible(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [photoVisible, imageMedia.length]);

  // 空文件夹的终结答案：「暂无图片」。不再劝用户去刷新元数据 —— 这个文件夹里
  // 确实一张图都没有（空相册的游戏卡在进入前就会显示「空」角标）。
  if (sortedMedia.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-zinc-800 p-10 text-center text-sm text-zinc-500">
        {t("media.emptyFolder")}
      </div>
    );
  }

  const openImage = (id: string) => {
    const idx = imageMedia.findIndex((m) => m.id === id);
    if (idx >= 0) {
      setViewerMounted(true);
      setPhotoIndex(idx);
      setPhotoVisible(true);
    }
  };

  return (
    <>
      <div className="mb-3 flex items-center justify-between gap-3">
        <span className="text-xs text-zinc-500">{t("media.count", { n: sortedMedia.length })}</span>
        <label className="flex items-center gap-2 text-xs text-zinc-400">
          <span>{t("media.sort.label")}</span>
          <select
            value={sortKey}
            onChange={(e) => setSortKey(e.target.value as SortKey)}
            className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200 outline-none focus:border-zinc-500"
          >
            {sortOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {t(o.labelKey)}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* 缩略图/封面用仓库自带的 `LazyImage`（IntersectionObserver 闸门 + 骨架占位）：
          一进页面不再把整页的图同时变成在途请求，比例容器仍是 `aspect-video`，不产生
          CLS。图片本身依赖后端给的 `Cache-Control: public, max-age=2592000, immutable`
          （/api/media/:id/thumbnail|cover|proxy），浏览器缓存即可命中，前端不另加缓存层。 */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {sortedMedia.map((item) =>
          item.type === "video" ? (
            <button
              key={item.id}
              type="button"
              onClick={() => setActiveVideo(item)}
              className="group relative aspect-video overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900"
            >
              {item.coverUrl ? (
                <LazyImage
                  src={item.coverUrl}
                  alt={item.fileName}
                  className="transition-transform duration-300 group-hover:scale-105"
                />
              ) : (
                <div className="h-full w-full bg-gradient-to-br from-zinc-800 to-zinc-900" />
              )}
              <span className="absolute inset-0 flex items-center justify-center bg-black/30 transition-colors group-hover:bg-black/40">
                <span className="flex h-12 w-12 items-center justify-center rounded-full bg-black/60">
                  <Play className="ml-0.5 h-6 w-6 text-white" />
                </span>
              </span>
              <span className="absolute left-1.5 top-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-zinc-200">{t("media.badge.video")}</span>
              {item.durationSeconds != null && (
                <span className="absolute bottom-1.5 right-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-zinc-200">
                  {formatClock(item.durationSeconds)}
                </span>
              )}
            </button>
          ) : (
            <button
              key={item.id}
              type="button"
              onClick={() => openImage(item.id)}
              className="group relative aspect-video overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900"
            >
              <LazyImage
                src={item.thumbnailUrl}
                alt={item.fileName}
                className="transition-transform duration-300 group-hover:scale-105"
              />
              {item.type === "gif" && (
                <span className="absolute left-1.5 top-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-zinc-200">{t("media.badge.gif")}</span>
              )}
            </button>
          ),
        )}
      </div>

      {viewerMounted && imageMedia.length > 0 && (
        <PhotoSlider
          images={images}
          visible={photoVisible}
          index={photoIndex}
          onIndexChange={setPhotoIndex}
          onClose={() => setPhotoVisible(false)}
          bannerVisible={false}
          overlayRender={({ index, images: list, onIndexChange, onClose, scale, onScale }) => {
            const current = list[index];
            return (
              <div className="absolute inset-x-0 bottom-0 z-30 flex flex-col items-center gap-2 p-4">
                <div className="rounded-full bg-black/60 px-3 py-1 text-xs text-zinc-200">
                  {index + 1} / {list.length}
                </div>
                <div className="flex items-center gap-2">
                  <ToolbarButton label={t("media.previous")} onClick={() => onIndexChange(Math.max(0, index - 1))}>
                    <ChevronLeft className="h-5 w-5" />
                  </ToolbarButton>
                  <ToolbarButton label={t("media.zoomOut")} onClick={() => onScale(Math.max(1, scale - 1))}>
                    <ZoomOut className="h-5 w-5" />
                  </ToolbarButton>
                  <ToolbarButton label={t("media.zoomIn")} onClick={() => onScale(scale + 1)}>
                    <ZoomIn className="h-5 w-5" />
                  </ToolbarButton>
                  <ToolbarButton label={t("media.next")} onClick={() => onIndexChange(Math.min(list.length - 1, index + 1))}>
                    <ChevronRight className="h-5 w-5" />
                  </ToolbarButton>
                  {current ? (
                    <ToolbarButton
                      label={t("media.viewOriginal")}
                      onClick={() => window.open(`/api/media/${current.key}/original`, "_blank", "noopener,noreferrer")}
                    >
                      <ExternalLink className="h-5 w-5" />
                    </ToolbarButton>
                  ) : null}
                  <ToolbarButton label={t("action.close")} onClick={() => onClose()}>
                    <X className="h-5 w-5" />
                  </ToolbarButton>
                </div>
              </div>
            );
          }}
        />
      )}

      {activeVideo && (
        <Suspense fallback={null}>
          <VideoPlayer media={activeVideo} onClose={() => setActiveVideo(null)} />
        </Suspense>
      )}
    </>
  );
}