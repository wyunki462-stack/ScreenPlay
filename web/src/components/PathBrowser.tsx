import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  ChevronRight,
  ChevronUp,
  Folder,
  HardDrive,
  Loader2,
  X,
} from "lucide-react";
import { useBrowsePath } from "../api/hooks";
import { useT } from "../i18n";
import { useEscapeClose } from "../lib/hooks";
import { Button } from "./ui/Button";

/**
 * "浏览…" folder picker for the media library editor.
 *
 * The backend does the listing (`GET /api/library/roots/browse`) and enforces the
 * allow-list, so this component works identically in every deployment shape —
 * Web/Linux, the Windows desktop shell opened in a browser, the build-free
 * webapp form, and LAN devices — because it is pure HTTP with no Tauri API.
 *
 * Only one level is shown at a time. The component is mounted only while the
 * dialog is open, so nothing is requested until the user clicks "浏览…"; and the
 * query key changes per folder, so React Query aborts a superseded request.
 */
export default function PathBrowser({
  initialPath,
  onSelect,
  onClose,
}: {
  /** Current value of the path input, used as the starting folder. */
  initialPath: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [current, setCurrent] = useState(initialPath.trim());
  const [selected, setSelected] = useState("");
  const query = useBrowsePath(current, true);
  const data = query.data;

  useEscapeClose(onClose);

  // A folder that loaded successfully becomes the default selection (covers the
  // "edit an existing root" case and the empty-path default root).
  useEffect(() => {
    if (data?.ok) setSelected((prev) => prev || data.path);
  }, [data?.ok, data?.path]);

  /** Navigate into `p` and treat it as the selection. */
  const go = useCallback((p: string) => {
    setCurrent(p);
    setSelected(p);
  }, []);

  const confirm = useCallback(() => {
    if (selected) onSelect(selected);
  }, [selected, onSelect]);

  // Enter confirms; Esc is handled by useEscapeClose.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        confirm();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirm]);

  const shownPath = data?.path || current;
  const crumbs = segments(shownPath);
  const roots = data?.roots ?? [];
  const entries = data?.entries ?? [];
  const loading = query.isFetching;
  const failure = query.isError ? t("library.browse.failed") : data && !data.ok ? data.message : null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        data-testid="path-browser"
        className="flex max-h-[85vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
          <h3 className="text-sm font-semibold text-zinc-100">{t("library.browse.title")}</h3>
          <button onClick={onClose} className="text-zinc-400 transition-colors hover:text-white">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
          <p className="text-xs text-zinc-500">{t("library.browse.hint")}</p>

          {/* Breadcrumb */}
          <div className="flex flex-wrap items-center gap-0.5 rounded-md border border-zinc-800 bg-zinc-950/60 px-2 py-1.5">
            <button
              onClick={() => data?.parent && go(data.parent)}
              disabled={!data?.parent}
              data-testid="path-browser-up"
              title={t("library.browse.up")}
              className="mr-1 flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-zinc-300 transition-colors hover:bg-zinc-800 disabled:opacity-30"
            >
              <ChevronUp className="h-3.5 w-3.5" />
              {t("library.browse.up")}
            </button>
            {crumbs.map((c, i) => (
              <span key={c.path} className="flex items-center gap-0.5">
                {i > 0 && <ChevronRight className="h-3 w-3 text-zinc-600" />}
                <button
                  onClick={() => go(c.path)}
                  className="max-w-[10rem] truncate rounded px-1 py-0.5 font-mono text-[11px] text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-white"
                >
                  {c.label}
                </button>
              </span>
            ))}
          </div>

          {/* Current folder */}
          <div className="flex items-center gap-2 text-[11px] text-zinc-400">
            <Folder className="h-3.5 w-3.5 shrink-0 text-sky-400" />
            <span className="truncate font-mono" data-testid="path-browser-current">
              {shownPath || "—"}
            </span>
          </div>

          {failure && (
            <p className="flex items-start gap-2 rounded-md bg-amber-950/40 px-3 py-2 text-xs text-amber-300">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{failure}</span>
            </p>
          )}

          {roots.length > 0 && (
            <div>
              <label className="mb-1.5 block text-xs font-medium text-zinc-300">
                {t("library.browse.roots")}
              </label>
              <div className="flex flex-wrap gap-1.5">
                {roots.map((r) => (
                  <button
                    key={r.path}
                    onClick={() => go(r.path)}
                    title={r.path}
                    data-testid="path-browser-root"
                    className={`flex items-center gap-1 rounded border px-2 py-1 text-[11px] transition-colors ${
                      shownPath === r.path
                        ? "border-sky-600 bg-sky-600/20 text-sky-200"
                        : "border-zinc-700 bg-zinc-800/60 text-zinc-300 hover:border-sky-600 hover:text-white"
                    }`}
                  >
                    <HardDrive className="h-3 w-3" />
                    {r.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* One level of subdirectories */}
          <div className="rounded-lg border border-zinc-800 bg-zinc-950/40">
            {loading ? (
              <p className="flex items-center justify-center gap-2 py-6 text-xs text-zinc-400">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {t("library.browse.loading")}
              </p>
            ) : entries.length === 0 ? (
              <p className="py-6 text-center text-xs text-zinc-500">
                {data?.ok ? t("library.browse.empty") : t("library.browse.failed")}
              </p>
            ) : (
              <ul className="max-h-[40vh] divide-y divide-zinc-800/60 overflow-y-auto">
                {entries.map((entry) => (
                  <li key={entry.path} className="flex items-center gap-1 px-1">
                    <input
                      type="checkbox"
                      checked={selected === entry.path}
                      onChange={() => setSelected(entry.path)}
                      className="mx-1 h-3.5 w-3.5 shrink-0 accent-sky-500"
                      aria-label={entry.name}
                      data-testid="path-browser-check"
                    />
                    <button
                      onClick={() => go(entry.path)}
                      data-testid="path-browser-entry"
                      className="flex min-w-0 flex-1 items-center gap-2 px-1.5 py-1.5 text-left text-xs text-zinc-200 transition-colors hover:text-white"
                    >
                      <Folder className="h-3.5 w-3.5 shrink-0 text-sky-400" />
                      <span className="truncate">{entry.name}</span>
                    </button>
                    <button
                      onClick={() => go(entry.path)}
                      title={t("library.browse.enter")}
                      aria-label={t("library.browse.enter")}
                      className="rounded p-1.5 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-white"
                    >
                      <ChevronRight className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-zinc-800 px-4 py-3">
          <span className="min-w-0 truncate text-xs text-zinc-500" title={selected}>
            {selected ? t("library.browse.selected", { path: selected }) : t("library.browse.current")}
          </span>
          <div className="flex shrink-0 gap-2">
            <Button variant="secondary" onClick={onClose}>
              {t("action.cancel")}
            </Button>
            <Button onClick={confirm} disabled={!selected} data-testid="path-browser-select">
              {t("library.browse.select")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Split a path into clickable breadcrumb segments, handling both POSIX and
 * Windows (`C:\a\b`) forms. `path` of each segment is a prefix to navigate to.
 */
function segments(p: string): { label: string; path: string }[] {
  if (!p) return [];
  const win = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  if (win) {
    const drive = `${win[1]}:\\`;
    const out = [{ label: `${win[1]}:`, path: drive }];
    let acc = drive;
    for (const name of win[2].split(/[\\/]+/).filter(Boolean)) {
      acc = acc.endsWith("\\") ? acc + name : `${acc}\\${name}`;
      out.push({ label: name, path: acc });
    }
    return out;
  }
  const out: { label: string; path: string }[] = [];
  let acc = "";
  for (const name of p.split("/").filter(Boolean)) {
    acc += `/${name}`;
    out.push({ label: name, path: acc });
  }
  if (out.length === 0 && p.startsWith("/")) out.push({ label: "/", path: "/" });
  return out;
}