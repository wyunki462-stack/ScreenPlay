/** Game detail page: header metadata, tabs, timeline, achievements, ratings. */
export const detailEn: Record<string, string> = {
  "detail.backToGallery": "Back to gallery",
  "detail.loadFailed": "Failed to load game details",
  "detail.mediaFailed": "Failed to load media",
  // Progressive render: the basics are on screen, detail-only fields still loading.
  "detail.metaPending": "Completing metadata…",
  "detail.editPoster": "Edit poster",
  "detail.platformSettings": "Platform settings",
  "detail.matchManually": "Match manually",
  "detail.refreshMetadata": "Refresh metadata",
  "detail.refreshing": "Refreshing…",
  "detail.refreshFailed": "Refresh failed. Please try again later.",

  "detail.platform.manual": "Manually set platform",
  "detail.platform.auto": "Auto-detected platform",

  "detail.tab.media": "Media",
  "detail.tab.timeline": "Timeline",
  "detail.tab.achievements": "Achievements",
  "detail.tab.ratings": "Media Reviews",

  "detail.developer": "Developer",
  "detail.publisher": "Publisher",
  "detail.releaseDate": "Release date",
  "detail.playtime": "Average playtime",
  "detail.price": "Price",

  /** Joins a list of names / prices. */
  "detail.listSeparator": ", ",
  "detail.priceSeparator": "; ",

  "detail.playtime.mainStory": "Main story {hours}h",
  "detail.playtime.mainPlusExtra": "Main + extras {hours}h",
  "detail.playtime.completionist": "Completionist {hours}h",

  "detail.price.was": "Was {price}",
  "detail.price.low": "Lowest {price}",

  "detail.timeline.firstMedia": "First media",
  "detail.timeline.lastMedia": "Latest media",
  "detail.timeline.milestone": "Milestone",
  "detail.timeline.note": "Note",
  "detail.timeline.empty": "No timeline entries yet",

  "detail.achievements.empty":
    "No achievements to show yet. Try picking the game manually, or retry later.",
  "detail.achievements.summary":
    "All achievements / trophies · {n} total (including locked, not your personal unlocks)",
  "detail.achievements.globalPercent": "Unlocked by {percent}% of players",
  "detail.achievements.failed": "Failed to load achievements",
  // Unified failure copy: never name the underlying site.
  "detail.achievements.failedHint":
    "Achievement data is temporarily unavailable for this game. Try picking the game manually, or retry later.",

  "detail.achievements.tierPlatinum": "Platinum",
  "detail.achievements.tierGold": "Gold",
  "detail.achievements.tierSilver": "Silver",
  "detail.achievements.tierBronze": "Bronze",
  "detail.achievements.totalLabel": "{n} in total",
  "detail.achievements.rarityLabel": "Rarity",
  "detail.achievements.baseGame": "Base game",
  "detail.achievements.dlcLabel": "DLC · {name}",
  "detail.achievements.refresh": "Re-scrape achievements / trophies",
  "detail.achievements.refreshing": "Scraping… (up to ~30 seconds)",
  "detail.achievements.refreshFailed": "Re-scrape failed. Please try again later.",
  "detail.achievements.refreshed": "Scrape finished — data updated",

  "detail.achievements.pick.open": "Pick game manually",
  "detail.achievements.pick.title": "Choose the achievement target for “{name}”",
  "detail.achievements.pick.intro":
    "Automatic matching guesses from the folder name, which gets abbreviations, multiple releases and duplicate titles wrong. Pick the entry here and every later scrape reuses it.",
  "detail.achievements.pick.placeholder": "Search by game name",
  "detail.achievements.pick.searching": "Searching…",
  "detail.achievements.pick.noResults": "No matching game entries. Try another keyword.",
  "detail.achievements.pick.emptyQuery": "Type a keyword to start searching",
  "detail.achievements.pick.current": "Currently picked: {name}",
  "detail.achievements.pick.confirm": "Confirm and re-scrape",
  "detail.achievements.pick.applying": "Scraping… (up to ~30 seconds)",
  "detail.achievements.pick.done": "Applied — achievement data updated",
  "detail.achievements.pick.failedMsg": "Could not apply. Please try again later.",
  "detail.achievements.pick.clear": "Back to automatic matching",
  "detail.achievements.pick.cleared": "Restored automatic matching",
  "detail.achievements.unsupported":
    "No achievement source is matched for this game yet. Try picking the game manually.",

  "detail.ratings.empty": "No rating data yet",
  "detail.ratings.metascore": "Metascore",
  "detail.ratings.criticCount": "{count} critic reviews",

  // 「媒体评价」 tab (outlet name / outlet score / review text)
  "detail.reviews.title": "Media Reviews",
  "detail.reviews.empty": "No media reviews",
  "detail.reviews.neverFetched": "Media reviews have not been fetched yet. Use \u201cFill in media reviews\u201d to get them.",
  "detail.reviews.noneFound": "The review source has no critic reviews for this game.",
  "detail.reviews.failed": "Fetching media reviews failed: {reason}",
  "detail.reviews.failedHint": "Usual causes: the source site is unreachable (a proxy may be required) or is rate-limiting. Retrying later is safe \u2014 already-fetched reviews are never cleared.",
  "detail.reviews.unsupported": "No matching entry for this game was found on the review site.",
  "detail.reviews.refresh": "Re-fetch media reviews",
  "detail.reviews.refreshing": "Fetching\u2026",
  "detail.reviews.refreshed": "Updated: {count} media reviews",
  "detail.reviews.refreshFailed": "Fetch failed: {reason}",
  "detail.reviews.count": "{count} media reviews",
  "detail.reviews.outlet": "Outlet",
  "detail.reviews.score": "Score",
  "detail.reviews.noScore": "No score",
  "detail.reviews.readOriginal": "Read original",
  "detail.reviews.source": "Source",
  "detail.reviews.fetchedAt": "Fetched {time}",
  "detail.reviews.platform": "Platform",
  "detail.reviews.author": "Critic",
  // Pagination: 5 shown by default, expanding fills the page up to 10.
  "detail.reviews.expand": "Show {n} reviews",
  "detail.reviews.shown": "Showing {shown} of {total}",
  "detail.reviews.pageOf": "Page {page} / {total}",
  "detail.reviews.prevPage": "Previous",
  // Platform filter: only platforms that actually appear in the reviews.
  "detail.reviews.filterPlatform": "Filter by platform",
  "detail.reviews.allPlatforms": "All platforms",
  "detail.reviews.platformCount": "{platform} ({count})",
  "detail.reviews.platformEmpty": "No critic reviews for this platform",
  "detail.reviews.platformEmptyHint": "Pick another platform, or choose All platforms to see everything.",
  // Outlet-name search + sorting (both applied client-side, on the already-fetched list)
  "detail.reviews.searchPlaceholder": "Search outlet",
  "detail.reviews.searchActive": "“{query}”: {count} matches",
  "detail.reviews.searchEmpty": "No outlet name contains “{query}”",
  "detail.reviews.searchEmptyHint": "Try another keyword, or clear the box to see all reviews.",
  "detail.reviews.sort": "Sort",
  "detail.reviews.sortDefault": "Default (site order)",
  "detail.reviews.sortScoreDesc": "Score: high to low",
  "detail.reviews.sortScoreAsc": "Score: low to high",
  "detail.reviews.sortNewest": "Date: newest first",
  "detail.reviews.sortOldest": "Date: oldest first",
  "detail.reviews.goToPage": "Go to page {page}",
  "detail.reviews.nextPage": "Next",

  "detail.metacritic.withCritics": "Metacritic {score} · based on {criticCount} critic reviews",
  "detail.metacritic.score": "Metacritic {score}",
  "detail.metacritic.empty": "No Metacritic score yet",

  // Manual Metascore selection (per-platform rating entry)
  "detail.rating.pick.open": "Pick score manually",
  "detail.rating.pick.title": "Choose a Metascore for \u201c{name}\u201d",
  "detail.rating.pick.intro":
    "The same game has separate Metacritic entries and scores per platform. Pick the entry that matches the platform you actually played on \u2014 cards and the detail page follow your choice, and later scrapes will not reset it.",
  "detail.rating.pick.placeholder": "Search by game name",
  "detail.rating.pick.searching": "Searching\u2026",
  "detail.rating.pick.noResults": "No scored entries found \u2014 try another keyword",
  "detail.rating.pick.current": "Picked manually: {platform} \u00b7 {score}",
  "detail.rating.pick.currentAuto": "Currently auto-matched: {score}",
  "detail.rating.pick.noScore": "No Metascore available right now",
  "detail.rating.pick.inUse": "in use",
  "detail.rating.pick.metascore": "Metascore",
  "detail.rating.pick.unknownPlatform": "unknown platform",
  "detail.rating.pick.confirm": "Use this score",
  "detail.rating.pick.applying": "Saving\u2026",
  "detail.rating.pick.done": "Using the {platform} score of {score}; cards and detail page are updated",
  "detail.rating.pick.failedMsg": "Could not save, please retry",
  "detail.rating.pick.clear": "Back to automatic",
  "detail.rating.pick.cleared": "Back to automatic matching; the score now follows scraping",
  "detail.rating.pick.manualBadge": "Manual",

  // Previous / next game
  "detail.nav.prev": "Previous",
  "detail.nav.next": "Next",
  "detail.nav.prevTitle": "Previous game: {name}",
  "detail.nav.nextTitle": "Next game: {name}",
  "detail.nav.position": "{index} of {total} (current order)",
  "detail.nav.loading": "Loading neighbour…",

  // Detail poster carousel (hero area, always auto-rotating)
  "detail.poster.prev": "Previous poster",
  "detail.poster.next": "Next poster",
  "detail.poster.goto": "Show poster {index}",
  "detail.poster.official": "Official posters · auto-rotating",
  "detail.poster.alt": "Official poster",
  "detail.poster.empty": "No poster yet — use “Edit poster” to add one",
};