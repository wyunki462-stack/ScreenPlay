/**
 * The gallery's current query, shared with the detail page.
 *
 * The detail page's 「上一个 / 下一个」 buttons have to follow the order the user
 * is actually looking at — including the search box, the platform filter and the
 * sort mode they picked — but those live in `Home`'s local state and would be
 * lost on navigation. Mirroring them here keeps the two pages agreed.
 *
 * Stored in `sessionStorage` rather than memory so a page refresh (F5 on a detail
 * page) keeps the same neighbourhood, and per-tab rather than globally so two
 * tabs can browse different filters.
 */
import { useEffect, useState } from "react";
import type { GameSortField, SortOrder } from "../api/hooks";

export interface GalleryQuery {
  search: string;
  platform: string;
  sort: GameSortField;
  order: SortOrder;
  minScore: string;
}

/** Matches the gallery's own defaults, so an unvisited gallery behaves normally. */
export const DEFAULT_GALLERY_QUERY: GalleryQuery = {
  search: "",
  platform: "",
  sort: "name",
  order: "asc",
  minScore: "",
};

const KEY = "screenplay.galleryQuery";

let current: GalleryQuery = read();
const listeners = new Set<(q: GalleryQuery) => void>();

function read(): GalleryQuery {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return DEFAULT_GALLERY_QUERY;
    const parsed = JSON.parse(raw) as Partial<GalleryQuery>;
    // Merge over the defaults so a stale payload from an older build (or a
    // hand-edited one) can never leave a field undefined.
    return { ...DEFAULT_GALLERY_QUERY, ...parsed };
  } catch {
    return DEFAULT_GALLERY_QUERY;
  }
}

/** The query the gallery last displayed. Safe to call during render. */
export function getGalleryQuery(): GalleryQuery {
  return current;
}

export function setGalleryQuery(next: GalleryQuery): void {
  // Ignore no-op writes: the gallery recomputes this on every keystroke.
  if (JSON.stringify(next) === JSON.stringify(current)) return;
  current = next;
  try {
    sessionStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Private mode / quota — the in-memory copy still works for this session.
  }
  for (const l of listeners) l(next);
}

/** Subscribe to gallery-query changes. */
export function useGalleryQuery(): GalleryQuery {
  const [value, setValue] = useState<GalleryQuery>(current);
  useEffect(() => {
    listeners.add(setValue);
    // Re-read on mount: another component may have changed it before we mounted.
    setValue(current);
    return () => {
      listeners.delete(setValue);
    };
  }, []);
  return value;
}

/** Strip the fields that do not affect which games are in the list. */
export function filterKey(q: GalleryQuery): string {
  return `${q.search}|${q.platform}|${q.minScore}|${q.sort}|${q.order}`;
}