import { useEffect, useState } from "react";
import { AlertCircle, Check, Gamepad2, Info, X } from "lucide-react";
import {
  useAchievementCandidates,
  useAchievementTarget,
  useClearAchievementTarget,
  useSetAchievementTarget,
} from "../api/hooks";
import type { AchievementCandidate } from "../types";
import { Button } from "./ui/Button";
import { Input } from "./ui/Input";
import { useT } from "../i18n";

/**
 * 「手动选择游戏」 — pick the achievement/trophy entry for one game by hand.
 *
 * Automatic matching infers the target from the folder name, which gets
 * abbreviations, multi-release titles and duplicate names wrong (a folder called
 * "007" cannot tell "007 First Light" from "GoldenEye 007"). Whatever is chosen
 * here is persisted, so later full scrapes and refreshes reuse it instead of
 * falling back to the guess.
 *
 * Styling mirrors `MatchDialog` so both entry points look like one family.
 */
export default function AchievementPickDialog({
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
  const [selected, setSelected] = useState<AchievementCandidate | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const target = useAchievementTarget(gameId);
  const candidates = useAchievementCandidates(gameId, debounced);
  const apply = useSetAchievementTarget(gameId);
  const clear = useClearAchievementTarget(gameId);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 400);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    // A new result set invalidates the previous pick.
    setSelected(null);
  }, [debounced]);

  const items = candidates.data?.items ?? [];
  const current = target.data?.target ?? null;
  const busy = apply.isPending || clear.isPending;

  const onConfirm = () => {
    if (!selected) return;
    setResult(null);
    apply.mutate(
      { source: selected.source, externalId: selected.externalId, name: selected.name },
      {
        onSuccess: (data) => {
          // A scrape failure still answers HTTP 200, so the payload decides.
          setResult(
            data?.status === "failed"
              ? { ok: false, text: t("detail.achievements.pick.failedMsg") }
              : { ok: true, text: t("detail.achievements.pick.done") },
          );
        },
        onError: () => setResult({ ok: false, text: t("detail.achievements.pick.failedMsg") }),
      },
    );
  };

  const onClear = () => {
    setResult(null);
    clear.mutate(undefined, {
      onSuccess: () => setResult({ ok: true, text: t("detail.achievements.pick.cleared") }),
      onError: () => setResult({ ok: false, text: t("detail.achievements.pick.failedMsg") }),
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
            {t("detail.achievements.pick.title", { name: gameName })}
          </h3>
          <button onClick={onClose} className="text-zinc-400 transition-colors hover:text-white">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex items-start gap-2 border-b border-zinc-800 px-4 py-2.5">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-zinc-500" />
          <span className="min-w-0 text-xs leading-relaxed text-zinc-400">
            {t("detail.achievements.pick.intro")}
          </span>
        </div>

        {(current || target.data) && (
          <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-2 text-xs text-zinc-400">
            <Gamepad2 className="h-3.5 w-3.5 shrink-0 text-violet-400" />
            {current ? (
              <span className="min-w-0 truncate">
                {t("detail.achievements.pick.current", { name: `${current.name ?? current.externalId}` })}
              </span>
            ) : (
              <span className="min-w-0 truncate text-zinc-500">{t("detail.achievements.pick.cleared")}</span>
            )}
          </div>
        )}

        <div className="border-b border-zinc-800 p-4">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("detail.achievements.pick.placeholder")}
            autoFocus
          />
        </div>

        <div className="flex-1 space-y-1 overflow-y-auto p-4">
          {!debounced && (
            <div className="py-4 text-center text-sm text-zinc-500">
              {t("detail.achievements.pick.emptyQuery")}
            </div>
          )}
          {debounced && candidates.isFetching && (
            <div className="py-4 text-center text-sm text-zinc-500">
              {t("detail.achievements.pick.searching")}
            </div>
          )}
          {debounced && !candidates.isFetching && items.length === 0 && (
            <div className="py-4 text-center text-sm text-zinc-500">
              {t("detail.achievements.pick.noResults")}
            </div>
          )}
          {items.map((r, i) => {
            const active = selected?.source === r.source && selected?.externalId === r.externalId;
            const isCurrent = current?.source === r.source && current?.externalId === r.externalId;
            return (
              <button
                key={`${r.source}-${r.externalId}-${i}`}
                type="button"
                onClick={() => setSelected(r)}
                className={`flex w-full items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left transition-colors ${
                  active
                    ? "border-violet-600 bg-violet-600/10"
                    : "border-zinc-800 hover:border-zinc-600 hover:bg-zinc-800"
                }`}
              >
                <div className="min-w-0">
                  <div className="truncate text-sm text-zinc-100">
                    {r.name}
                    {isCurrent && (
                      <span className="ml-2 rounded bg-emerald-900/50 px-1.5 py-0.5 text-[10px] text-emerald-300">
                        {t("detail.achievements.pick.open")}
                      </span>
                    )}
                  </div>
                  <div className="truncate text-xs text-zinc-500">
                    {r.sourceLabel}
                    {r.platform ? ` · ${r.platform}` : ""}
                    {r.releaseYear ? ` · ${r.releaseYear}` : ""}
                    {r.detail ? ` · ${r.detail}` : ""}
                  </div>
                </div>
                <span
                  className={`h-4 w-4 shrink-0 rounded-full border ${
                    active ? "border-violet-500 bg-violet-500" : "border-zinc-600"
                  }`}
                />
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
            {current && (
              <Button variant="ghost" onClick={onClear} disabled={busy}>
                {t("detail.achievements.pick.clear")}
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              {t("action.close")}
            </Button>
            <Button onClick={onConfirm} disabled={!selected || busy}>
              {apply.isPending
                ? t("detail.achievements.pick.applying")
                : t("detail.achievements.pick.confirm")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}