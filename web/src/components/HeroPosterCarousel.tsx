import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Images } from "lucide-react";
import { cn } from "../lib/utils";
import { useT } from "../i18n";

/**
 * 详情页大图区域的「官方海报轮播」。
 *
 * 为什么单独写一个组件而不是复用旧的截图轮播：
 *
 *  1. 旧的大图区用的是截图轮播：箭头在**第一张/最后一张会 disable**，所以用户
 *     点两下就再也翻不动，看起来「没有轮播」。这里改成**循环**，永远不会卡死。
 *  2. 旧大图区把 `posterUrl` + 截图拼成一份临时列表，与用户在海报管理里配置的
 *     集合无关。这里只吃后端 `posterList`（刮取到的官方海报/截图 + 用户上传），
 *     所以「编辑海报」里看到什么，大图区就能翻到什么。
 *  3. 箭头与计数**默认可见**，不依赖 hover —— hover 才出现的控件在验收时就是
 *     「页面上看不到」。
 *
 * 坏图（刮取到的 URL 已经 404 / 被墙）会被跳过，而不是渲染成空气：计数与实际
 * 能看到的画面始终一致，用户不会翻到空白帧。
 */
export default function HeroPosterCarousel({
  images,
  alt,
  mode = "static",
  intervalMs = 3500,
}: {
  /** 有序海报 URL；调用方保证第一张是当前封面。 */
  images: string[];
  alt?: string;
  /**
   * 展现模式。`slideshow` 时自动轮播这套图片。
   *
   * 为什么大图区需要它：这里以前只有左右箭头，**永远不会自动切换**。而
   * 「编辑海报」的轮播勾选控制的正是这套图片，于是用户勾了半天，页面上唯一
   * 会自动动的东西是首页图库卡片 —— 这就成了「编辑海报的轮播设置控制的是首页
   * 卡片轮播，而不是详情页大图轮播」这个报告。
   *
   * 现在两件事分开：勾选决定**哪些图进这套集合**，本模式决定**这套集合是否自动
   * 切换**。首页卡片用另一个数据源（完整海报集），互不影响。
   */
  mode?: "static" | "slideshow";
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

  // 自动轮播：只有 `slideshow` 模式且确实有多张时才启动。
  const rotating = mode === "slideshow" && count > 1;
  useEffect(() => {
    if (!rotating) return;
    const timer = setInterval(() => {
      if (paused || Date.now() < resumeAt.current) return;
      setIndex((i) => (i + 1) % count);
    }, intervalMs);
    return () => clearInterval(timer);
  }, [rotating, count, intervalMs, paused]);

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
      data-mode={mode}
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