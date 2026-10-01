/**
 * 「手动选择评分」弹窗。
 *
 * 同一款游戏在不同平台上，Metacritic 是**各自独立的条目**（PC / PS5 / Xbox /
 * Switch 分数不同）。自动匹配只能挑一个，挑错平台时用户看到的分数就与自己的
 * 实际游玩平台不符，所以这里让用户按平台手动指定。
 *
 * 交互与 `AchievementPickDialog` 完全一致：同样的外壳、同样的搜索框、同样的
 * 底部按钮布局，两者看起来是同一套东西。
 *
 * 选定结果由后端持久化到独立于 `games` 表的 `rating_targets`，因此全量刮削与
 * 单游戏刷新都不会把它冲掉（见 `RatingTargetService` 的注释）。
 */
import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Check, Gamepad2, Info, Star, X } from "lucide-react";
import { Button } from "./ui/Button";
import { Input } from "./ui/Input";
import { useT } from "../i18n";
import {
  useClearRatingTarget,
  useRatingCandidates,
  useSetRatingTarget,
} from "../api/hooks";
import type { RatingCandidate } from "../types";
import { metacriticTone, type MetacriticTone } from "../lib/utils";

/** 评分条目的颜色分档，与 Metacritic 自身的配色习惯一致（阈值见 lib/utils 的 `metacriticTone`）。 */
const SCORE_TONE_CLASS: Record<MetacriticTone, string> = {
  green: "bg-emerald-600/90 text-white",
  yellow: "bg-amber-500/90 text-zinc-900",
  red: "bg-rose-600/90 text-white",
  none: "bg-zinc-800 text-zinc-400",
};

export default function RatingPickDialog({
  gameId,
  gameName,
  onClose,
}: {
  gameId: string;
  gameName: string;
  onClose: () => void;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [selected, setSelected] = useState<RatingCandidate | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  // Debounce so typing does not fire a Metacritic search per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query), 350);
    return () => clearTimeout(timer);
  }, [query]);

  const candidates = useRatingCandidates(gameId, debounced);
  const apply = useSetRatingTarget(gameId);
  const clear = useClearRatingTarget(gameId);

  const data = candidates.data;
  const items = useMemo(
    () => (data?.candidates ?? []).filter((c) => c.metascore != null),
    [data],
  );

  const busy = apply.isPending || clear.isPending;

  const onConfirm = () => {
    if (!selected) return;
    setResult(null);
    apply.mutate(
      {
        externalId: selected.externalId,
        name: selected.name,
        platform: selected.platform,
        metascore: selected.metascore,
        releaseDate: selected.releaseDate,
      },
      {
        onSuccess: () =>
          setResult({
            ok: true,
            text: t("detail.rating.pick.done", {
              platform: selected.platform ?? t("detail.rating.pick.unknownPlatform"),
              score: String(selected.metascore),
            }),
          }),
        onError: () => setResult({ ok: false, text: t("detail.rating.pick.failedMsg") }),
      },
    );
  };

  const onClear = () => {
    setResult(null);
    clear.mutate(undefined, {
      onSuccess: () => setResult({ ok: true, text: t("detail.rating.pick.cleared") }),
      onError: () => setResult({ ok: false, text: t("detail.rating.pick.failedMsg") }),
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
          <h3 className="min-w-0 truncate text-sm font-semibold text-zinc-100">
            {t("detail.rating.pick.title", { name: gameName })}
          </h3>
          <button onClick={onClose} className="text-zinc-400 transition-colors hover:text-white">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex items-start gap-2 border-b border-zinc-800 px-4 py-2.5">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-zinc-500" />
          <span className="min-w-0 text-xs leading-relaxed text-zinc-400">
            {t("detail.rating.pick.intro")}
          </span>
        </div>

        {/* 当前状态：用户已选定，还是跟随自动匹配 */}
        <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-2 text-xs text-zinc-400">
          <Gamepad2 className="h-3.5 w-3.5 shrink-0 text-violet-400" />
          {data?.current ? (
            <span className="min-w-0 truncate">
              {t("detail.rating.pick.current", {
                platform: data.current.platform ?? t("detail.rating.pick.unknownPlatform"),
                score: String(data.current.metascore ?? "-"),
              })}
            </span>
          ) : (
            <span className="min-w-0 truncate text-zinc-500">
              {data?.automatic?.metascore != null
                ? t("detail.rating.pick.currentAuto", { score: String(data.automatic.metascore) })
                : t("detail.rating.pick.noScore")}
            </span>
          )}
        </div>

        <div className="border-b border-zinc-800 p-4">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("detail.rating.pick.placeholder")}
            autoFocus
          />
        </div>

        <div className="flex-1 space-y-1 overflow-y-auto p-4">
          {candidates.isFetching && (
            <div className="py-4 text-center text-sm text-zinc-500">
              {t("detail.rating.pick.searching")}
            </div>
          )}
          {!candidates.isFetching && items.length === 0 && (
            <div className="py-4 text-center text-sm text-zinc-500">
              {t("detail.rating.pick.noResults")}
            </div>
          )}
          {items.map((c, i) => {
            const active = selected?.externalId === c.externalId;
            const isCurrent = data?.current?.externalId === c.externalId;
            return (
              <button
                key={`${c.externalId}-${i}`}
                type="button"
                onClick={() => setSelected(c)}
                className={`flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left transition-colors ${
                  active
                    ? "border-violet-600 bg-violet-600/10"
                    : "border-zinc-800 hover:border-zinc-600 hover:bg-zinc-800"
                }`}
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-zinc-100">
                    {c.name}
                    {isCurrent && (
                      <span className="ml-2 rounded bg-emerald-900/50 px-1.5 py-0.5 text-[10px] text-emerald-300">
                        {t("detail.rating.pick.inUse")}
                      </span>
                    )}
                  </div>
                  <div className="truncate text-xs text-zinc-500">
                    {c.platform ?? t("detail.rating.pick.unknownPlatform")}
                    {c.releaseDate ? ` · ${c.releaseDate}` : ""}
                  </div>
                </div>
                <span
                  className={`shrink-0 rounded px-2 py-1 text-sm font-semibold ${SCORE_TONE_CLASS[metacriticTone(c.metascore)]}`}
                  title={t("detail.rating.pick.metascore")}
                >
                  {c.metascore}
                </span>
              </button>
            );
          })}
        </div>

        {result && (
          <div
            className={`mx-4 mb-1 flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${
              result.ok
                ? "border-emerald-900/60 bg-emerald-950/40 text-emerald-300"
                : "border-rose-900/60 bg-rose-950/40 text-rose-300"
            }`}
          >
            {result.ok ? (
              <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            ) : (
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            )}
            <span className="min-w-0 flex-1 break-words">{result.text}</span>
          </div>
        )}

        <div className="flex items-center justify-between gap-2 border-t border-zinc-800 px-4 py-3">
          <div>
            {data?.current && (
              <Button variant="ghost" onClick={onClear} disabled={busy}>
                {t("detail.rating.pick.clear")}
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              {t("action.close")}
            </Button>
            <Button onClick={onConfirm} disabled={!selected || busy}>
              {apply.isPending ? t("detail.rating.pick.applying") : t("detail.rating.pick.confirm")}
              {!apply.isPending && <Star className="ml-1 h-3.5 w-3.5" />}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}