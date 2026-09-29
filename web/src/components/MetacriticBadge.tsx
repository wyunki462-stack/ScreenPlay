import { useT } from "../i18n";
import { cn, metacriticTone, type MetacriticTone } from "../lib/utils";

const boxStyles: Record<MetacriticTone, string> = {
  green: "bg-emerald-500 text-white",
  yellow: "bg-amber-400 text-zinc-950",
  red: "bg-rose-600 text-white",
  none: "bg-zinc-700 text-zinc-300",
};

const scoreStyles: Record<MetacriticTone, string> = {
  green: "text-emerald-400",
  yellow: "text-amber-400",
  red: "text-rose-500",
  none: "text-zinc-500",
};

/**
 * Metacritic "M" logo + score, color-coded (>=75 green, >=50 yellow, <50 red).
 * Hover shows how many critics contributed the average.
 */
export function MetacriticBadge({
  score,
  criticCount,
  className,
}: {
  score: number | null;
  criticCount?: number | null;
  className?: string;
}) {
  const t = useT();
  const tone = metacriticTone(score);
  const tooltip =
    score != null
      ? criticCount != null
        ? t("detail.metacritic.withCritics", { score, criticCount })
        : t("detail.metacritic.score", { score })
      : t("detail.metacritic.empty");
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1.5", className)} title={tooltip}>
      <span
        className={cn(
          "flex h-5 w-5 items-center justify-center rounded-[4px] text-[11px] font-black leading-none",
          boxStyles[tone],
        )}
      >
        M
      </span>
      <span className={cn("text-sm font-bold leading-none", scoreStyles[tone])}>
        {score != null ? score : "—"}
      </span>
    </span>
  );
}