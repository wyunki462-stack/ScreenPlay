#!/usr/bin/env node
/**
 * 海报归属规则的离线测试（1.0.0 缺陷修复）。
 *
 * 背景：`MetadataService.persist()` 的注释一直写着「只有本地海报还在时才用元数据
 * 填充海报」，但那条判断算出来的变量从来没被用上 —— UPDATE 的 SQL 参数直接传了
 * `fragment.poster`，于是用户自己贴的外链海报会被抓取结果覆盖。修复把这条规则抽成
 * `mergePoster()` 纯函数，并让服务显式使用它。
 *
 * 为什么只能离线测：元数据片段里的 `poster` 只有 IGDB 会产出，而 IGDB 的 base URL
 * 写死在 `igdb.provider.ts`（无法像 HLTB / Metacritic 那样指向桩服），抓取链路没法
 * 离线驱动；规则本身是纯函数，直接断言它更有意义。
 *
 * 做法：用 esbuild 把 `backend/src/metadata/metadata-merge.ts` 的**真实源码**打成 CJS
 * 再 import（与 `review-pagination-test.mjs` 同一套办法），另外对编译产物
 * `backend/dist/metadata/metadata.service.js` 做静态断言，防止规则被改回直接传
 * `fragment.poster`。
 *
 * 用法：npm run build && node backend/scripts/verify/poster-merge-unit.mjs
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const src = resolve(repoRoot, "backend/src/metadata/metadata-merge.ts");

let pass = 0;
let fail = 0;
const ok = (msg) => {
  pass += 1;
  console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
};
const bad = (msg, actual, expected) => {
  fail += 1;
  console.log(
    `  \x1b[31m✗\x1b[0m ${msg}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`,
  );
};
const eq = (msg, actual, expected) => {
  if (actual === expected) ok(`${msg} → ${JSON.stringify(actual)}`);
  else bad(msg, actual, expected);
};

// ---- 用 esbuild 把真实源码打成 CJS ------------------------------------------
const tmp = mkdtempSync(join(tmpdir(), "sp-poster-merge-"));
const outfile = join(tmp, "metadata-merge.cjs");
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

const { mergePoster } = await import(`file://${outfile}`);

console.log("\n\x1b[1m海报归属 · 离线测试（1.0.0 海报覆盖缺陷）\x1b[0m\n");

// ---- 规则本身 ---------------------------------------------------------------
console.log("  \x1b[1m[用户自选的海报：谁都不能覆盖]\x1b[0m");
eq(
  "用户外链海报 + provider 给了海报 → 保持原值（返回 null，交给 COALESCE）",
  mergePoster(true, "https://images.igdb.com/igdb/image/upload/t_cover_big/abc.jpg"),
  null,
);
eq("用户外链海报 + provider 没给海报 → 保持原值", mergePoster(true, null), null);
eq("用户外链海报 + provider 给了空白 → 保持原值", mergePoster(true, "   "), null);

console.log("\n  \x1b[1m[自家下载的海报 / 空白位：可以填]\x1b[0m");
eq(
  "自家海报 + provider 新海报 → 换成新的",
  mergePoster(false, "https://images.igdb.com/igdb/image/upload/t_cover_big/new.jpg"),
  "https://images.igdb.com/igdb/image/upload/t_cover_big/new.jpg",
);
eq("空白海报 + provider 新海报 → 填上", mergePoster(false, "https://x/cover.jpg"), "https://x/cover.jpg");
eq("两侧都没有 → 保持原值", mergePoster(false, undefined), null);
eq("provider 给首尾空白 → trim 后再存", mergePoster(false, "  https://x/cover.jpg  "), "https://x/cover.jpg");

// ---- 接线：persist() 真的走这条规则（对编译产物做静态断言）------------------
const svcPath = resolve(repoRoot, "backend/dist/metadata/metadata.service.js");
console.log("\n  \x1b[1m[接线：persist() 真的用它，而不是回到旧写法]\x1b[0m");
if (!existsSync(svcPath)) {
  bad("后端编译产物存在（要先 npm run build）", null, svcPath);
} else {
  const svc = readFileSync(svcPath, "utf8");
  // 编译成 CJS 后调用形如 `(0, metadata_merge_1.mergePoster)(posterIsUserChoice, fragment.poster)`
  if (/mergePoster\)\(posterIsUserChoice, fragment\.poster\);/.test(svc)) {
    ok("persist() 用 mergePoster(posterIsUserChoice, fragment.poster) 算海报");
  } else {
    bad("persist() 用 mergePoster(posterIsUserChoice, fragment.poster) 算海报", false, true);
  }

  if (/WHERE id = \?`,\s*\[\s*poster,/.test(svc)) {
    ok("UPDATE 的参数首位是 mergePoster 的结果，不再是 fragment.poster");
  } else {
    bad("UPDATE 的参数首位是 mergePoster 的结果，不再是 fragment.poster", "不是", "是");
  }

  if (svc.includes("poster_url = COALESCE(?, poster_url)")) {
    ok("SQL 仍是 COALESCE(?, poster_url)（null 即「保持原值」）");
  } else {
    bad("SQL 仍是 COALESCE(?, poster_url)", false, true);
  }
}

rmSync(tmp, { recursive: true, force: true });
console.log(`\n\x1b[1m结果：${pass} 项通过 / ${fail} 项失败\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);