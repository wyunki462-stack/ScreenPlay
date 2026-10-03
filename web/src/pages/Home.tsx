import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  Clock,
  Film,
  Gamepad2,
  HardDrive,
  Image as ImageIcon,
  ScanLine,
  Search,
  Video,
  GripVertical,
  RotateCcw,
} from "lucide-react";
import {
  useGames,
  usePlatformOptions,
  useReorderGames,
  useResetGameOrder,
  useScanLibrary,
  useStats,
  type GameFilters,
  type GameSortField,
  type SortOrder,
} from "../api/hooks";
import type { Stats, GameSummary } from "../types";
import { formatBytes, formatDuration } from "../lib/format";
import { useT } from "../i18n";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { Select } from "../components/ui/Select";
import { Skeleton } from "../components/ui/Skeleton";
import GameCard from "../components/GameCard";
import { setGalleryQuery } from "../lib/galleryState";

function StatCard({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-3">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-violet-600/15 text-violet-400">{icon}</span>
      <div className="min-w-0">
        <div className="truncate text-lg font-bold leading-tight text-zinc-100">{value}</div>
        <div className="text-xs text-zinc-400">{label}</div>
      </div>
    </div>
  );
}

function StatsBar({ stats }: { stats: Stats }) {
  const t = useT();
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      <StatCard icon={<Gamepad2 className="h-5 w-5" />} label={t("home.stats.totalGames")} value={String(stats.totalGames)} />
      <StatCard icon={<Film className="h-5 w-5" />} label={t("home.stats.totalMedia")} value={String(stats.totalMedia)} />
      <StatCard icon={<ImageIcon className="h-5 w-5" />} label={t("home.stats.totalImages")} value={String(stats.totalImages)} />
      <StatCard icon={<Video className="h-5 w-5" />} label={t("home.stats.totalVideos")} value={String(stats.totalVideos)} />
      <StatCard icon={<Clock className="h-5 w-5" />} label={t("home.stats.totalPlayTime")} value={formatDuration(stats.totalPlayTimeSeconds, t)} />
      <StatCard icon={<HardDrive className="h-5 w-5" />} label={t("home.stats.totalSize")} value={formatBytes(stats.totalSizeBytes)} />
    </div>
  );
}

function ErrorPanel({ message, onRetry }: { message: string; onRetry: () => void }) {
  const t = useT();
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-rose-900/50 bg-rose-950/30 p-10 text-center">
      <p className="text-sm text-rose-300">{message}</p>
      <Button variant="outline" onClick={onRetry}>
        {t("action.retry")}
      </Button>
    </div>
  );
}

export default function Home() {
  const t = useT();
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [platform, setPlatform] = useState("");
  const platformOptions = usePlatformOptions();
  const [sort, setSort] = useState<GameSortField>("name");
  // Drag-and-drop reordering only applies to the 「自定义排序」 mode; every other
  // mode keeps sorting by its own rule.
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; side: "before" | "after" } | null>(null);
  // Same value as `dropTarget`, but readable inside the dragover handler without
  // making it depend on (and resubscribe to) every render.
  const dropTargetRef = useRef<{ id: string; side: "before" | "after" } | null>(null);
  // Local mirror of the server order so a drop repaints immediately instead of
  // waiting for the round trip.
  const [pendingOrder, setPendingOrder] = useState<string[] | null>(null);
  const [order, setOrder] = useState<SortOrder>("asc");
  const [minScore, setMinScore] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const filters = useMemo<GameFilters>(() => {
    const next: GameFilters = { sort, order };
    if (debouncedSearch) next.search = debouncedSearch;
    const p = platform.trim();
    if (p) next.platform = p;
    const score = Number(minScore);
    if (minScore.trim() !== "" && Number.isFinite(score)) next.minScore = score;
    return next;
  }, [debouncedSearch, platform, sort, order, minScore]);

  const statsQuery = useStats();
  const gamesQuery = useGames(filters);

  // Mirror the filters for the detail page's prev/next navigation, so switching
  // games follows the order the user is actually looking at.
  useEffect(() => {
    setGalleryQuery({ search: debouncedSearch, platform, sort, order, minScore });
  }, [debouncedSearch, platform, sort, order, minScore]);

  const queryClient = useQueryClient();
  const reorder = useReorderGames();
  const resetOrder = useResetGameOrder();
  const customMode = sort === "custom";

  const serverGames = gamesQuery.data ?? [];
  /** Rendered order: the optimistic arrangement while a drop is in flight. */
  const orderedGames = useMemo(() => {
    if (!pendingOrder) return serverGames;
    const byId = new Map(serverGames.map((g) => [g.id, g]));
    const arranged = pendingOrder.map((id) => byId.get(id)).filter((g): g is GameSummary => !!g);
    // Anything the pending list does not know about (a scan finished mid-drag)
    // keeps its place at the end rather than vanishing.
    for (const g of serverGames) if (!pendingOrder.includes(g.id)) arranged.push(g);
    return arranged;
  }, [serverGames, pendingOrder]);

  // Once the server agrees, drop the optimistic copy.
  useEffect(() => {
    if (pendingOrder && !reorder.isPending) setPendingOrder(null);
  }, [reorder.isPending, pendingOrder]);

  /**
   * Apply a drop.
   *
   * The move is expressed as "between these two neighbours" rather than "at index
   * N": indexes shift under filtering and pagination, whereas a neighbour pair is
   * meaningful no matter what else is hidden.
   */
  const commitMove = (target: GameSummary) => {
    if (!dragId || dragId === target.id || !dropTarget) return;
    const side = dropTarget.side;

    const next = [...orderedGames];
    const from = next.findIndex((g) => g.id === dragId);
    if (from === -1) return;
    const [moved] = next.splice(from, 1);
    // Recompute the insertion point after removal — indices shift by one when the
    // dragged card sat earlier in the list.
    const anchor = next.findIndex((g) => g.id === target.id);
    if (anchor === -1) return;
    const at = side === "before" ? anchor : anchor + 1;
    next.splice(at, 0, moved);

    const above = next[at - 1] ?? null; // neighbour that ends up before it
    const below = next[at + 1] ?? null; // neighbour that ends up after it

    setPendingOrder(next.map((g) => g.id));
    // Persist into the query cache as well. The optimistic mirror above is
    // dropped the moment the request settles, so without this the grid would
    // flash the pre-drop order until the agreeing refetch lands — on a slow
    // round trip that reads as "the drag did not stick".
    queryClient.setQueryData<GameSummary[]>(["games", filters], next);
    dropTargetRef.current = null;
    setDragId(null);
    setDropTarget(null);
    reorder.mutate({ gameId: dragId, beforeId: below?.id ?? null, afterId: above?.id ?? null });
  };
  const scan = useScanLibrary();

  return (
    <div className="space-y-6">
      {statsQuery.isLoading ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-[68px]" />
          ))}
        </div>
      ) : statsQuery.isError ? (
        <div className="rounded-xl border border-rose-900/50 bg-rose-950/30 px-4 py-3 text-sm text-rose-300">{t("home.statsError")}</div>
      ) : (
        statsQuery.data ? <StatsBar stats={statsQuery.data} /> : null
      )}

      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 p-3">
        <div className="min-w-[200px] flex-1">
          <label htmlFor="home-search" className="mb-1 block text-xs text-zinc-400">{t("action.search")}</label>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
            <Input id="home-search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("home.searchPlaceholder")} className="w-full pl-8" />
          </div>
        </div>

        <div>
          <label htmlFor="home-platform" className="mb-1 block text-xs text-zinc-400">{t("home.platform")}</label>
          {/* Feature 6: options come from the backend, so platforms the user set
              manually are selectable here too. */}
          <Select
            id="home-platform"
            value={platform}
            onChange={(e) => setPlatform(e.target.value)}
            className="w-40"
          >
            <option value="">{t("home.allPlatforms")}</option>
            {(platformOptions.data ?? []).map((p) => (
              <option key={p.value} value={p.value}>
                {t("home.platformOption", { name: p.value, count: p.count })}
              </option>
            ))}
          </Select>
        </div>

        <div>
          <label htmlFor="home-min-score" className="mb-1 block text-xs text-zinc-400">{t("home.minScore")}</label>
          <Input id="home-min-score" value={minScore} onChange={(e) => setMinScore(e.target.value)} type="number" min={0} max={100} placeholder="0" className="w-24" />
        </div>

        <div>
          <label htmlFor="home-sort" className="mb-1 block text-xs text-zinc-400">{t("home.sortBy")}</label>
          <Select id="home-sort" value={sort} onChange={(e) => setSort(e.target.value as GameSortField)} className="w-28">
            <option value="name">{t("home.sort.name")}</option>
            <option value="created">{t("home.sort.created")}</option>
            <option value="duration">{t("home.sort.duration")}</option>
            <option value="mediaCount">{t("home.sort.mediaCount")}</option>
            <option value="metacritic">{t("home.sort.metacritic")}</option>
            {/* 拖拽排序模式：切到这里卡片才可拖动，其他模式仍按原规则 */}
            <option value="custom">{t("home.sort.custom")}</option>
          </Select>
        </div>

        <Button variant="outline" onClick={() => setOrder((o) => (o === "asc" ? "desc" : "asc"))} className="w-24">
          {order === "asc" ? (
            <>
              <ArrowUp className="h-4 w-4" /> {t("home.order.asc")}
            </>
          ) : (
            <>
              <ArrowDown className="h-4 w-4" /> {t("home.order.desc")}
            </>
          )}
        </Button>

        <Button onClick={() => scan.mutate()} disabled={scan.isPending}>
          <ScanLine className={scan.isPending ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
          {scan.isPending ? t("home.scanning") : t("home.scan")}
        </Button>
      </div>

      {scan.isError && (
        <div className="rounded-lg border border-rose-900/50 bg-rose-950/30 px-4 py-2 text-sm text-rose-300">{t("home.scanFailed")}</div>
      )}
      {scan.isSuccess && (
        <div className="rounded-lg border border-emerald-900/50 bg-emerald-950/30 px-4 py-2 text-sm text-emerald-300">{t("home.scanStarted")}</div>
      )}

      {gamesQuery.isLoading ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {Array.from({ length: 10 }).map((_, i) => (
            <div key={i} className="space-y-2">
              <Skeleton className="aspect-video" />
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          ))}
        </div>
      ) : gamesQuery.isError ? (
        <ErrorPanel message={t("home.gamesError")} onRetry={() => gamesQuery.refetch()} />
      ) : gamesQuery.data && gamesQuery.data.length > 0 ? (
        <>
          {customMode && (
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-violet-900/50 bg-violet-950/20 px-4 py-2">
              <span className="inline-flex items-center gap-2 text-sm text-violet-200">
                <GripVertical className="h-4 w-4" />
                {t("home.custom.hint")}
              </span>
              <Button
                variant="ghost"
                onClick={() => resetOrder.mutate()}
                disabled={resetOrder.isPending}
                className="h-8 text-xs"
              >
                <RotateCcw className="h-3.5 w-3.5" /> {t("home.custom.reset")}
              </Button>
            </div>
          )}
          {reorder.isError && (
            <div className="mb-3 rounded-lg border border-rose-900/50 bg-rose-950/30 px-4 py-2 text-sm text-rose-300">
              {t("home.custom.saveFailed")}
            </div>
          )}
          <div
            className={`grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 ${
              customMode ? "select-none" : ""
            }`}
            // Accept a drop anywhere inside the grid, not only on a card: without
            // this the cursor turns into 「禁止」 in the gutters and the gesture
            // feels dead at the edges. `preventDefault` is what arms onDrop.
            onDragOver={
              customMode
                ? (e) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                  }
                : undefined
            }
          >
            {orderedGames.map((game) => (
              <GameCard
                key={game.id}
                game={game}
                drag={
                  customMode
                    ? {
                        enabled: true,
                        dragging: dragId === game.id,
                        dropSide: dropTarget?.id === game.id ? dropTarget.side : null,
                        onDragStart: () => setDragId(game.id),
                        onDragOver: (side) => {
                          // Same target already highlighted — skip the state write.
                          // Without this the grid re-renders on every dragover tick.
                          if (dropTargetRef.current?.id === game.id && dropTargetRef.current.side === side) return;
                          dropTargetRef.current = { id: game.id, side };
                          setDropTarget({ id: game.id, side });
                        },
                        onDrop: () => commitMove(game),
                        onDragEnd: () => {
                          dropTargetRef.current = null;
                          setDragId(null);
                          setDropTarget(null);
                        },
                      }
                    : undefined
                }
              />
            ))}
          </div>
        </>
      ) : (
        <div className="rounded-xl border border-dashed border-zinc-800 p-16 text-center text-zinc-500">
          {t("home.emptyState")}
        </div>
      )}
    </div>
  );
}