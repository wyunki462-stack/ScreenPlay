import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "../lib/utils";
import { useT } from "../i18n";
import { useRotationTimer } from "../lib/hooks";

/**
 * Cover renderer that supports both display modes (feature 5).
 *
 * - `static`: the user browses the posters by hand with the arrows.
 * - `slideshow`: additionally auto-advances through the rotation set.
 *
 * Arrows appear whenever there is more than one image to look at — in BOTH modes.
 * Previously they did not exist at all: the only way to see a second poster was to
 * turn on slideshow mode and wait for the timer, so a game with seven scraped
 * official posters still looked like it had exactly one. The arrows are what make
 * the extra artwork reachable.
 *
 * Falls back to the gradient placeholder when there is nothing
 * usable, so a game without a poster still renders correctly.
 */
export default function PosterCarousel({
  images,
  mode,
  name,
  className,
  intervalMs = 3500,
  showDots = true,
  showArrows = true,
}: {
  /** Ordered poster URLs; the first is the selected cover. */
  images: string[];
  mode: "static" | "slideshow";
  name: string;
  className?: string;
  intervalMs?: number;
  /**
   * Pagination dots under the image. On by default; the gallery card turns them
   * off.
   *
   * On a card they are noise: the tile is ~300px wide, sits in a grid of dozens,
   * and nobody clicks a 6px dot there — they click the card itself, which opens
   * the detail page. They stay on by default because a large image the user is
   * actually studying is where they help; the detail page's large image draws its
   * own dots and counter though (see HeroPosterCarousel), so the only surfaces
   * using this component now are the gallery card and the small static cover.
   */
  showDots?: boolean;
  /**
   * Prev/next buttons. On by default; the **homepage card** turns them off unless
   * that game is set to slideshow.
   *
   * Why: a gallery card is ~300px wide and its real affordance is "click me to
   * open" — it is a still cover, not a viewer. Two arrows floating over it
   * promise in-place browsing that the tile is too small to deliver, and they
   * cover the artwork. Turning slideshow on is the user saying "this cover is a
   * rotation", so that is exactly when the arrows become meaningful there.
   *
   * Left on by default so a `static` cover still lets the user reach the other
   * posters by hand. On the detail page the browsable surface is the large image
   * below (HeroPosterCarousel); the small cover tile there is a single static
   * picture, so it renders no arrows at all.
   */
  showArrows?: boolean;
}) {
  const t = useT();
  const list = images.filter(Boolean);
  const [index, setIndex] = useState(0);

  const count = list.length;
  // Manual browsing needs more than one image; auto-advance additionally needs
  // slideshow mode. Keeping those separate is the point: `static` must stay still.
  const browsable = count > 1;
  const rotating = mode === "slideshow" && browsable;
  // Arrows are a *viewer* affordance, so they can be suppressed on a tile even
  // when there is more than one poster (see `showArrows`).
  const arrows = browsable && showArrows;

  // Pausing on hover/interaction stops the timer fighting the user's clicks.
  const [paused, setPaused] = useState(false);
  const resumeAt = useRef(0);

  const step = useCallback(
    (delta: number) => {
      setIndex((i) => (i + delta + count) % count);
      // Give the user a moment to look before auto-advance resumes.
      resumeAt.current = Date.now() + intervalMs * 2;
    },
    [count, intervalMs],
  );

  useRotationTimer({
    active: rotating,
    paused,
    resumeAt,
    intervalMs,
    advance: () => setIndex((i) => (i + 1) % count),
    restartKey: count,
  });

  // 修复「卡片上开启轮播后上一张/下一张点不动」：图库把整张卡片（含这块封面）
  // 包在 `<Link to={/game/...}>` 里，箭头按钮是它的后代 —— 点击会冒泡到链接并把
  // 用户直接送进详情页，封面自然「换不了」。
  //
  // 两个动作都要：`stopPropagation()` 拦住 React 里上层 `<Link>` 的 onClick，
  // `preventDefault()` 取消浏览器对「`<a>` 后代被点击」的默认跳转。别只留一个。
  const onControlClick = (e: ReactMouseEvent, action: () => void) => {
    e.preventDefault();
    e.stopPropagation();
    action();
  };

  useEffect(() => {
    // A single image, or static mode: always show the cover.
    if (!rotating && !browsable) setIndex(0);
  }, [rotating, browsable]);

  // Reset when the poster set itself changes (e.g. after an edit).
  useEffect(() => {
    setIndex(0);
  }, [list.join("|")]);

  if (count === 0) {
    return <PosterFallback name={name} className={className} />;
  }

  return (
    <div
      className={cn("group/carousel relative h-full w-full", className)}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      {list.map((src, i) => (
        <PosterLayer
          key={`${src}-${i}`}
          src={src}
          name={name}
          active={browsable ? i === index : i === 0}
        />
      ))}

      {arrows && (
        <>
          <button
            type="button"
            aria-label={t("detail.poster.prev")}
            title={t("detail.poster.prev")}
            onClick={(e) => onControlClick(e, () => step(-1))}
            className="absolute left-1 top-1/2 z-20 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full bg-black/60 text-white opacity-0 backdrop-blur-sm transition-opacity hover:bg-black/80 focus:opacity-100 group-hover/carousel:opacity-100"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            aria-label={t("detail.poster.next")}
            title={t("detail.poster.next")}
            onClick={(e) => onControlClick(e, () => step(1))}
            className="absolute right-1 top-1/2 z-20 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full bg-black/60 text-white opacity-0 backdrop-blur-sm transition-opacity hover:bg-black/80 focus:opacity-100 group-hover/carousel:opacity-100"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </>
      )}

      {browsable && (
        <>
          {/* Counter + dots: makes it obvious there are more posters than the one shown. */}
          <div className="absolute left-1.5 top-1.5 z-20 rounded-full bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white/90 backdrop-blur-sm">
            {index + 1}/{count}
          </div>
          {showDots && (
            <div className="absolute bottom-1.5 left-1/2 z-20 flex -translate-x-1/2 gap-1">
              {list.map((_, i) => (
                <button
                  key={i}
                  type="button"
                  aria-label={t("detail.poster.goto", { index: i + 1 })}
                  onClick={(e) =>
                    onControlClick(e, () => {
                      setIndex(i);
                      resumeAt.current = Date.now() + intervalMs * 2;
                    })
                  }
                  className={cn(
                    "h-1.5 w-1.5 rounded-full transition-colors",
                    i === index ? "bg-white/90" : "bg-white/40 hover:bg-white/70",
                  )}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function PosterLayer({ src, name, active }: { src: string; name: string; active: boolean }) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [src]);

  if (failed) return null;

  // Every frame of a card is mounted (they stack and cross-fade), so without
  // `loading="lazy"` a gallery of N cards fetches N × frames images up front.
  // Frames of a *visible* card sit inside the viewport, so the browser still
  // fetches them right away and the 3500ms rotation never lands on an unloaded
  // frame — only the off-screen cards get skipped until they are scrolled near.
  // `decoding="async"` keeps the decode off the main thread, which is what makes
  // the cross-fade stay smooth while the grid is scrolling.
  return (
    <img
      src={src}
      alt={name}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      className={cn(
        "absolute inset-0 h-full w-full object-cover object-center transition-opacity duration-700",
        active ? "opacity-100" : "opacity-0",
      )}
    />
  );
}

function PosterFallback({ name, className }: { name: string; className?: string }) {
  return (
    <div
      className={cn(
        "flex h-full w-full items-center justify-center bg-gradient-to-br from-zinc-800 to-zinc-900",
        className,
      )}
    >
      <span className="text-4xl font-bold text-zinc-700">{name.slice(0, 1).toUpperCase()}</span>
    </div>
  );
}