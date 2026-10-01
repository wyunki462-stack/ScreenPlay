import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "../lib/utils";
import { useT } from "../i18n";

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
 * Falls back to the gradient placeholder in PosterImage when there is nothing
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
   * the detail page. On the detail hero the same dots sit above a large image the
   * user is actually studying, and the counter in the corner reads as clutter
   * next to them, so there they stay useful.
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
   * The detail hero keeps them in both modes: a large image the user is studying
   * is where manual browsing belongs, and in `static` the arrows are the only way
   * to reach the other posters at all.
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

  useEffect(() => {
    if (!rotating) {
      // A single image, or static mode: always show the cover.
      if (!browsable) setIndex(0);
      return;
    }
    const timer = setInterval(() => {
      if (paused || Date.now() < resumeAt.current) return;
      setIndex((i) => (i + 1) % count);
    }, intervalMs);
    return () => clearInterval(timer);
  }, [rotating, browsable, count, intervalMs, paused]);

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
            onClick={() => step(-1)}
            className="absolute left-1 top-1/2 z-20 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full bg-black/60 text-white opacity-0 backdrop-blur-sm transition-opacity hover:bg-black/80 focus:opacity-100 group-hover/carousel:opacity-100"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            aria-label={t("detail.poster.next")}
            title={t("detail.poster.next")}
            onClick={() => step(1)}
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
                  onClick={() => {
                    setIndex(i);
                    resumeAt.current = Date.now() + intervalMs * 2;
                  }}
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

  return (
    <img
      src={src}
      alt={name}
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