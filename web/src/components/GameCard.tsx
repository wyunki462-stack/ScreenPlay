import { useRef } from "react";
import { Link } from "react-router-dom";
import { Clock, Images, TriangleAlert } from "lucide-react";
import type { GameSummary } from "../types";
import { useT } from "../i18n";
import { platformTags } from "../lib/platforms";
import PosterCarousel from "./PosterCarousel";
import { MetacriticBadge } from "./MetacriticBadge";
import GameMenu from "./GameMenu";

/**
 * Posters for the card cover: the selected one first, then the rotation set.
 *
 * The backend already hands us the rotation set this way — `game.posters` is
 * "current cover first, then the rows ticked with 轮播 (`in_slideshow = 1`)" —
 * so the tick boxes in 「编辑海报」 decide exactly which images the card can show.
 * A game with nothing ticked yields a single-image card.
 */
function cardPosters(game: GameSummary): string[] {
  const list = [game.posterUrl, ...(game.posters ?? [])].filter(
    (u): u is string => typeof u === "string" && u.length > 0,
  );
  return [...new Set(list)];
}

/** Platform tags to display; falls back to the auto-detected value. */

/**
 * Drag-and-drop wiring handed down from the gallery.
 *
 * Kept optional so every other place that renders a card (search results, the
 * poster picker) stays a plain, non-draggable card.
 */
export interface CardDragProps {
  /** True only in the 「自定义排序」 mode. */
  enabled: boolean;
  /** This card is the one being dragged. */
  dragging: boolean;
  /** Where the dragged card would land relative to this one. */
  dropSide: "before" | "after" | null;
  onDragStart: () => void;
  onDragOver: (side: "before" | "after") => void;
  onDrop: () => void;
  onDragEnd: () => void;
}

/** Insertion indicator drawn on the edge the dragged card would land against. */
function DropIndicator({ side }: { side: "before" | "after" }) {
  return (
    <span
      aria-hidden
      className={`pointer-events-none absolute inset-y-2 z-20 w-1 rounded-full bg-violet-500 shadow-[0_0_10px_2px_rgba(139,92,246,0.55)] ${
        side === "before" ? "-left-1" : "-right-1"
      }`}
    />
  );
}

export default function GameCard({
  game,
  drag,
}: {
  game: GameSummary;
  drag?: CardDragProps;
}) {
  const t = useT();
  const draggable = !!drag?.enabled;
  // A drag that ends over the card would otherwise also fire the link's click and
  // navigate away, which feels like the card "flying off" after a reorder.
  const draggedRef = useRef(false);

  return (
    <div
      className={`group relative ${
        draggable ? "cursor-grab active:cursor-grabbing" : ""
      } ${
        drag?.dragging
          ? // 拖拽中的卡片变成占位符：淡出 + 虚线边框，松手前就能看出它要挪走
            "opacity-40 [&>a]:border-dashed [&>a]:border-violet-600"
          : ""
      } ${drag?.dropSide ? "rounded-xl ring-2 ring-violet-500/60" : ""}`}
      draggable={draggable}
      onDragStart={
        draggable
          ? (e) => {
              draggedRef.current = true;
              e.dataTransfer.effectAllowed = "move";
              // Firefox refuses to start a drag without payload.
              e.dataTransfer.setData("text/plain", game.id);
              drag?.onDragStart();
            }
          : undefined
      }
      onDragOver={
        draggable
          ? (e) => {
              // Required for onDrop to fire at all.
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              const rect = e.currentTarget.getBoundingClientRect();
              drag?.onDragOver(e.clientX < rect.left + rect.width / 2 ? "before" : "after");
            }
          : undefined
      }
      onDrop={
        draggable
          ? (e) => {
              e.preventDefault();
              drag?.onDrop();
            }
          : undefined
      }
      onDragEnd={
        draggable
          ? () => {
              drag?.onDragEnd();
              // Cleared on the next tick so the click handler can see it.
              setTimeout(() => {
                draggedRef.current = false;
              }, 0);
            }
          : undefined
      }
    >
      {drag?.dropSide && <DropIndicator side={drag.dropSide} />}
      <Link
        to={`/game/${game.id}`}
        draggable={false}
        onClick={(e) => {
          if (draggedRef.current) e.preventDefault();
        }}
        className={`flex flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/60 transition-all hover:-translate-y-0.5 hover:border-zinc-700 hover:shadow-lg hover:shadow-black/40 ${
          drag?.dropSide ? "border-violet-700" : ""
        }`}
      >
        {/* 16:9 横向比例：横版海报完整入画，竖版海报居中裁切，不拉伸变形。 */}
        <div className="relative aspect-video overflow-hidden bg-zinc-900">
          {/* Feature 5: the cover shows one image or the ticked rotation set;
              `posterMode` decides whether that set auto-switches here. */}
          <PosterCarousel
            images={cardPosters(game)}
            mode={game.posterMode ?? "static"}
            name={game.name}
            className="transition-transform duration-300 group-hover:scale-105"
            // No dots on a card — see the `showDots` docblock in PosterCarousel.
            showDots={false}
            // 卡片上的上一张/下一张只在**首页卡片轮播**（设为轮播）时出现。
            //
            // 静态模式下这张卡就是一张封面，真正的操作是「点开详情」；两枚浮在
            // 300px 卡片上的箭头既挡画面，又暗示这里能就地翻图（不能——卡片比详情
            // 大图小得多，翻起来看不见细节）。而「设为轮播」本身就是用户说「这张
            // 封面是一组轮播」，那时箭头才有意义。详情页大图是另一套体系：它读的是
            // 全部官方海报、恒定自动轮播、箭头常驻，与这里的设置无关。
            showArrows={(game.posterMode ?? "static") === "slideshow"}
          />
        </div>
        <div className="flex flex-1 flex-col gap-2 p-3">
          <div className="flex items-start justify-between gap-2">
            <h3 className="line-clamp-1 min-w-0 flex-1 text-sm font-semibold text-zinc-100 group-hover:text-white" title={game.name}>
              {game.name}
            </h3>
            <MetacriticBadge score={game.metacriticScore} criticCount={game.metacriticCriticCount} />
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-400">
            {/* Feature 6: show every user-selected platform tag. */}
            {platformTags(game).map((p) => (
              <span
                key={p}
                className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-300"
                title={game.customPlatform ? t("home.platformManual") : t("home.platformAuto")}
              >
                {p}
              </span>
            ))}
            <span className="inline-flex items-center gap-1">
              <Clock className="h-3.5 w-3.5" />
              {game.durationText}
            </span>
            <span className="inline-flex items-center gap-1">
              <Images className="h-3.5 w-3.5" />
              {game.mediaCount}
            </span>
          </div>
        </div>
      </Link>

      {game.metaError && (
        <span
          title={game.metaError}
          className="absolute left-1.5 top-1.5 z-10 flex h-6 w-6 items-center justify-center rounded-md bg-rose-600/90 text-white"
        >
          <TriangleAlert className="h-3.5 w-3.5" />
        </span>
      )}

      <GameMenu game={game} />
    </div>
  );
}