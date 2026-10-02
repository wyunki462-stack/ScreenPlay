import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Images } from "lucide-react";
import { cn } from "../lib/utils";
import { useT } from "../i18n";
import { useRotationTimer } from "../lib/hooks";

/**
 * 详情页大图区域的「官方海报轮播」。
 *
 * 新语义（与「编辑海报」面板彻底解耦）：详情页大图 = **全部官方海报**（刮取 +
 * 用户上传），**默认自动轮播**，不受面板里的展现模式/轮播勾选影响 —— 那两个设置
 * 管的是**首页卡片轮播**（见 GameCard / PosterDialog）。所以这里没有 `mode`：
 * 只要图片多于一张就自动切换。
 *
 * 为什么单独写一个组件而不是复用截图轮播：
 *
 *  1. 旧的大图区用的是截图轮播：箭头在**第一张/最后一张会 disable**，所以用户
 *     点两下就再也翻不动，看起来「没有轮播」。这里改成**循环**，永远不会卡死。
 *  2. 图片集合由调用方给（`heroPosters()`：官方刮取 + 用户上传，当前封面在前），
 *     不读 `inSlideshow`，所以官方海报有多少张，大图区就能翻到多少张。
 *  3. 箭头与计数**默认可见**，不依赖 hover —— hover 才出现的控件在验收时就是
 *     「页面上看不到」。
 *
 * 坏图（刮取到的 URL 已经 404 / 被墙）会被跳过，而不是渲染成空气：计数与实际
 * 能看到的画面始终一致，用户不会翻到空白帧。
 */
export default function HeroPosterCarousel({
  images,
  alt,
  intervalMs = 3500,
}: {
  /** 有序海报 URL；调用方保证第一张是当前封面。 */
  images: string[];
  alt?: string;
  intervalMs?: number;
}) {
  const t = useT();
  const list = useMemo(() => [...new Set(images.filter(Boolean))], [images]);

  const [failed, setFailed] = useState<Record<string, true>>({});
  const [index, setIndex] = useState(0);

  // 悬停/手动操作后暂停一会儿，避免定时器与用户的点击抢同一个位置。
  const [paused, setPaused] = useState(false);
  const resumeAt = useRef(0);

  // 海报集合变化（重新刮削、手动换封面）时回到第一张。
  const listKey = list.join("|");
  useEffect(() => {
    setIndex(0);
    setFailed({});
  }, [listKey]);

  const usable = useMemo(() => list.filter((u) => !failed[u]), [list, failed]);
  // 全部加载失败时退化成原始列表：至少让用户看到「图挂了」而不是整块消失。
  const shown = usable.length > 0 ? usable : list;
  const count = shown.length;

  useEffect(() => {
    if (index >= count) setIndex(0);
  }, [count, index]);

  const step = useCallback(
    (delta: number) => {
      if (count < 1) return;
      // 循环：首尾相连，两个箭头永远可用（这正是旧实现缺的）。
      setIndex((i) => (i + delta + count) % count);
      // 手动翻过之后留一点时间给用户看，再恢复自动轮播。
      resumeAt.current = Date.now() + intervalMs * 2;
    },
    [count, intervalMs],
  );

  // 详情页大图恒定自动轮播：有多张就转，不看任何配置（`mode` 已删除）。
  const rotating = count > 1;
  useRotationTimer({
    active: rotating,
    paused,
    resumeAt,
    intervalMs,
    advance: () => setIndex((i) => (i + 1) % count),
    restartKey: count,
  });

  if (count === 0) {
    return (
      <div
        data-testid="hero-carousel"
        className="flex aspect-video w-full items-center justify-center rounded-xl border border-zinc-800 bg-zinc-900 text-sm text-zinc-500"
      >
        {t("detail.poster.empty")}
      </div>
    );
  }

  const current = shown[Math.min(index, count - 1)];

  return (
    <div
      data-testid="hero-carousel"
      className="group/hero relative aspect-video w-full overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      {list.map((src, i) => {
        if (failed[src]) return null;
        const active = src === current;
        return (
          <img
            key={`${src}-${i}`}
            src={src}
            alt={alt ?? t("detail.poster.alt")}
            data-active={active ? "true" : "false"}
            onError={() => setFailed((f) => ({ ...f, [src]: true }))}
            className={cn(
              "absolute inset-0 h-full w-full object-contain transition-opacity duration-500",
              active ? "opacity-100" : "pointer-events-none opacity-0",
            )}
          />
        );
      })}

      {count > 1 && (
        <>
          <button
            type="button"
            aria-label={t("detail.poster.prev")}
            title={t("detail.poster.prev")}
            onClick={() => step(-1)}
            className="absolute left-3 top-1/2 z-20 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/65 text-white shadow-lg backdrop-blur-sm transition-colors hover:bg-black/85 focus:opacity-100"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <button
            type="button"
            aria-label={t("detail.poster.next")}
            title={t("detail.poster.next")}
            onClick={() => step(1)}
            className="absolute right-3 top-1/2 z-20 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/65 text-white shadow-lg backdrop-blur-sm transition-colors hover:bg-black/85 focus:opacity-100"
          >
            <ChevronRight className="h-5 w-5" />
          </button>

          {/* 计数常驻可见：明确的「这里有多张图」。 */}
          <div
            data-testid="hero-counter"
            className="absolute right-3 top-3 z-20 rounded-full bg-black/70 px-2.5 py-1 text-xs font-medium tabular-nums text-white/90 backdrop-blur-sm"
          >
            {index + 1}/{count}
          </div>

          {/* 圆点：直接跳到第 N 张，也再次提示总数。 */}
          <div className="absolute bottom-3 left-1/2 z-20 flex max-w-[70%] -translate-x-1/2 flex-wrap justify-center gap-1.5">
            {shown.map((src, i) => (
              <button
                key={`dot-${src}-${i}`}
                type="button"
                aria-label={t("detail.poster.goto", { index: i + 1 })}
                onClick={() => setIndex(i)}
                className={cn(
                  "h-2 w-2 rounded-full transition-colors",
                  i === index ? "bg-white" : "bg-white/40 hover:bg-white/70",
                )}
              />
            ))}
          </div>
        </>
      )}

      <div className="pointer-events-none absolute bottom-3 left-3 z-20 flex items-center gap-1.5 rounded-full bg-black/70 px-2.5 py-1 text-xs text-white/90 backdrop-blur-sm">
        <Images className="h-3.5 w-3.5" />
        {t("detail.poster.official")}
      </div>
    </div>
  );
}