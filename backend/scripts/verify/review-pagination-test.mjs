#!/usr/bin/env node
/**
 * 媒体评价分页的离线测试。
 *
 * 断言的是 `web/src/lib/review-pagination.ts` 的真实源码 —— 不是复制一份逻辑过来
 * 再自测。做法：用 esbuild 把那个 TS 文件打成一份临时 CJS 再 require。
 *
 * 为什么值得单独测：这段逻辑的边界（0/1/5/6/10/11/200 条、翻页后条数变化导致页码
 * 越界、展开与翻页的交互）肉眼看不出来，而它一旦错了，界面要么空白、要么静默少显示
 * 数据 —— 从截图上发现不了。
 *
 * 用法：node backend/scripts/verify/review-pagination-test.mjs
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const src = resolve(repoRoot, "web/src/lib/review-pagination.ts");

let pass = 0;
let fail = 0;
const ok = (msg) => {
  pass += 1;
  console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
};
const bad = (msg, actual, expected) => {
  fail += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${msg}（期望 ${expected}，实际 ${actual}）`);
};
const eq = (msg, actual, expected) => {
  if (actual === expected) ok(`${msg} → ${actual}`);
  else bad(msg, actual, expected);
};

// ---- 用 esbuild 把真实源码打成 CJS ------------------------------------------
const tmp = mkdtempSync(join(tmpdir(), "sp-pagination-"));
const outfile = join(tmp, "review-pagination.cjs");
try {
  const esbuild = await import("esbuild");
  await esbuild.build({
    entryPoints: [src],
    outfile,
    bundle: true,
    format: "cjs",
    platform: "node",
    logLevel: "silent",
  });
} catch (err) {
  console.error("esbuild 打包失败：", err.message);

  rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
}

const {
  PAGE_SIZE, FIRST_PAGE_COLLAPSED, paginateReviews, slicePage,
  ALL_PLATFORMS, platformOptions, filterByPlatform,
  filterByOutlet, sortReviews, pagerPages, REVIEW_SORTS,
} = await import(`file://${outfile}`);

console.log("\n\x1b[1m媒体评价分页 · 离线测试\x1b[0m\n");

// ---- 常量与要求一致 ---------------------------------------------------------
console.log("  \x1b[1m[常量]\x1b[0m");
eq("每页最多条数", PAGE_SIZE, 10);
eq("第一页默认露出条数", FIRST_PAGE_COLLAPSED, 5);

// ---- 默认态：第一页露 5 条 --------------------------------------------------
console.log("\n  \x1b[1m[第一页默认 5 条]\x1b[0m");
{
  const p = paginateReviews(66, 1, false);
  eq("66 条时可见条数", p.visibleCount, 5);
  eq("66 条时已显示", p.shown, 5);
  eq("66 条时可展开", p.canExpand, true);
  eq("66 条时总页数", p.pageCount, 7);
}
{
  const p = paginateReviews(4, 1, false);
  eq("4 条时可见条数", p.visibleCount, 5);
  eq("4 条时已显示（不能超过总数）", p.shown, 4);
  eq("4 条时无可展开", p.canExpand, false);
}
{
  const p = paginateReviews(5, 1, false);
  eq("恰好 5 条时已显示", p.shown, 5);
  eq("恰好 5 条时无可展开（没有多余的了）", p.canExpand, false);
}
{
  const p = paginateReviews(6, 1, false);
  eq("6 条时可展开", p.canExpand, true);
}

// ---- 展开态：补齐到整页 10 条 ----------------------------------------------
console.log("\n  \x1b[1m[展开后 10 条，且不越过页边界]\x1b[0m");
{
  const p = paginateReviews(66, 1, true);
  eq("66 条展开后可见条数", p.visibleCount, 10);
  eq("66 条展开后已显示", p.shown, 10);
  eq("展开后不再提供展开按钮", p.canExpand, false);
}
{
  const p = paginateReviews(7, 1, true);
  eq("7 条展开后已显示（不超过总数）", p.shown, 7);
}
{
  // 要求「一页最多展示十条」：展开不得变成第 11 条。
  const p = paginateReviews(200, 1, true);
  eq("200 条展开后仍只有一页 10 条", p.visibleCount, PAGE_SIZE);
}

// ---- 第二页起：整页 10 条、无展开 -------------------------------------------
console.log("\n  \x1b[1m[第 2 页起]\x1b[0m");
{
  const p = paginateReviews(66, 2, false);
  eq("第 2 页可见条数", p.visibleCount, 10);
  eq("第 2 页无展开按钮", p.canExpand, false);
  eq("第 2 页已显示", p.shown, 10);
}
{
  const p = paginateReviews(66, 7, false);
  eq("最后一页（第 7 页）已显示", p.shown, 6);
  eq("最后一页无展开按钮", p.canExpand, false);
}

// ---- 页码越界必须夹回 ------------------------------------------------------
// 重新抓取会让条数变化；用户停在第 7 页而条数缩到 15 条时，不夹取就会渲染空白。
console.log("\n  \x1b[1m[页码越界夹取 —— 重新抓取后条数变化]\x1b[0m");
{
  const p = paginateReviews(15, 7, false);
  eq("15 条却停在第 7 页 → 夹到第 2 页", p.page, 2);
  eq("夹取后已显示", p.shown, 5);
}
{
  const p = paginateReviews(66, 0, false);
  eq("页码 0 → 夹到第 1 页", p.page, 1);
}
{
  const p = paginateReviews(66, -3, false);
  eq("负数页码 → 夹到第 1 页", p.page, 1);
}
{
  const p = paginateReviews(66, 999, false);
  eq("超大页码 → 夹到最后一页", p.page, 7);
}
{
  const p = paginateReviews(66, 2.7, false);
  eq("小数页码 → 向下取整", p.page, 2);
}
{
  const p = paginateReviews(66, NaN, false);
  eq("NaN 页码 → 第 1 页", p.page, 1);
}

// ---- 空集合：不能出现 0 页 -------------------------------------------------
console.log("\n  \x1b[1m[空集合]\x1b[0m");
{
  const p = paginateReviews(0, 1, false);
  eq("0 条时总页数（至少 1，便于渲染「第 x / y 页」）", p.pageCount, 1);
  eq("0 条时已显示", p.shown, 0);
  eq("0 条时无可展开", p.canExpand, false);
}
{
  const p = paginateReviews(-5, 1, false);
  eq("负数条数不产生负页码", p.page, 1);
  eq("负数条数按 0 处理", p.shown, 0);
}

// ---- slicePage 必须与 paginateReviews 的分页一致 ---------------------------
// 两者若各算各的，就会出现「页码说第 3 页、切片却给了第 1 页」这种错位。
console.log("\n  \x1b[1m[切片与页码一致]\x1b[0m");
{
  const items = Array.from({ length: 66 }, (_, i) => i + 1);
  eq("第 1 页切片首项", slicePage(items, 1)[0], 1);
  eq("第 1 页切片长度", slicePage(items, 1).length, 10);
  eq("第 3 页切片首项", slicePage(items, 3)[0], 21);
  eq("第 7 页切片长度（余 6 条）", slicePage(items, 7).length, 6);

  // 全量遍历：每一条都必须恰好出现在一页里，不重不漏。
  const seen = [];
  for (let pg = 1; pg <= paginateReviews(items.length, 1, false).pageCount; pg += 1) {
    seen.push(...slicePage(items, pg));
  }
  eq("逐页取完的总条数", seen.length, 66);
  eq("无重复", new Set(seen).size, 66);
  eq("首尾连续", seen[0] === 1 && seen[65] === 66, true);
}

// ---- 展开态在翻页后必须复位（否则第 2 页会因为 expanded 残留而异常）--------
console.log("\n  \x1b[1m[展开态与翻页的组合]\x1b[0m");
{
  // 第 2 页即使 expanded 残留为 true，也应当整页 10 条、无展开按钮。
  const p = paginateReviews(66, 2, true);
  eq("第 2 页 expanded=true 时可见条数", p.visibleCount, 10);
  eq("第 2 页 expanded=true 时无展开按钮", p.canExpand, false);
}


  // ---- 平台筛选（本轮需求 2）--------------------------------------------------
  console.log("\n  \x1b[1m[平台筛选]\x1b[0m");
  {
    const mk = (outlet, platform) => ({ outlet, platform });
    const list = [
      mk("IGN", "PS5"), mk("GameSpot", "PS5"), mk("PC Gamer", "PC"),
      mk("Nintendo Life", "Switch"), mk("Mystery Blog", null),
    ];

    eq("「全部」的哨兵值不与真实平台名冲突", ALL_PLATFORMS.startsWith("__"), true);
    eq("「全部」返回原列表（同一引用即可）", filterByPlatform(list, ALL_PLATFORMS).length, 5);
    eq("空值等同于「全部」", filterByPlatform(list, null).length, 5);
    eq("undefined 等同于「全部」", filterByPlatform(list, undefined).length, 5);

    eq("筛 PS5", filterByPlatform(list, "PS5").length, 2);
    eq("筛 PC", filterByPlatform(list, "PC").length, 1);
    eq("筛 Switch", filterByPlatform(list, "Switch").length, 1);
    eq("筛不存在的平台 → 空", filterByPlatform(list, "Xbox").length, 0);
    eq("无平台评价不被任何平台筛中", filterByPlatform(list, "PS5").some((r) => r.platform === null), false);

    // 大小写与空白：历史数据里可能存着归一化前的写法，不该因此筛出空结果
    eq("大小写不敏感", filterByPlatform([mk("A", "ps5")], "PS5").length, 1);
    eq("首尾空白不敏感", filterByPlatform([mk("A", " PS5 ")], "PS5").length, 1);

    // 选项归纳
    const opts = platformOptions(list);
    eq("选项数 = 1（全部）+ 3 个真实平台", opts.length, 4);
    eq("首项是「全部」", opts[0].value, ALL_PLATFORMS);
    eq("「全部」计数含无平台评价", opts[0].count, 5);
    eq("PS5 计数", opts.find((o) => o.value === "PS5").count, 2);
    eq("不把无平台评价单列成一项", opts.some((o) => !o.value || o.value === "null"), false);

    // 排序：条数多的在前，同数量按名称，保证渲染顺序稳定
    const many = [mk("a", "A"), mk("b", "B"), mk("c", "B"), mk("d", "C"), mk("e", "C")];
    const o2 = platformOptions(many).slice(1).map((o) => o.value);
    eq("条数多的平台排在前", o2[0], "B");
    eq("同数量按名称排序（A 条数少，B/C 同数量时按名称）", o2.join(""), "BCA");

    // 空列表
    eq("空列表只有「全部」一项", platformOptions([]).length, 1);
    eq("空列表的「全部」计数为 0", platformOptions([])[0].count, 0);

    // 全都没有平台时不应凭空造出平台选项
    const noneHasPlatform = [mk("x", null), mk("y", null)];
    eq("全无平台时只有「全部」", platformOptions(noneHasPlatform).length, 1);
    eq("全无平台时「全部」仍有计数", platformOptions(noneHasPlatform)[0].count, 2);
  }

// ---- 媒体名搜索 + 排序 + 页码条（本轮新增的三个纯函数） ---------------------
const mk3 = (outlet, score, publishedAt) => ({ outlet, score, publishedAt });

console.log("\n  \x1b[1m[媒体名搜索]\x1b[0m");
{
  const list = [
    mk3("IGN", 90, "2024-09-05"),
    mk3("IGN Japan", 80, "2024-09-06"),
    mk3("PC Gamer", 70, "2024-09-07"),
    mk3(null, 60, null),
  ];
  eq("空查询原样返回（同一个引用，不复制）", filterByOutlet(list, ""), list);
  eq("纯空白也算空查询", filterByOutlet(list, "   "), list);
  eq("按子串匹配（IGN 同时命中 IGN 与 IGN Japan）", filterByOutlet(list, "IGN").length, 2);
  eq("大小写不敏感", filterByOutlet(list, "ign").length, 2);
  eq("首尾空白不敏感", filterByOutlet(list, "  pc gamer ").length, 1);
  eq("只匹配媒体名，不匹配其他字段", filterByOutlet(list, "2024").length, 0);
  eq("outlet 为 null 不会被任何词命中", filterByOutlet(list, "null").length, 0);
  eq("无命中返回空数组", filterByOutlet(list, "Eurogamer").length, 0);
  eq("不原地改动原列表", list.length, 4);
}

console.log("\n  \x1b[1m[排序方式]\x1b[0m");
{
  const list = [
    mk3("A", 80, "2024-09-01"),
    mk3("B", null, "2024-09-05"),
    mk3("C", 90, "2024-08-20"),
    mk3("D", 70, null),
  ];
  const names = (rs) => rs.map((r) => r.outlet).join("");

  eq("排序选项齐全（顺序即下拉框顺序）", REVIEW_SORTS.join(","), "default,score-desc,score-asc,newest,oldest");
  eq("default 原样返回（同一个引用）", sortReviews(list, "default"), list);
  eq("分数从高到低", names(sortReviews(list, "score-desc")), "CADB");
  eq("分数从低到高", names(sortReviews(list, "score-asc")), "DACB");
  eq("时间从新到旧", names(sortReviews(list, "newest")), "BACD");
  eq("时间从旧到新", names(sortReviews(list, "oldest")), "CABD");

  // 缺值一律垫底：不跟着升降序翻转。「评分从低到高」时若把没打分的排到最前，
  // 看上去就像「这些是最差的一组」，而它们只是没有分数。
  eq("降序时无分数的垫底", names(sortReviews(list, "score-desc")).slice(-1), "B");
  eq("升序时无分数的同样垫底", names(sortReviews(list, "score-asc")).slice(-1), "B");
  eq("降序时无日期的垫底", names(sortReviews(list, "newest")).slice(-1), "D");
  eq("升序时无日期的同样垫底", names(sortReviews(list, "oldest")).slice(-1), "D");

  // 解析不了的日期按「没有日期」处理，而不是当成 1970 年排到最旧
  const weird = [mk3("A", 80, "不是日期"), mk3("B", 90, "2024-01-01")];
  eq("解析不了的日期算缺值垫底", names(sortReviews(weird, "newest")), "BA");

  // 不原地排序：调用方还要用原列表算平台计数与总数
  const snapshot = names(list);
  sortReviews(list, "score-asc");
  eq("不原地排序（原列表顺序不变）", names(list), snapshot);

  eq("空列表排序不炸", sortReviews([], "newest").length, 0);
}

console.log("\n  \x1b[1m[页码条]\x1b[0m");
{
  const p = (page, count, span) =>
    (span === undefined ? pagerPages(page, count) : pagerPages(page, count, span)).join(",");

  eq("1 页 → 只有 1", p(1, 1), "1");
  eq("5 页全部铺开", p(3, 5), "1,2,3,4,5");
  eq("7 页仍然全铺开，不出现省略号", p(4, 7), "1,2,3,4,5,6,7");
  // 8 页起：首页与末页必留，中间的省略号说明「这里隔了若干页」
  eq("8 页开始省略：首 + 当前及相邻 + 末", p(4, 8), "1,gap,3,4,5,gap,8");
  eq("第 1 页（左侧不出现省略号）", p(1, 20), "1,2,gap,20");
  eq("第 2 页（左侧仍不出现省略号）", p(2, 20), "1,2,3,gap,20");
  eq("靠末页时右侧不出现省略号", p(19, 20), "1,gap,18,19,20");
  eq("中间页两侧都有省略号", p(10, 20), "1,gap,9,10,11,gap,20");
  eq("span=2 时相邻页更多", p(10, 20, 2), "1,gap,8,9,10,11,12,gap,20");
  eq("页数非法（0）时兜底成 1 页", p(1, 0), "1");
  eq("页码条里没有 undefined/NaN", pagerPages(6, 50).every((i) => i === "gap" || Number.isInteger(i)), true);
}

rmSync(tmp, { recursive: true, force: true });

console.log(
  `\n\x1b[1m结果：${pass} 项通过 / ${fail} 项失败\x1b[0m\n`,
);
process.exit(fail === 0 ? 0 : 1);