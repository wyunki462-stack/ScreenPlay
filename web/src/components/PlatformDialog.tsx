import { useState } from "react";
import { Loader2, X } from "lucide-react";
import { useUpdateGame } from "../api/hooks";
import type { GameDetail } from "../types";
import { Button } from "./ui/Button";
import { useT } from "../i18n";
import { useEscapeClose } from "../lib/hooks";

/**
 * "平台设置" dialog (feature 6).
 *
 * Multi-select of play platforms. The selection is stored on the game and
 * replaces whatever was auto-detected, so filtering the gallery by e.g.
 * "PlayStation 5" finds a game that was originally detected as PC.
 */
export default function PlatformDialog({
  game,
  onClose,
}: {
  game: GameDetail;
  onClose: () => void;
}) {
  const t = useT();
  const [selected, setSelected] = useState<string[]>(game.platforms ?? []);
  const [error, setError] = useState<string | null>(null);
  const update = useUpdateGame(game.id);
  const options = game.knownPlatforms ?? [];

  useEscapeClose(onClose);

  const toggle = (value: string) =>
    setSelected((prev) =>
      prev.includes(value) ? prev.filter((p) => p !== value) : [...prev, value],
    );

  const save = () =>
    update.mutate(
      { platforms: selected },
      {
        onSuccess: onClose,
        onError: (e) => setError(e.message),
      },
    );

  // A pre-existing auto-detected platform that isn't in the standard list is
  // still offered, so the user does not lose it.
  const extras = (game.platforms ?? []).filter((p) => !options.includes(p));

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
          <h3 className="text-sm font-semibold text-zinc-100">
            {t("dialogs.platform.title", { name: game.name })}
          </h3>
          <button onClick={onClose} className="text-zinc-400 transition-colors hover:text-white">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <p className="mb-3 text-xs text-zinc-400">{t("dialogs.platform.hint")}</p>

          <div className="flex flex-wrap gap-2">
            {[...options, ...extras].map((p) => {
              const active = selected.includes(p);
              return (
                <button
                  key={p}
                  onClick={() => toggle(p)}
                  className={`rounded-full border px-3 py-1.5 text-xs transition-colors ${
                    active
                      ? "border-sky-500 bg-sky-600/20 text-sky-200"
                      : "border-zinc-700 bg-zinc-800/60 text-zinc-300 hover:border-zinc-600"
                  }`}
                >
                  {active && "✓ "}
                  {p}
                </button>
              );
            })}
          </div>

          {selected.length > 0 && (
            <button
              onClick={() => setSelected([])}
              className="mt-4 text-xs text-zinc-500 underline transition-colors hover:text-zinc-300"
            >
              {t("dialogs.platform.clearSelection")}
            </button>
          )}

          {error && <p className="mt-3 text-xs text-red-400">{error}</p>}
        </div>

        <div className="flex items-center justify-between border-t border-zinc-800 px-4 py-3">
          <span className="text-xs text-zinc-500">
            {selected.length === 0
              ? t("dialogs.platform.autoDetected")
              : t("dialogs.platform.selectedCount", { n: selected.length })}
          </span>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose}>
              {t("action.cancel")}
            </Button>
            <Button onClick={save} disabled={update.isPending}>
              {update.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              {t("action.save")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}