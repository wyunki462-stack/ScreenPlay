/**
 * 「媒体评价」分页的纯计算部分。
 *
 * 单独一个文件是为了能直接测：这段逻辑的边界（0/1/5/6/10/11/200 条、翻页后条数
 * 变化导致页码越界）用肉眼看不出来，而它一旦错了，界面要么空白要么偷偷少显示
 * 数据 —— 都是很难从截图里发现的错误。
 */

/** 每页最多显示多少条。 */
export const PAGE_SIZE = 10;

/** 第一页默认先露出多少条（点「展开」补齐到一整页）。 */
export const FIRST_PAGE_COLLAPSED = 5;

export interface ReviewPagination {
  /** 夹回合法范围后的页码（1 起）。 */
  page: number;
  /** 总页数，至少为 1，便于直接渲染「第 x / y 页」。 */
  pageCount: number;
  /** 本页应当渲染的条目切片。 */
  visibleCount: number;
  /** 当前页是否还能「展开」（只有第一页且未展开、且确实有更多条目时为真）。 */
  canExpand: boolean;
  /** 本页已经显示了多少条。 */
  shown: number;
}

/**
 * 计算某页该显示什么。
 *
 * 两个容易出错的点，都在这里处理掉：
 *
 *   1. **页码越界**。重新抓取会让条数变化（1 条 → 66 条，也可能反过来）。若用户
 *      停在「第 7 页」时条数缩到 15 条，页码就落到范围外，页面会空白。所以返回
 *      的 `page` 是夹过的值，调用方必须用它去渲染、而不是用自己那份 state。
 *   2. **「展开」只属于第一页**。第 2 页起本身就是整页 10 条，没有可展开的余地；
 *      而「一页最多 10 条」这条要求也意味着展开不能越界去拿第 11 条。
 */
export function paginateReviews(
  total: number,
  page: number,
  expanded: boolean,
  pageSize = PAGE_SIZE,
  collapsed = FIRST_PAGE_COLLAPSED,
): ReviewPagination {
  const safeTotal = Math.max(0, Math.floor(total));
  const pageCount = Math.max(1, Math.ceil(safeTotal / pageSize));
  const safePage = Math.min(Math.max(1, Math.floor(page) || 1), pageCount);

  const onFirstPage = safePage === 1;
  // 只有第一页需要「5 → 10」这一步；其余页本身就是整页。
  const visibleCount = onFirstPage && !expanded ? Math.min(collapsed, pageSize) : pageSize;
  const shown = Math.min(visibleCount, Math.max(0, safeTotal - (safePage - 1) * pageSize));
  const canExpand = onFirstPage && !expanded && safeTotal > visibleCount;

  return { page: safePage, pageCount, visibleCount, canExpand, shown };
}

/** 取出某一页要渲染的切片，与 `paginateReviews` 的页码夹取保持一致。 */
export function slicePage<T>(items: T[], page: number, pageSize = PAGE_SIZE): T[] {
  const start = (Math.max(1, page) - 1) * pageSize;
  return items.slice(start, start + pageSize);
}

// ─────────────────────────────────────────────────────────────────────────────
// 平台筛选（媒体评价按平台查看）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 「全部平台」这个选项的内部值。
 *
 * 用一个不可能与真实平台名相同的前缀，而不是空串 —— 空串会让「未指定平台」与
 * 「全选」在比较时难以区分，而两者必须分开：前者是**没选**筛选器，后者是**选了**
 * 一个会匹配到 `platform === null` 那些评价的取值。
 */
export const ALL_PLATFORMS = '__all__';

export interface PlatformOption {
  /** 平台名，或 `ALL_PLATFORMS`。 */
  value: string;
  /** 该平台下的评价条数（「全部」是总数）。 */
  count: number;
}

/**
 * 从评价列表里归纳出可选的平台，附带每个平台的条数。
 *
 * 只列**评价里真实出现过**的平台，而不是游戏自身的平台列表：M 站对同一款游戏在
 * 不同平台下收录的媒体不同，游戏支持 PS5/PC 不代表它在这两个平台下都有媒体评价。
 * 若按游戏平台列，用户切过去只会得到空列表，会以为功能坏了。
 *
 * `platform` 为空的评价不单独列一项：它们多是站点没标平台的评价，单独列一个
 * 「未知平台」既难理解，也会让「全部」与它的关系变得含糊。它们始终留在「全部」里。
 *
 * 排序：条数多的在前（通常也是用户最关心的平台），同数量按名称，保证渲染顺序稳定
 * —— 否则 React 列表在不同请求间会抖动。
 */
export function platformOptions(
  reviews: { platform: string | null }[],
): PlatformOption[] {
  const counts = new Map<string, number>();
  for (const r of reviews) {
    const p = (r.platform ?? '').trim();
    if (!p) continue;
    counts.set(p, (counts.get(p) ?? 0) + 1);
  }

  const opts: PlatformOption[] = [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));

  return [{ value: ALL_PLATFORMS, count: reviews.length }, ...opts];
}

/**
 * 按平台筛出评价。`ALL_PLATFORMS`（或空值）返回原列表。
 *
 * 平台名比较时忽略大小写与首尾空白：抓取侧会把 `"PlayStation 5"` 归一成 `"PS5"`，
 * 但历史数据里可能存着归一化之前的值，大小写不一致时不该筛出空结果。
 */
export function filterByPlatform<T extends { platform: string | null }>(
  reviews: T[],
  platform: string | null | undefined,
): T[] {
  if (!platform || platform === ALL_PLATFORMS) return reviews;
  const want = platform.trim().toLowerCase();
  return reviews.filter((r) => (r.platform ?? '').trim().toLowerCase() === want);
}