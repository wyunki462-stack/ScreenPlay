import { useState } from "react";
import { X } from "lucide-react";
import { useUpdateGame } from "../api/hooks";
import { Button } from "./ui/Button";
import { Input } from "./ui/Input";
import { useT } from "../i18n";

export default function EditDialog({
  gameId,
  name,
  platform,
  onClose,
}: {
  gameId: string;
  name: string;
  platform: string | null;
  onClose: () => void;
}) {
  const t = useT();
  const [nextName, setNextName] = useState(name);
  const [nextPlatform, setNextPlatform] = useState(platform ?? "");
  const update = useUpdateGame(gameId);

  const onSave = () => {
    update.mutate(
      { name: nextName, platform: nextPlatform },
      { onSuccess: onClose },
    );
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
          <h3 className="text-sm font-semibold text-zinc-100">
            {t("dialogs.edit.title", { name })}
          </h3>
          <button onClick={onClose} className="text-zinc-400 transition-colors hover:text-white">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4 p-4">
          <label className="block space-y-1.5">
            <span className="text-sm text-zinc-300">{t("dialogs.edit.name")}</span>
            <Input
              value={nextName}
              onChange={(e) => setNextName(e.target.value)}
              placeholder={t("dialogs.edit.namePlaceholder")}
              autoFocus
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-sm text-zinc-300">{t("dialogs.edit.platform")}</span>
            <Input
              value={nextPlatform}
              onChange={(e) => setNextPlatform(e.target.value)}
              placeholder={t("dialogs.edit.platformPlaceholder")}
            />
          </label>
          <p className="text-xs text-zinc-500">{t("dialogs.edit.hint")}</p>
        </div>

        <div className="flex justify-end gap-2 border-t border-zinc-800 px-4 py-3">
          <Button variant="ghost" onClick={onClose}>
            {t("action.cancel")}
          </Button>
          <Button onClick={onSave} disabled={update.isPending || !nextName.trim()}>
            {update.isPending ? t("dialogs.edit.saving") : t("action.save")}
          </Button>
        </div>
      </div>
    </div>
  );
}