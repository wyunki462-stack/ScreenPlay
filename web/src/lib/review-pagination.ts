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