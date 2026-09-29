/**
 * Formatting helpers.
 *
 * The language-neutral ones (`formatClock`, `formatBytes`) are plain functions.
 * Anything that produces words takes a `t` translator so the caller decides the
 * language — these helpers are used from several components and cannot reach the
 * i18n context themselves.
 */
import type { Translate } from "../i18n";

/** Seconds -> clock-style video length e.g. `0:58` / `2:00` / `2:00:00`. */
export function formatClock(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return "0:00";
  const seconds = Math.floor(totalSeconds);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
}

/** Seconds -> localized text e.g. `3天12小时` / `3d 12h`. */
export function formatDuration(totalSeconds: number, t: Translate): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return t("format.duration.zero");
  const seconds = Math.floor(totalSeconds);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (days > 0) {
    return hours > 0
      ? t("format.duration.daysHours", { days, hours })
      : t("format.duration.days", { days });
  }
  if (hours > 0) return t("format.duration.hours", { hours });
  if (minutes > 0) return t("format.duration.minutes", { minutes });
  return t("format.duration.lessThanMinute");
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** i;
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** ISO date -> localized calendar date. */
export function formatDate(iso: string | null | undefined, t: Translate): string {
  if (!iso) return t("state.unknown");
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return t("format.date", {
    year: d.getFullYear(),
    month: d.getMonth() + 1,
    day: d.getDate(),
  });
}