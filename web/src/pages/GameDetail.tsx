import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  AlertTriangle,
  ArrowLeft,
  Award,
  Building2,
  Calendar,
  Clock,
  Crown,
  Gamepad2,
  ImagePlus,
  Info,
  LoaderCircle,
  Medal,
  Package,
  RefreshCw,
  Search,
  Tag,
  Timer,
  Trophy,
  Users,
  Star,
  type LucideIcon,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import {
  useGameNeighbors,
  useAchievements,
  useGame,
  useGameMedia,
  useRefreshAchievements,
  useRefreshGame,
} from "../api/hooks";
import { useT, type Translate } from "../i18n";
import { formatDate } from "../lib/format";
import { cn, metacriticTone, type MetacriticTone } from "../lib/utils";
import type {
  Achievement,
  AchievementCounts,
  AchievementTier,
  AchievementsResponse,
  GameDetail as GameDetailType,
  Price,
  Rating,
  TimelineEvent,
  TimelineType,
} from "../types";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card, CardContent, CardHeader } from "../components/ui/Card";
import { Skeleton } from "../components/ui/Skeleton";
import { Tabs } from "../components/ui/Tabs";
import { MetacriticBadge } from "../components/MetacriticBadge";
import HeroPosterCarousel from "../components/HeroPosterCarousel";
import MediaReviewsPanel from "../components/MediaReviewsPanel";
import MediaGrid from "../components/MediaGrid";
import MatchDialog from "../components/MatchDialog";
import AchievementPickDialog from "../components/AchievementPickDialog";
import RatingPickDialog from "../components/RatingPickDialog";
import { useGalleryQuery } from "../lib/galleryState";
import PosterDialog from "../components/PosterDialog";
import PlatformDialog from "../components/PlatformDialog";
import PosterCarousel from "../components/PosterCarousel";

type DetailTab = "media" | "timeline" | "achievements" | "ratings";

/** Tab labels are dictionary keys so the table stays language-agnostic. */
const tabItems: { value: DetailTab; labelKey: string }[] = [
  { value: "media", labelKey: "detail.tab.media" },
  { value: "timeline", labelKey: "detail.tab.timeline" },
  { value: "achievements", labelKey: "detail.tab.achievements" },
  { value: "ratings", labelKey: "detail.tab.ratings" },
];

const timelineLabels: Record<TimelineType, string> = {
  first_media: "detail.timeline.firstMedia",
  last_media: "detail.timeline.lastMedia",
  milestone: "detail.timeline.milestone",
  note: "detail.timeline.note",
};

/**
 * Posters for the detail header: the selected cover first, then every other
 * poster the user can manage, then the game's screenshots.
 *
 * This must be the full set, not just the rotation queue. `game.posters` only
 * holds rows flagged `in_slideshow`, which meant a game with seven scraped
 * official posters still handed the carousel a single URL — the other six were
 * registered (and visible in the edit dialog) but unreachable in the big image.
 * The carousel's arrows browse this list; `in_slideshow` still decides only
 * whether the rotation auto-advances.
 */
function detailPosters(game: GameDetailType): string[] {
  const selected = (game.posterList ?? []).filter((p) => p.isSelected).map((p) => p.url);
  const rest = (game.posterList ?? []).map((p) => p.url);
  const list = [
    ...selected,
    ...(game.posterUrl ? [game.posterUrl] : []),
    ...(game.posters ?? []),
    ...rest,
    ...(game.screenshots ?? []),
  ].filter((u): u is string => typeof u === "string" && u.length > 0);
  return [...new Set(list)];
}

/** Platform tags for the detail header. */
function detailPlatforms(game: GameDetailType): string[] {
  const list = (game.platforms ?? []).filter(Boolean);
  if (list.length) return list;
  return game.platform ? [game.platform] : [];
}

const scoreTextColor: Record<MetacriticTone, string> = {
  green: "text-emerald-400",
  yellow: "text-amber-400",
  red: "text-rose-500",
  none: "text-zinc-400",
};

function InfoItem({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2.5">
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center text-zinc-500">{icon}</span>
      <div className="min-w-0 text-sm">
        <div className="text-xs text-zinc-500">{label}</div>
        <div className="text-zinc-200">{children}</div>
      </div>
    </div>
  );
}

function EmptyHint({ text }: { text: string }) {
  return <div className="rounded-lg border border-dashed border-zinc-800 p-8 text-center text-sm text-zinc-500">{text}</div>;
}

function formatHltb(game: GameDetailType, t: Translate): string {
  const parts: string[] = [];
  if (game.mainStoryHours != null) parts.push(t("detail.playtime.mainStory", { hours: game.mainStoryHours }));
  if (game.mainPlusExtraHours != null) parts.push(t("detail.playtime.mainPlusExtra", { hours: game.mainPlusExtraHours }));
  if (game.completionistHours != null) parts.push(t("detail.playtime.completionist", { hours: game.completionistHours }));
  return parts.length > 0 ? parts.join(" · ") : t("state.unknown");
}

function formatPrice(price: Price, t: Translate): string {
  if (price.currentPrice == null) return t("state.unknown");
  const currency = price.currency ?? "";
  const parts: string[] = [`${price.currentPrice} ${currency}`.trim()];
  if (price.initialPrice != null && price.initialPrice > price.currentPrice) {
    parts.push(t("detail.price.was", { price: `${price.initialPrice} ${currency}`.trim() }));
  }
  if (price.discountPercent != null) parts.push(`-${price.discountPercent}%`);
  if (price.historicalLow != null) parts.push(t("detail.price.low", { price: `${price.historicalLow} ${currency}`.trim() }));
  return parts.join(" · ");
}

function Timeline({ events }: { events: TimelineEvent[] }) {
  const t = useT();
  if (events.length === 0) return <EmptyHint text={t("detail.timeline.empty")} />;
  return (
    <ol className="relative space-y-5 border-l border-zinc-800 pl-5">
      {events.map((ev, i) => (
        <li key={i} className="relative">
          <span className="absolute -left-[26px] top-1 h-3 w-3 rounded-full bg-violet-500 ring-4 ring-zinc-950" />
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-zinc-500">{formatDate(ev.date, t)}</span>
            <Badge variant="secondary">{t(timelineLabels[ev.type])}</Badge>
          </div>
          <div className="mt-1 text-sm font-medium text-zinc-100">{ev.title}</div>
          {ev.description && <div className="mt-0.5 text-xs text-zinc-400">{ev.description}</div>}
        </li>
      ))}
    </ol>
  );
}

// --- Achievements & trophies -------------------------------------------------

/** Trophy tiers, strongest first — the order the groups are rendered in. */
const TIER_ORDER: AchievementTier[] = ["platinum", "gold", "silver", "bronze"];

/**
 * One colour per tier, tuned for the dark zinc theme: platinum reads cyan/sky,
 * gold amber, silver neutral zinc, bronze orange. `text` is reused for the group
 * heading so a heading and its chips cannot drift apart visually.
 */
const tierStyles: Record<
  AchievementTier,
  { labelKey: string; text: string; chip: string; badge: string; Icon: LucideIcon }
> = {
  platinum: {
    labelKey: "detail.achievements.tierPlatinum",
    text: "text-sky-300",
    chip: "border-sky-500/40 bg-sky-500/10",
    badge: "border-sky-500/40 bg-sky-500/20",
    Icon: Crown,
  },
  gold: {
    labelKey: "detail.achievements.tierGold",
    text: "text-amber-300",
    chip: "border-amber-500/40 bg-amber-500/10",
    badge: "border-amber-500/40 bg-amber-500/20",
    Icon: Trophy,
  },
  silver: {
    labelKey: "detail.achievements.tierSilver",
    text: "text-zinc-200",
    chip: "border-zinc-500/50 bg-zinc-500/10",
    badge: "border-zinc-500/50 bg-zinc-500/20",
    Icon: Medal,
  },
  bronze: {
    labelKey: "detail.achievements.tierBronze",
    text: "text-orange-300",
    chip: "border-orange-600/40 bg-orange-600/10",
    badge: "border-orange-600/40 bg-orange-600/20",
    Icon: Award,
  },
};

/** One rendered block of achievements: a trophy tier, a DLC, or the whole list. */
interface AchievementSection {
  key: string;
  /** Set for tier sections — the heading is then built from `tierStyles`. */
  tier: AchievementTier | null;
  /** Heading text for non-tier sections (DLC / base game). */
  heading: string | null;
  items: Achievement[];
}

/** The backend already sorts, but grouping must not rely on that. */
const bySortOrder = (a: Achievement, b: Achievement) => a.sortOrder - b.sortOrder;

/** PlayStation: one section per tier, platinum → bronze, order kept inside. */
function tierSections(items: Achievement[]): AchievementSection[] {
  return TIER_ORDER.map((tier) => ({
    key: `tier-${tier}`,
    tier,
    heading: null,
    items: items.filter((a) => a.tier === tier).sort(bySortOrder),
  })).filter((section) => section.items.length > 0);
}

/**
 * Steam: base-game achievements first, then one section per DLC, in the order
 * the DLCs first appear. A DLC without a store name falls back to its appid so
 * the group is never unlabelled.
 */
function dlcSections(items: Achievement[], t: Translate): AchievementSection[] {
  const base = items.filter((a) => !a.dlcAppId).sort(bySortOrder);
  const groups = new Map<string, Achievement[]>();
  for (const item of [...items].sort(bySortOrder)) {
    if (!item.dlcAppId) continue;
    const group = groups.get(item.dlcAppId);
    if (group) group.push(item);
    else groups.set(item.dlcAppId, [item]);
  }

  const sections: AchievementSection[] = [];
  if (base.length > 0) {
    sections.push({ key: "base", tier: null, heading: t("detail.achievements.baseGame"), items: base });
  }
  for (const [appId, group] of groups) {
    const name = group.find((a) => a.dlcName)?.dlcName ?? appId;
    sections.push({
      key: `dlc-${appId}`,
      tier: null,
      heading: t("detail.achievements.dlcLabel", { name }),
      items: group,
    });
  }
  return sections;
}

/**
 * Header tallies. The API's `counts` are used when they agree with the rows on
 * screen; otherwise the rows are counted locally, so a chip can never claim a
 * number that the list below it does not show (an unpopulated `counts` during a
 * partial rollout is the case that matters here).
 */
function resolveCounts(response: AchievementsResponse | undefined, items: Achievement[]): AchievementCounts {
  const derived: AchievementCounts = { platinum: 0, gold: 0, silver: 0, bronze: 0, total: items.length };
  for (const item of items) if (item.tier) derived[item.tier] += 1;

  const backend = response?.counts;
  if (!backend) return derived;
  const total = backend.total > 0 ? backend.total : derived.total;
  const agrees = TIER_ORDER.every((tier) => backend[tier] === derived[tier]);
  return agrees ? { ...backend, total } : { ...derived, total };
}

function AchievementCard({ item }: { item: Achievement }) {
  const t = useT();
  const style = item.tier ? tierStyles[item.tier] : null;
  const TierIcon = style?.Icon;
  return (
    <div className="flex items-start gap-3 rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
      {item.iconUrl ? (
        <img src={item.iconUrl} alt="" className="h-11 w-11 shrink-0 rounded-md bg-zinc-800 object-cover" />
      ) : (
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-zinc-800 text-zinc-500">
          <Award className="h-5 w-5" />
        </span>
      )}
      <div className="min-w-0">
        <div className="line-clamp-1 text-sm font-medium text-zinc-100">{item.name}</div>
        {item.description && <div className="mt-0.5 line-clamp-2 text-xs text-zinc-400">{item.description}</div>}
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
          {style && TierIcon && (
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px] font-medium",
                style.badge,
                style.text,
              )}
            >
              <TierIcon className="h-3 w-3" />
              {t(style.labelKey)}
            </span>
          )}
          {item.globalPercent != null && (
            <span className="text-xs text-zinc-500">
              {t("detail.achievements.globalPercent", { percent: item.globalPercent })}
            </span>
          )}
          {item.rarity && (
            <span
              title={t("detail.achievements.rarityLabel")}
              className="rounded-full border border-zinc-700 bg-zinc-800/70 px-1.5 py-0.5 text-[11px] text-zinc-300"
            >
              {item.rarity}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function AchievementSectionBlock({
  section,
  counts,
}: {
  section: AchievementSection;
  counts: AchievementCounts;
}) {
  const t = useT();
  const style = section.tier ? tierStyles[section.tier] : null;
  const SectionIcon = style?.Icon ?? Package;
  const label = style ? t(style.labelKey) : section.heading;
  const count = section.tier ? counts[section.tier] : section.items.length;
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <SectionIcon className={cn("h-4 w-4", style ? style.text : "text-zinc-500")} />
        {label && <h3 className={cn("text-sm font-semibold", style ? style.text : "text-zinc-200")}>{label}</h3>}
        <span className="tabular-nums text-xs text-zinc-500">{count}</span>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {section.items.map((item) => (
          <AchievementCard key={item.id} item={item} />
        ))}
      </div>
    </section>
  );
}

/**
 * Achievements tab: Steam achievements and PlayStation trophies in one panel.
 *
 * Every terminal state the API can report is rendered explicitly — a scrape that
 * failed must never look like "no achievements". The refresh button re-scrapes
 * synchronously (up to ~30s), so it stays disabled and spinning while pending.
 */
function AchievementsPanel({
  gameId,
  gameName,
}: {
  gameId: string | undefined;
  gameName: string;
}) {
  const t = useT();
  const query = useAchievements(gameId);
  const refresh = useRefreshAchievements(gameId);
  const [pickOpen, setPickOpen] = useState(false);

  const data = query.data;
  const items = useMemo(() => data?.items ?? [], [data]);
  const counts = useMemo(() => resolveCounts(data, items), [data, items]);
  const hasTiers =
    items.some((a) => a.tier != null) ||
    counts.platinum + counts.gold + counts.silver + counts.bronze > 0;
  const hasDlc = items.some((a) => a.dlcAppId != null);

  const sections = useMemo(() => {
    // Tiers and DLC ids never coexist (trophies vs. Steam), but if they ever did,
    // the tier grouping wins — it is the stronger structural signal.
    if (hasTiers) return tierSections(items);
    if (hasDlc) return dlcSections(items, t);
    if (items.length === 0) return [];
    return [{ key: "all", tier: null, heading: null, items: [...items].sort(bySortOrder) }];
  }, [items, hasTiers, hasDlc, t]);

  const refreshButton = (
    <Button variant="outline" size="sm" onClick={() => refresh.mutate()} disabled={refresh.isPending || !gameId}>
      <RefreshCw className={cn("h-3.5 w-3.5", refresh.isPending && "animate-spin")} />
      {refresh.isPending ? t("detail.achievements.refreshing") : t("detail.achievements.refresh")}
    </Button>
  );

  // The manual picker is the real fix when auto-matching guessed the wrong
  // release, so it sits next to the refresh button in every state.
  const pickButton = (
    <Button variant="outline" size="sm" onClick={() => setPickOpen(true)} disabled={!gameId}>
      <Gamepad2 className="h-3.5 w-3.5" />
      {t("detail.achievements.pick.open")}
    </Button>
  );

  const actions = (
    <div className="flex flex-wrap items-center gap-2">
      {refreshButton}
      {pickButton}
    </div>
  );

  // A scrape failure comes back as HTTP 200 + status "failed", which the failed
  // branch below already reports — announcing success on top of it would lie.
  const mutationNotice = refresh.isError ? (
    <div className="rounded-lg border border-rose-900/50 bg-rose-950/30 px-3 py-2 text-xs text-rose-300">
      {t("detail.achievements.refreshFailed")}
    </div>
  ) : refresh.isSuccess && refresh.data?.status !== "failed" ? (
    <div className="rounded-lg border border-emerald-900/50 bg-emerald-950/30 px-3 py-2 text-xs text-emerald-300">
      {t("detail.achievements.refreshed")}
    </div>
  ) : null;

  if (query.isLoading) {
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-20" />
        ))}
      </div>
    );
  }

  let body: ReactNode;

  if (query.isError || !data) {
    // Transport/HTTP failure, or an empty body: fall back to the plain hint.
    body = (
      <div className="space-y-3">
        <EmptyHint text={t("detail.achievements.failed")} />
        <div className="text-xs leading-relaxed text-zinc-400">
          {t("detail.achievements.failedHint")}
        </div>
        {actions}
      </div>
    );
  } else if (data.status === "failed") {
    // Deliberately does NOT render `data.error`: that string names the upstream
    // site and carries technical detail meant for the logs. The user gets one
    // consistent message plus the way out (picking the game by hand).
    body = (
      <div className="flex items-start gap-3 rounded-lg border border-amber-900/60 bg-amber-950/30 p-4">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" />
        <div className="min-w-0 space-y-1">
          <div className="text-sm font-medium text-amber-200">{t("detail.achievements.failed")}</div>
          <div className="text-xs leading-relaxed text-amber-200/80">
            {t("detail.achievements.failedHint")}
          </div>
          <div className="pt-1">{actions}</div>
        </div>
      </div>
    );
  } else if (data.status === "unsupported") {
    body = (
      <div className="flex items-start gap-3 rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
        <Info className="mt-0.5 h-5 w-5 shrink-0 text-zinc-400" />
        <div className="min-w-0 space-y-2">
          <div className="text-sm leading-relaxed text-zinc-300">{t("detail.achievements.unsupported")}</div>
          {actions}
        </div>
      </div>
    );
  } else if (data.status === "pending") {
    body = (
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/60 p-4 text-sm text-zinc-400">
        <LoaderCircle className="h-4 w-4 animate-spin" />
        {t("detail.achievements.refreshing")}
      </div>
    );
  } else if (items.length === 0) {
    // Covers both `status: "empty"` and an `ok` response with no rows.
    body = (
      <div className="space-y-3">
        <EmptyHint text={t("detail.achievements.empty")} />
        {actions}
      </div>
    );
  } else {
    body = (
      <div className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-zinc-500">{t("detail.achievements.summary", { n: counts.total })}</span>
            {/* Trophy tallies; Steam data has no tiers and keeps the plain total. */}
            {hasTiers && (
              <>
                <span className="inline-flex items-center gap-1 rounded-full border border-zinc-700 bg-zinc-800/70 px-2 py-0.5 text-xs font-medium tabular-nums text-zinc-300">
                  {t("detail.achievements.totalLabel", { n: counts.total })}
                </span>
                {TIER_ORDER.map((tier) => {
                  const style = tierStyles[tier];
                  const TierIcon = style.Icon;
                  return (
                    <span
                      key={tier}
                      className={cn(
                        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium tabular-nums",
                        style.chip,
                        style.text,
                      )}
                    >
                      <TierIcon className="h-3.5 w-3.5" />
                      {t(style.labelKey)}
                      <span className="font-semibold">{counts[tier]}</span>
                    </span>
                  );
                })}
              </>
            )}
          </div>
          {actions}
        </div>

        {sections.map((section) => (
          <AchievementSectionBlock key={section.key} section={section} counts={counts} />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {mutationNotice}
      {body}
      {pickOpen && gameId && (
        <AchievementPickDialog
          gameId={gameId}
          gameName={gameName}
          onClose={() => setPickOpen(false)}
        />
      )}
    </div>
  );
}

function RatingsPanel({ ratings }: { ratings: Rating[] }) {
  const t = useT();
  if (ratings.length === 0) return <EmptyHint text={t("detail.ratings.empty")} />;
  return (
    <div className="space-y-4">
      {ratings.map((r, i) => (
        <div key={`${r.source}-${i}`} className="flex flex-wrap items-center gap-8 rounded-lg border border-zinc-800 bg-zinc-900/60 p-5">
          <div>
            <div className="text-xs uppercase tracking-wide text-zinc-500">{t("detail.ratings.metascore")}</div>
            <div className={cn("text-4xl font-black", scoreTextColor[metacriticTone(r.metascore)])}>{r.metascore ?? "—"}</div>
            {r.criticCount != null && <div className="text-xs text-zinc-500">{t("detail.ratings.criticCount", { count: r.criticCount })}</div>}
            {r.ratingClass && <div className="text-xs text-zinc-400">{r.ratingClass}</div>}
          </div>
          <div className="h-14 w-px bg-zinc-800" />
          <div>
            <div className="text-xs uppercase tracking-wide text-zinc-500">{t("detail.ratings.userScore")}</div>
            <div className="text-4xl font-black text-cyan-400">
              {r.userScore != null ? r.userScore : "—"}
              <span className="text-base font-normal text-zinc-500"> / 10</span>
            </div>
            {r.userCount != null && <div className="text-xs text-zinc-500">{t("detail.ratings.userCount", { count: r.userCount })}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="space-y-6">
      <div className="flex gap-5">
        <Skeleton className="aspect-video w-full sm:w-64" />
        <div className="flex-1 space-y-3">
          <Skeleton className="h-8 w-1/2" />
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      </div>
      <Skeleton className="aspect-video w-full" />
      <Skeleton className="h-10 w-full" />
    </div>
  );
}

export default function GameDetail() {
  const t = useT();
  const { id } = useParams();
  const navigate = useNavigate();
  const gameQuery = useGame(id);
  const mediaQuery = useGameMedia(id);
  const refresh = useRefreshGame(id ?? "");
  const [tab, setTab] = useState<DetailTab>("media");
  const [matchOpen, setMatchOpen] = useState(false);
  const [ratingOpen, setRatingOpen] = useState(false);
  const [posterOpen, setPosterOpen] = useState(false);
  const [platformOpen, setPlatformOpen] = useState(false);

  const game = gameQuery.data;

  /**
   * Always start at the top.
   *
   * Client-side navigation keeps the previous page's scroll offset, so opening a
   * card from halfway down the gallery landed halfway down the detail page.
   * Keyed on `id` so switching games via the prev/next buttons also resets.
   */
  useEffect(() => {
    // 直接跳到顶部而不是平滑滚动：切换游戏时用户要的是立刻看到标题，不是看滚动动画。
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [id]);

  // Previous/next follow the gallery's own filters and sort mode.
  const galleryQuery = useGalleryQuery();
  const neighborsQuery = useGameNeighbors(id, {
    search: galleryQuery.search,
    platform: galleryQuery.platform,
    minScore: galleryQuery.minScore ? Number(galleryQuery.minScore) : undefined,
    sort: galleryQuery.sort,
    order: galleryQuery.order,
  });
  const neighbors = neighborsQuery.data;

  /** Switch games while keeping the detail page's own state from leaking over. */
  const goTo = (target: { id: string; name: string } | null) => {
    if (!target) return;
    // Tab choice is per-game, and a lingering dialog would follow the user across.
    setTab("media");
    setMatchOpen(false);
    setRatingOpen(false);
    setPosterOpen(false);
    setPlatformOpen(false);
    navigate(`/game/${target.id}`);
  };

  const tabs = tabItems.map((item) => ({ value: item.value, label: t(item.labelKey) }));

  /**
   * 大图区轮播的图片集合。
   *
   * 顺序：当前封面 → 用户配置参加轮播的海报（后端 `in_slideshow`）。
   * 与 `detailPosters()` 同源（都基于后端的 `posterList`），区别只在排序：
   * 封面必须第一张。
   *
   * 「官方刮取到的海报/截图全部进轮播」是**后端**的职责（登记时就默认
   * `in_slideshow = 1`）。前端这里必须老老实实尊重用户配置，否则「编辑海报」里
   * 取消勾选就不生效了 —— 见下方注释里的实测数据。
   */
  const heroPosters = useMemo(() => {
    if (!game) return [];
    const list = game.posterList ?? [];
    const selected = list.filter((p) => p.isSelected).map((p) => p.url);
    const curated = list.filter((p) => p.inSlideshow).map((p) => p.url);

    // 大图区 = 用户配置的轮播集合（后端 `in_slideshow`），封面永远第一张。
    //
    // 曾经这里刻意**不做 in_slideshow 过滤**，把 `posterList` 里所有条目都塞进来，
    // 为的是让「刮取到 7 张官方海报却只显示 1 张」的游戏能翻页。那是治错了地方：
    // 真正的原因在后端（多 provider 刮削时把刚登记的官方截图删掉了），修好之后
    // 再无条件追加所有条目就变成了另一个 bug —— 「编辑海报」里被用户取消勾选的
    // 那张仍然会出现在大图区（实测页面 12 张 vs 配置 11 张），等于取消按钮无效。
    //
    // 现在：官方刮取的图文默认全部进轮播（后端负责），前端只认用户配置。
    // 只有在一张官方/相册海报都没有时，才回退到 `screenshots`，保证大图区不空白。
    const curatedSet = [...new Set([...selected, ...curated])];
    const fallback = [
      ...(game.posterUrl ? [game.posterUrl] : []),
      ...(game.screenshots ?? []),
    ];
    const source = curatedSet.length > 0 ? curatedSet : fallback;
    return [...new Set(source)].filter((u): u is string => typeof u === "string" && u.length > 0);
  }, [game]);

  if (gameQuery.isLoading) {
    return <DetailSkeleton />;
  }

  if (gameQuery.isError || !game) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl border border-rose-900/50 bg-rose-950/30 p-16 text-center">
        <p className="text-sm text-rose-300">{t("detail.loadFailed")}</p>
        <Button variant="outline" onClick={() => gameQuery.refetch()}>
          {t("action.retry")}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Link to="/" className="inline-flex items-center gap-1.5 text-sm text-zinc-400 transition-colors hover:text-white">
        <ArrowLeft className="h-4 w-4" /> {t("detail.backToGallery")}
      </Link>

      <Card>
        <CardContent className="flex flex-col gap-5 p-5 sm:flex-row">
          <div className="w-full shrink-0 sm:w-64">
            <div className="group relative">
              {/* Feature 5: honours the same static/slideshow mode as the card. */}
              <div className="aspect-video overflow-hidden rounded-lg bg-zinc-900">
                <PosterCarousel
                  images={detailPosters(game)}
                  mode={game.posterMode ?? "static"}
                  name={game.name}
                />
              </div>
              {/* Feature 4: custom poster entry point on the poster area. */}
              <button
                onClick={() => setPosterOpen(true)}
                className="absolute inset-x-1 bottom-1 flex items-center justify-center gap-1.5 rounded-md bg-black/75 py-1.5 text-xs font-medium text-white opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100 focus:opacity-100"
              >
                <ImagePlus className="h-3.5 w-3.5" />
                {t("detail.editPoster")}
              </button>
            </div>
          </div>
          <div className="min-w-0 flex-1 space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                {/* 上一个 / 下一个：顺序与图库当前筛选+排序完全一致（后端按同样的
                    条件算出邻居，且首尾循环）。挂在标题正上方，保证任何屏宽下都在
                    首屏可见——它曾经被挤在卡片右上角的一堆按钮里，等于「看不见」。 */}
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    data-testid="nav-prev"
                    onClick={() => goTo(neighbors?.prev ?? null)}
                    disabled={!neighbors?.prev}
                    title={neighbors?.prev ? t("detail.nav.prevTitle", { name: neighbors.prev.name }) : undefined}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800/80 px-3 py-1.5 text-sm font-medium text-zinc-200 shadow-sm transition-colors hover:border-violet-500 hover:bg-violet-600/20 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <ChevronLeft className="h-4 w-4" />
                    {t("detail.nav.prev")}
                  </button>
                  <button
                    type="button"
                    data-testid="nav-next"
                    onClick={() => goTo(neighbors?.next ?? null)}
                    disabled={!neighbors?.next}
                    title={neighbors?.next ? t("detail.nav.nextTitle", { name: neighbors.next.name }) : undefined}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800/80 px-3 py-1.5 text-sm font-medium text-zinc-200 shadow-sm transition-colors hover:border-violet-500 hover:bg-violet-600/20 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {t("detail.nav.next")}
                    <ChevronRight className="h-4 w-4" />
                  </button>
                  {neighbors && neighbors.index >= 0 && neighbors.total > 0 && (
                    <span data-testid="nav-position" className="text-xs text-zinc-500">
                      {t("detail.nav.position", { index: neighbors.index + 1, total: neighbors.total })}
                    </span>
                  )}
                  {neighborsQuery.isLoading && (
                    <span className="text-xs text-zinc-600">{t("detail.nav.loading")}</span>
                  )}
                </div>
                <h1 className="text-2xl font-bold text-white">{game.name}</h1>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {/* Feature 6: every user-set platform tag. */}
                  {detailPlatforms(game).map((p) => (
                    <Badge key={p} variant="secondary" title={game.customPlatform ? t("detail.platform.manual") : t("detail.platform.auto")}>
                      {p}
                    </Badge>
                  ))}
                  <MetacriticBadge score={game.metacriticScore} criticCount={game.metacriticCriticCount} />
                  {/* 评分来源与手动选择入口：与「手动匹配」同样的交互风格 */}
                  <button
                    type="button"
                    onClick={() => setRatingOpen(true)}
                    title={t("detail.rating.pick.intro")}
                    className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
                      game.metacriticManual
                        ? "border-violet-600 bg-violet-600/10 text-violet-300"
                        : "border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"
                    }`}
                  >
                    <Star className="h-3 w-3" />
                    {game.metacriticManual
                      ? t("detail.rating.pick.manualBadge")
                      : t("detail.rating.pick.open")}
                    {game.metacriticManual && game.metacriticPlatform
                      ? ` · ${game.metacriticPlatform}`
                      : ""}
                  </button>
                  <Badge variant="secondary">
                    <Clock className="h-3 w-3" /> {game.durationText}
                  </Badge>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" onClick={() => setPlatformOpen(true)}>
                  <Gamepad2 className="h-4 w-4" /> {t("detail.platformSettings")}
                </Button>
                <Button variant="outline" onClick={() => setMatchOpen(true)}>
                  <Search className="h-4 w-4" /> {t("detail.matchManually")}
                </Button>
                <Button onClick={() => id && refresh.mutate()} disabled={refresh.isPending}>
                  <RefreshCw className={refresh.isPending ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
                  {refresh.isPending ? t("detail.refreshing") : t("detail.refreshMetadata")}
                </Button>
              </div>
            </div>

            {refresh.isError && (
              <div className="rounded-lg border border-rose-900/50 bg-rose-950/30 px-4 py-2 text-sm text-rose-300">{t("detail.refreshFailed")}</div>
            )}

            {game.summary && <p className="text-sm leading-relaxed text-zinc-300">{game.summary}</p>}

            <div className="grid grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-2">
              <InfoItem icon={<Building2 className="h-4 w-4" />} label={t("detail.developer")}>
                {game.developers.length > 0 ? game.developers.join(t("detail.listSeparator")) : t("state.unknown")}
              </InfoItem>
              <InfoItem icon={<Users className="h-4 w-4" />} label={t("detail.publisher")}>
                {game.publishers.length > 0 ? game.publishers.join(t("detail.listSeparator")) : t("state.unknown")}
              </InfoItem>
              <InfoItem icon={<Calendar className="h-4 w-4" />} label={t("detail.releaseDate")}>
                {formatDate(game.releaseDate, t)}
              </InfoItem>
              <InfoItem icon={<Timer className="h-4 w-4" />} label={t("detail.playtime")}>
                {formatHltb(game, t)}
              </InfoItem>
              <InfoItem icon={<Tag className="h-4 w-4" />} label={t("detail.price")}>
                {game.prices.length > 0
                  ? game.prices.map((p) => formatPrice(p, t)).join(t("detail.priceSeparator"))
                  : t("state.unknown")}
              </InfoItem>
            </div>
          </div>
        </CardContent>
      </Card>

      <HeroPosterCarousel images={heroPosters} alt={game.name} />

      <Card>
        <CardHeader>
          <Tabs tabs={tabs} value={tab} onValueChange={setTab} />
        </CardHeader>
        <CardContent className="py-4">
          {tab === "media" && (
            mediaQuery.isLoading ? (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {Array.from({ length: 8 }).map((_, i) => (
                  <Skeleton key={i} className="aspect-video" />
                ))}
              </div>
            ) : mediaQuery.isError ? (
              <EmptyHint text={t("detail.mediaFailed")} />
            ) : (
              <MediaGrid media={mediaQuery.data ?? []} />
            )
          )}

          {tab === "timeline" && <Timeline events={game.timeline} />}

          {tab === "achievements" && <AchievementsPanel gameId={id} gameName={game.name} />}

{tab === "ratings" && (
            <div className="space-y-6">
              <RatingsPanel ratings={game.ratings} />
              {/* 需求：媒体评价标签页展示 媒体名称 / 媒体打分 / 媒体评价原文 */}
              <MediaReviewsPanel
                gameId={game.id}
                fallbackReviews={game.mediaReviews}
                fallbackSummary={game.mediaReviewsSummary}
              />
            </div>
          )}
        </CardContent>
      </Card>

      {posterOpen && (
        <PosterDialog game={game} onClose={() => setPosterOpen(false)} />
      )}

      {platformOpen && (
        <PlatformDialog game={game} onClose={() => setPlatformOpen(false)} />
      )}

      {ratingOpen && (
        <RatingPickDialog
          gameId={game.id}
          gameName={game.name}
          onClose={() => setRatingOpen(false)}
        />
      )}
      {matchOpen && id && (
        <MatchDialog
          gameId={id}
          gameName={game.name}
          folderPath={game.folderPath}
          onClose={() => setMatchOpen(false)}
        />
      )}
    </div>
  );
}