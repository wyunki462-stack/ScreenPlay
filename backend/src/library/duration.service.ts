/**
 * Play-time / completion-duration calculation.
 *
 * The "玩家实际通关时长" (real-world completion time) is derived purely from
 * on-disk timestamps: the earliest file creation time marks when the playthrough
 * began and the latest marks when it ended. The difference is the real time the
 * player spent on the game.
 *
 * The main-playthrough vs completionist split is manual: hardlink/move files
 * into sub-folders named like `主线` / `全收集` / `100%`.
 */

export type PlaySection = 'main' | 'completionist' | 'all';

export interface FileMoment {
  /** Absolute path (used to detect the section sub-folder). */
  path: string;
  /** File creation time (ms epoch). */
  createdAtMs: number;
  /** File modification time (ms epoch), fallback for moments without ctime. */
  modifiedAtMs: number;
}

export interface DurationResult {
  overallSeconds: number;
  overall: { firstMs: number | null; lastMs: number | null };
  mainSeconds: number;
  main: { firstMs: number | null; lastMs: number | null };
  completionistSeconds: number;
  completionist: { firstMs: number | null; lastMs: number | null };
}

const MAIN_MARKERS = ['主线', 'main', 'story', '主线流程'];
const COMPLETIONIST_MARKERS = ['全收集', '100%', '100', 'full', 'completionist', 'platinum', '全成就'];

/** Detect which manual section (main / completionist) a file belongs to. */
export function sectionOf(relativePath: string): PlaySection {
  const lower = relativePath.toLowerCase();
  const has = (markers: string[]) =>
    markers.some((m) => lower.includes(`${m}/`) || lower.includes(`/${m}`));
  if (has(COMPLETIONIST_MARKERS)) return 'completionist';
  if (has(MAIN_MARKERS)) return 'main';
  // Unmarked files belong to the main playthrough.
  return 'main';
}

/** Compute the overall + per-section durations from a set of file moments. */
export function computeDurations(
  gameRoot: string,
  moments: FileMoment[],
): DurationResult {
  const split = (predicate: (m: FileMoment) => boolean) => {
    const times = moments.filter(predicate).map((m) => m.createdAtMs);
    const first = times.length ? Math.min(...times) : null;
    const last = times.length ? Math.max(...times) : null;
    return { firstMs: first, lastMs: last };
  };

  const main = split((m) => sectionOf(rel(gameRoot, m.path)) === 'main');
  const completionist = split(
    (m) => sectionOf(rel(gameRoot, m.path)) === 'completionist',
  );

  const allFirst = moments.length
    ? Math.min(...moments.map((m) => m.createdAtMs))
    : null;
  const allLast = moments.length
    ? Math.max(...moments.map((m) => m.createdAtMs))
    : null;

  return {
    overallSeconds: span(allFirst, allLast),
    overall: { firstMs: allFirst, lastMs: allLast },
    mainSeconds: span(main.firstMs, main.lastMs),
    main,
    completionistSeconds: span(completionist.firstMs, completionist.lastMs),
    completionist,
  };
}

/** Format a duration in seconds as a compact, human-friendly Chinese string. */
export function formatDurationText(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const total = Math.floor(seconds);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);

  if (days > 0) {
    return hours > 0 ? `${days}天 ${hours}小时` : `${days}天`;
  }
  if (hours > 0) {
    return minutes > 0 ? `${hours}小时 ${minutes}分钟` : `${hours}小时`;
  }
  if (minutes > 0) return `${minutes}分钟`;
  return `${total}秒`;
}

/** Span seconds between two ms timestamps (never negative). */
function span(firstMs: number | null, lastMs: number | null): number {
  if (firstMs == null || lastMs == null) return 0;
  return Math.max(0, Math.floor((lastMs - firstMs) / 1000));
}

/** Root-relative, POSIX-normalised path (for section marker detection). */
function rel(root: string, filePath: string): string {
  return filePath
    .replace(root, '')
    .replace(/\\/g, '/')
    .replace(/^\//, '')
    .toLowerCase();
}

/**
 * Extract a capture timestamp embedded in a file name.
 *
 * Media tools (Steam, NVIDIA ShadowPlay, Xbox Game Bar, etc.) commonly stamp
 * screenshots/clips with the wall-clock time they were taken, e.g.
 * `God of War_20260216202256.jpg` or `2026.02.16 - 20.22.56.png`. This is a far
 * better "created at" signal than the filesystem mtime/ctime (which reflect when
 * the file was copied onto the NAS, not when it was captured).
 */
export function parseTimestampFromFileName(fileName: string): number | null {
  // 14 contiguous digits: YYYYMMDDHHMMSS (date/time optionally separated).
  let m = /(?<!\d)(\d{4})(\d{2})(\d{2})[\s_.-]?(\d{2})(\d{2})(\d{2})(?!\d)/.exec(fileName);
  if (!m) {
    // Separated form: 2026-02-16 20-22-56 / 2026.02.16 - 20.22.56
    m = /(\d{4})[-.](\d{2})[-.](\d{2})\s*[-.]\s*(\d{2})[-.](\d{2})[-.](\d{2})/.exec(fileName);
  }
  if (!m) return null;

  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);

  if (year < 1990 || year > 2100) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;

  const time = new Date(year, month - 1, day, hour, minute, second).getTime();
  return Number.isNaN(time) ? null : time;
}