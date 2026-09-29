import { useEffect, useState } from "react";
import { AlertCircle, Check, FolderOpen, X } from "lucide-react";
import { useMatchGame, useSearchMatches, type MatchCandidate } from "../api/hooks";
import { Button } from "./ui/Button";
import { Input } from "./ui/Input";
import { useT } from "../i18n";

export default function MatchDialog({
  gameId,
  gameName,
  folderPath,
  onClose,
}: {
  gameId: string;
  gameName: string;
  folderPath?: string;
  onClose: () => void;
}) {
  const t = useT();
  const [query, setQuery] = useState(gameName);
  const [debounced, setDebounced] = useState(gameName);
  const [selected, setSelected] = useState<MatchCandidate | null>(null);
  const { data, isFetching } = useSearchMatches(debounced);
  const match = useMatchGame(gameId);
  /** Result banner: `null` = idle, `{ ok }` = finished. */
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 400);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    setSelected(null);
    setResult(null);
  }, [debounced]);

  const onConfirm = () => {
    if (!selected) return;
    setResult(null);
    match.mutate(
      { provider: selected.provider, externalId: selected.externalId },
      {
        onSuccess: (data) => {
          // Keep the dialog open briefly so the user sees WHAT was bound and
          // whether anything failed, instead of a silent close.
          const name = data?.name ?? selected.name;
          const failed = data?.failed ?? [];
          const missing = data?.missing ?? [];

          if (data?.matched === false) {
            // The binding resolved, but no provider could describe the entity.
            setResult({
              ok: false,
              text: data?.reason
                ? t("dialogs.match.boundNoDataReason", { name, reason: data.reason })
                : t("dialogs.match.boundNoData", { name }),
            });
          } else if (failed.length) {
            setResult({
              ok: false,
              text: t("dialogs.match.boundAllFailed", {
                name,
                sources: failed.join(t("dialogs.match.listSeparator")),
              }),
            });
          } else if (missing.length) {
            // Partial success is the common real case: the name and poster come
            // from one provider while another simply has no data for the title.
            setResult({
              ok: false,
              text: t("dialogs.match.boundPartial", {
                name,
                sources: missing.join(t("dialogs.match.listSeparator")),
              }),
            });
          } else {
            setResult({ ok: true, text: t("dialogs.match.boundSuccess", { name }) });
            setTimeout(onClose, 900);
          }
        },
        onError: (err) => {
          setResult({
            ok: false,
            text: t("dialogs.match.matchFailed", {
              message: (err as Error)?.message || t("dialogs.match.unknownError"),
            }),
          });
        },
      },
    );
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
            {t("dialogs.match.title", { name: gameName })}
          </h3>
          <button onClick={onClose} className="text-zinc-400 transition-colors hover:text-white">
            <X className="h-5 w-5" />
          </button>
        </div>

        {folderPath && (
          <div className="flex items-start gap-2 border-b border-zinc-800 px-4 py-2.5">
            <FolderOpen className="mt-0.5 h-4 w-4 shrink-0 text-zinc-500" />
            <span className="min-w-0 break-all text-xs text-zinc-400">{folderPath}</span>
          </div>
        )}

        <div className="border-b border-zinc-800 p-4">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("dialogs.match.searchPlaceholder")}
            autoFocus
          />
        </div>

        <div className="flex-1 space-y-1 overflow-y-auto p-4">
          {isFetching && (
            <div className="py-4 text-center text-sm text-zinc-500">
              {t("dialogs.match.searching")}
            </div>
          )}
          {!isFetching && data && data.length === 0 && (
            <div className="py-4 text-center text-sm text-zinc-500">
              {t("dialogs.match.noResults")}
            </div>
          )}
          {(data ?? []).map((r, i) => {
            const active =
              selected?.provider === r.provider && selected?.externalId === r.externalId;
            return (
              <button
                key={`${r.provider}-${r.externalId}-${i}`}
                type="button"
                onClick={() => setSelected(r)}
                className={`flex w-full items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left transition-colors ${
                  active
                    ? "border-violet-600 bg-violet-600/10"
                    : "border-zinc-800 hover:border-zinc-600 hover:bg-zinc-800"
                }`}
              >
                <div className="min-w-0">
                  <div className="truncate text-sm text-zinc-100">{r.name}</div>
                  <div className="text-xs text-zinc-500">
                    {r.provider}
                    {r.platform ? ` · ${r.platform}` : ""}
                    {r.releaseYear ? ` · ${r.releaseYear}` : ""}
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

        <div className="flex justify-end gap-2 border-t border-zinc-800 px-4 py-3">
          <Button variant="ghost" onClick={onClose}>
            {result?.ok ? t("action.close") : t("action.cancel")}
          </Button>
          <Button onClick={onConfirm} disabled={!selected || match.isPending}>
            {match.isPending
              ? t("dialogs.match.binding")
              : result?.ok
                ? t("dialogs.match.rebind")
                : t("action.confirm")}
          </Button>
        </div>
      </div>
    </div>
  );
}