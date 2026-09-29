import { useEffect, useRef, useState } from "react";
import { ImageOff } from "lucide-react";
import { useT } from "../i18n";
import { cn } from "../lib/utils";

/**
 * Image with lazy loading, a skeleton placeholder and an error fallback.
 *
 * Why this exists: the poster manager rendered every tile eagerly, so opening
 * "从相册选择" on a 248-image game fired 248 simultaneous requests and the user
 * stared at an empty grid. Native `loading="lazy"` alone was not enough here
 * because it is only a hint and Chrome still loads well beyond the viewport
 * during fast scrolling; the explicit `IntersectionObserver` gate keeps the
 * in-flight request count proportional to what is actually visible.
 *
 * The placeholder reserves the tile's space so the grid never reflows as images
 * arrive — that layout shift was itself part of the "very slow" feeling.
 */
export default function LazyImage({
  src,
  alt,
  className,
  /** Extra classes for the skeleton/placeholder state. */
  placeholderClassName,
  /** Start fetching this far below the viewport, in px. */
  rootMargin = "300px",
  /** Skip the observer (e.g. above-the-fold hero images). */
  eager = false,
}: {
  src: string;
  alt: string;
  className?: string;
  placeholderClassName?: string;
  rootMargin?: string;
  eager?: boolean;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(eager);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  // Reset when the source changes so a recycled tile does not show the previous
  // image's loaded state.
  useEffect(() => {
    setLoaded(false);
    setFailed(false);
  }, [src]);

  useEffect(() => {
    if (eager || visible) return;
    const node = ref.current;
    if (!node) return;
    if (typeof IntersectionObserver === "undefined") {
      // Very old browser: fall back to loading immediately rather than never.
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [eager, visible, rootMargin]);

  return (
    <div ref={ref} className={cn("relative h-full w-full overflow-hidden", className)}>
      {/* Skeleton stays until the image has actually painted, so the user always
          sees feedback instead of a blank tile. */}
      {!loaded && !failed && (
        <div
          className={cn(
            "skeleton absolute inset-0 h-full w-full",
            placeholderClassName,
          )}
          aria-hidden="true"
        />
      )}

      {failed ? (
        <div
          role="img"
          aria-label={t("media.imageLoadFailed")}
          title={t("media.imageLoadFailed")}
          className="absolute inset-0 flex items-center justify-center bg-zinc-800 text-zinc-500"
        >
          <ImageOff className="h-4 w-4" />
        </div>
      ) : (
        visible && (
          <img
            src={src}
            alt={alt}
            loading="lazy"
            decoding="async"
            draggable={false}
            onLoad={() => setLoaded(true)}
            onError={() => setFailed(true)}
            className={cn(
              "h-full w-full object-cover transition-opacity duration-200",
              loaded ? "opacity-100" : "opacity-0",
            )}
          />
        )
      )}
    </div>
  );
}