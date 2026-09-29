import { useEffect, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  FolderPlus,
  HardDrive,
  Loader2,
  Pencil,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import {
  useAddLibraryRoot,
  useCheckRoot,
  useDeleteLibraryRoot,
  useLibraryRoots,
  useMountedRoots,
  useScanLibrary,
  useUpdateLibraryRoot,
  type LibraryRoot,
} from "../api/hooks";
import { useT } from "../i18n";
import { Button } from "./ui/Button";
import { Input } from "./ui/Input";

/**
 * "媒体库管理" module for the Settings page (feature 2).
 *
 * Add / edit / delete media library roots from the web UI. Saving takes effect
 * immediately and triggers a scan — no container rebuild, no .env editing.
 * Everything is stored in SQLite, so it also survives a rebuild.
 */
export default function LibraryManager() {
  const t = useT();
  const [editing, setEditing] = useState<LibraryRoot | "new" | null>(null);
  const { data: roots = [], isLoading } = useLibraryRoots();
  const remove = useDeleteLibraryRoot();
  const scan = useScanLibrary();
  const [error, setError] = useState<string | null>(null);
  const { data: mounted } = useMountedRoots();

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <HardDrive className="h-4 w-4 text-sky-400" />
          <h2 className="text-sm font-semibold text-zinc-100">{t("library.title")}</h2>
          <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">
            {t("library.count", { count: roots.length })}
          </span>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => scan.mutate()} disabled={scan.isPending}>
            {scan.isPending ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-1.5 h-4 w-4" />
            )}
            {t("library.rescan")}
          </Button>
          <Button onClick={() => setEditing("new")}>
            <FolderPlus className="mr-1.5 h-4 w-4" />
            {t("library.add")}
          </Button>
        </div>
      </div>

      <p className="mb-4 text-xs text-zinc-500">{t("library.intro")}</p>

      {error && (
        <p className="mb-3 rounded-md bg-red-950/40 px-3 py-2 text-xs text-red-300">{error}</p>
      )}

      {isLoading ? (
        <p className="py-6 text-center text-sm text-zinc-500">{t("action.loading")}</p>
      ) : roots.length === 0 ? (
        <p className="py-6 text-center text-sm text-zinc-500">{t("library.empty")}</p>
      ) : (
        <ul className="space-y-2">
          {roots.map((root) => (
            <li
              key={root.id}
              className={`flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2.5 ${
                root.enabled ? "border-zinc-800 bg-zinc-900" : "border-zinc-800/60 bg-zinc-900/40"
              }`}
            >
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${
                  !root.enabled
                    ? "bg-zinc-600"
                    : root.exists
                      ? "bg-emerald-500"
                      : "bg-red-500"
                }`}
              />

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate font-mono text-xs text-zinc-200">{root.path}</span>
                  {root.label && (
                    <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">
                      {root.label}
                    </span>
                  )}
                  <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">
                    {root.mediaType === "auto"
                      ? t("library.mediaType.auto")
                      : root.mediaType === "image"
                        ? t("library.mediaType.image")
                        : t("library.mediaType.video")}
                  </span>
                  <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">
                    {root.recursive ? t("library.recursive") : t("library.currentOnly")}
                  </span>
                  {root.source === "env" && (
                    <span
                      className="rounded bg-amber-950/60 px-1.5 py-0.5 text-[10px] text-amber-300"
                      title={t("library.fromEnvTitle")}
                    >
                      {t("library.fromEnv")}
                    </span>
                  )}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-3 text-[11px] text-zinc-500">
                  {!root.enabled && <span>{t("library.disabled")}</span>}
                  {root.enabled && !root.exists && (
                    <span className="text-red-400">{t("library.missing")}</span>
                  )}
                  {root.exists && root.gameCount != null && (
                    <span>{t("library.gameCount", { count: root.gameCount })}</span>
                  )}
                </div>
              </div>

              <div className="flex shrink-0 items-center gap-1">
                <button
                  onClick={() => setEditing(root)}
                  className="rounded p-1.5 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-white"
                  title={t("action.edit")}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                {root.source === "user" ? (
                  <button
                    onClick={() => {
                      setError(null);
                      remove.mutate(root.id, {
                        onError: (e) => setError(e.message),
                      });
                    }}
                    className="rounded p-1.5 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-red-400"
                    title={t("action.delete")}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                ) : (
                  <button
                    onClick={() =>
                      setEditing(root)
                    }
                    className="rounded p-1.5 text-zinc-500 transition-colors hover:bg-zinc-800"
                    title={t("library.envEditOnly")}
                  >
                    <Pencil className="h-3.5 w-3.5 opacity-40" />
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <RootEditor
          root={editing === "new" ? null : editing}
          mountedPaths={mounted?.paths ?? []}
          onClose={() => setEditing(null)}
          onError={setError}
        />
      )}
    </section>
  );
}

/** Add / edit form for a single root. */
function RootEditor({
  root,
  mountedPaths,
  onClose,
  onError,
}: {
  root: LibraryRoot | null;
  mountedPaths: string[];
  onClose: () => void;
  onError: (message: string | null) => void;
}) {
  const t = useT();
  const [path, setPath] = useState(root?.path ?? "");
  const [label, setLabel] = useState(root?.label ?? "");
  const [mediaType, setMediaType] = useState<"auto" | "image" | "video">(root?.mediaType ?? "auto");
  const [recursive, setRecursive] = useState(root?.recursive ?? true);
  const [enabled, setEnabled] = useState(root?.enabled ?? true);
  const [debounced, setDebounced] = useState(path);
  const [saveError, setSaveError] = useState<string | null>(null);

  const add = useAddLibraryRoot();
  const update = useUpdateLibraryRoot();
  const check = useCheckRoot(debounced);
  const isEnv = root?.source === "env";

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(path.trim()), 500);
    return () => clearTimeout(timer);
  }, [path]);

  const busy = add.isPending || update.isPending;

  const save = () => {
    setSaveError(null);
    const payload = { path: path.trim(), label: label.trim(), mediaType, recursive, enabled, scan: true };
    const opts = {
      onSuccess: () => {
        onError(null);
        onClose();
      },
      onError: (e: Error) => setSaveError(e.message),
    };
    if (root) update.mutate({ ...payload, id: root.id }, opts);
    else add.mutate(payload, opts);
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
          <h3 className="text-sm font-semibold text-zinc-100">
            {root ? t("library.edit") : t("library.add")}
          </h3>
          <button onClick={onClose} className="text-zinc-400 transition-colors hover:text-white">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-zinc-300">
              {t("library.pathLabel")}
            </label>
            <Input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/media/games"
              disabled={isEnv}
              className="font-mono text-xs"
            />
            <p className="mt-1.5 text-[11px] text-zinc-500">{t("library.pathHint")}</p>
          </div>

          {/* Live path validation */}
          {!isEnv && path.trim().length > 0 && (
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2.5 text-xs">
              {check.isFetching ? (
                <span className="flex items-center gap-2 text-zinc-400">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  {t("library.checking")}
                </span>
              ) : check.isError ? (
                <span className="flex items-center gap-2 text-zinc-400">
                  <AlertCircle className="h-3.5 w-3.5" />
                  {t("library.checkFailed")}
                </span>
              ) : check.data ? (
                <div className="space-y-1.5">
                  <span
                    className={`flex items-center gap-2 ${
                      check.data.ok ? "text-emerald-400" : "text-amber-400"
                    }`}
                  >
                    {check.data.ok ? (
                      <CheckCircle2 className="h-3.5 w-3.5" />
                    ) : (
                      <AlertCircle className="h-3.5 w-3.5" />
                    )}
                    {check.data.message}
                  </span>
                  {check.data.sampleNames?.length > 0 && (
                    <p className="text-zinc-500">
                      {t("library.sampleFolders", {
                        names: check.data.sampleNames.join(t("library.sampleSeparator")),
                      })}
                    </p>
                  )}
                  {!check.data.ok && check.data.mountedHint && (
                    <p className="text-zinc-500">{check.data.mountedHint}</p>
                  )}
                </div>
              ) : null}
            </div>
          )}

          {!isEnv && mountedPaths.length > 0 && (
            <div>
              <label className="mb-1.5 block text-xs font-medium text-zinc-300">
                {t("library.mountedLabel")}
              </label>
              <div className="flex flex-wrap gap-1.5">
                {mountedPaths.map((p) => (
                  <button
                    key={p}
                    onClick={() => setPath(p)}
                    className="rounded border border-zinc-700 bg-zinc-800/60 px-2 py-1 font-mono text-[11px] text-zinc-300 transition-colors hover:border-sky-600 hover:text-white"
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div>
            <label className="mb-1.5 block text-xs font-medium text-zinc-300">
              {t("library.labelLabel")}
            </label>
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={t("library.labelPlaceholder")}
            />
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-zinc-300">
              {t("library.mediaTypeLabel")}
            </label>
            <div className="flex overflow-hidden rounded-md border border-zinc-700">
              {(
                [
                  ["auto", "library.mediaType.auto"],
                  ["image", "library.mediaType.image"],
                  ["video", "library.mediaType.video"],
                ] as const
              ).map(([value, labelKey]) => (
                <button
                  key={value}
                  onClick={() => setMediaType(value)}
                  className={`flex-1 px-3 py-1.5 text-xs transition-colors ${
                    mediaType === value
                      ? "bg-sky-600 text-white"
                      : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
                  }`}
                >
                  {t(labelKey)}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-2.5">
            <label className="flex cursor-pointer items-center gap-2 text-xs text-zinc-300">
              <input
                type="checkbox"
                checked={recursive}
                onChange={(e) => setRecursive(e.target.checked)}
                className="h-3.5 w-3.5 accent-sky-500"
              />
              {t("library.scanSubfolders")}
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-xs text-zinc-300">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
                className="h-3.5 w-3.5 accent-sky-500"
              />
              {t("library.enable")}
            </label>
          </div>

          {saveError && (
            <p className="rounded-md bg-red-950/40 px-3 py-2 text-xs text-red-300">{saveError}</p>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-zinc-800 px-4 py-3">
          <span className="text-xs text-zinc-500">{t("library.saveHint")}</span>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose}>
              {t("action.cancel")}
            </Button>
            <Button
              onClick={save}
              disabled={busy || (!isEnv && !path.trim())}
            >
              {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              {t("library.saveAndScan")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}