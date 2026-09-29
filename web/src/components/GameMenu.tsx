import { useState, type ReactNode } from "react";
import { MoreHorizontal, Pencil, RefreshCw, Search, Trash2 } from "lucide-react";
import type { GameSummary } from "../types";
import { useDeleteGame, useRefreshGame } from "../api/hooks";
import { Button } from "./ui/Button";
import MatchDialog from "./MatchDialog";
import EditDialog from "./EditDialog";
import { useT } from "../i18n";

function MenuItem({
  icon,
  label,
  danger,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
        danger ? "text-rose-300 hover:bg-rose-950/50" : "text-zinc-200 hover:bg-zinc-800"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

export default function GameMenu({ game }: { game: GameSummary }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [matchOpen, setMatchOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteFiles, setDeleteFiles] = useState(false);

  const refresh = useRefreshGame(game.id);
  const remove = useDeleteGame(game.id);

  return (
    <>
      <div className="absolute right-1.5 top-1.5 z-10">
        <button
          type="button"
          title={t("dialogs.gameMenu.more")}
          aria-label={t("dialogs.gameMenu.more")}
          onClick={(e) => {
            e.stopPropagation();
            setOpen((o) => !o);
          }}
          className={`flex h-7 w-7 items-center justify-center rounded-md bg-black/60 text-zinc-200 transition-opacity hover:bg-black/80 hover:text-white ${
            open ? "opacity-100" : "opacity-0 group-hover:opacity-100"
          }`}
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>

        {open && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
            <div className="absolute right-0 top-9 z-20 w-40 overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900 py-1 shadow-2xl">
              <MenuItem
                icon={<Search className="h-4 w-4" />}
                label={t("dialogs.gameMenu.match")}
                onClick={() => {
                  setMatchOpen(true);
                  setOpen(false);
                }}
              />
              <MenuItem
                icon={<RefreshCw className="h-4 w-4" />}
                label={t("dialogs.gameMenu.refresh")}
                onClick={() => {
                  refresh.mutate();
                  setOpen(false);
                }}
              />
              <MenuItem
                icon={<Pencil className="h-4 w-4" />}
                label={t("dialogs.gameMenu.edit")}
                onClick={() => {
                  setEditOpen(true);
                  setOpen(false);
                }}
              />
              <MenuItem
                icon={<Trash2 className="h-4 w-4" />}
                label={t("action.delete")}
                danger
                onClick={() => {
                  setDeleteFiles(false);
                  setDeleteOpen(true);
                  setOpen(false);
                }}
              />
            </div>
          </>
        )}
      </div>

      {matchOpen && (
        <MatchDialog
          gameId={game.id}
          gameName={game.name}
          folderPath={game.folderPath}
          onClose={() => setMatchOpen(false)}
        />
      )}

      {editOpen && (
        <EditDialog
          gameId={game.id}
          name={game.name}
          platform={game.platform}
          onClose={() => setEditOpen(false)}
        />
      )}

      {deleteOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
          onClick={() => setDeleteOpen(false)}
        >
          <div
            className="w-full max-w-sm rounded-xl border border-zinc-800 bg-zinc-900 p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-semibold text-zinc-100">
              {t("dialogs.gameMenu.deleteTitle")}
            </h3>
            <p className="mt-2 text-sm text-zinc-400">
              {t("dialogs.gameMenu.deleteConfirm", { name: game.name })}
              {deleteFiles
                ? t("dialogs.gameMenu.deleteWithFiles")
                : t("dialogs.gameMenu.deleteKeepFiles")}
            </p>
            <label className="mt-3 flex items-center gap-2 text-sm text-zinc-300">
              <input
                type="checkbox"
                checked={deleteFiles}
                onChange={(e) => setDeleteFiles(e.target.checked)}
                className="h-4 w-4 accent-violet-600"
              />
              {t("dialogs.gameMenu.deleteFilesLabel")}
            </label>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setDeleteOpen(false)}>
                {t("action.cancel")}
              </Button>
              <Button
                variant="destructive"
                onClick={() => remove.mutate({ deleteFiles }, { onSuccess: () => setDeleteOpen(false) })}
                disabled={remove.isPending}
              >
                {remove.isPending ? t("dialogs.gameMenu.deleting") : t("action.delete")}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}