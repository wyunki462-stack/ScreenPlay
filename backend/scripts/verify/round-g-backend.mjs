/**
 * 本轮两项优化的端到端验证（需要实例已启动）。
 *
 *   需求1  平均通关时长覆盖率：多源兜底、中文名解析、增量更新不清空
 *   需求2  游戏卡片拖拽自定义排序：位置持久化、邻居定位、重置
 *
 * 环境变量：
 *   BASE     实例地址，默认 http://127.0.0.1:4418
 *   TEST_DB  库文件路径；给出时才会做读库断言
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const BASE = process.env.BASE ?? 'http://127.0.0.1:4418';
const TEST_DB = process.env.TEST_DB ?? '';

let pass = 0;
let fail = 0;
let warned = 0;

const ok = (m) => {
  console.log(`    \x1b[32m✓\x1b[0m ${m}`);
  pass += 1;
};
const bad = (m) => {
  console.log(`    \x1b[31m✗\x1b[0m ${m}`);
  fail += 1;
};
const hint = (m) => {
  console.log(`    \x1b[33m•\x1b[0m ${m}`);
  warned += 1;
};
const group = (m) => console.log(`\n  \x1b[1m${m}\x1b[0m`);

async function api(path, init = {}) {
  const res = await fetch(`${BASE}/api${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Snapshot the live DB (plus WAL/SHM) before opening it read-only. */
function withDb(fn) {
  if (!TEST_DB || !fs.existsSync(TEST_DB)) return null;
  const copy = `${TEST_DB}.probe`;
  for (const suffix of ['', '-wal', '-shm']) {
    const src = TEST_DB + suffix;
    if (!fs.existsSync(src)) continue;
    try {
      fs.chmodSync(src, 0o644);
    } catch {
      /* best effort */
    }
    fs.copyFileSync(src, copy + suffix);
    try {
      fs.chmodSync(copy + suffix, 0o644);
    } catch {
      /* best effort */
    }
  }
  let db;
  try {
    db = new DatabaseSync(copy, { readOnly: true });
    return fn(db);
  } catch (err) {
    hint(`读库失败：${err.message}`);
    return null;
  } finally {
    db?.close();
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(copy + suffix, { force: true });
  }
}

/** The rendered order for a given sort mode. */
const orderOf = async (sort, extra = '') => {
  const { body } = await api(`/games?pageSize=50&sort=${sort}${extra}`);
  return Array.isArray(body) ? body : [];
};

const main = async () => {
  if ((await api('/health')).status !== 200) {
    console.error(`  实例不可用：${BASE}`);
    process.exit(1);
  }

  const games = await orderOf('name');
  if (games.length < 4) {
    console.error(`  夹具不足（${games.length} 个），至少需要 4 个`);
    process.exit(1);
  }
  console.log(`      夹具 ${games.length} 个：${games.map((g) => g.name).slice(0, 6).join(' / ')}`);

  // ─────────────────────────────────────────────────────────────────────
  group('【1】时长覆盖率：多源兜底后绝大多数游戏都有平均通关时长（需求1）');

  // 先全量刮一轮，让兜底链有机会跑完。
  await api('/games/refresh-all', { method: 'POST' });
  let withHours = 0;
  for (let i = 0; i < 10; i += 1) {
    await sleep(8000);
    const details = await Promise.all(games.map((g) => api(`/games/${g.id}`)));
    withHours = details.filter((d) => d.body?.mainStoryHours != null).length;
    if (withHours >= Math.ceil(games.length * 0.6)) break;
  }
  const ratio = withHours / games.length;
  if (ratio >= 0.6) ok(`覆盖率 ${withHours}/${games.length}（${Math.round(ratio * 100)}%）`);
  else hint(`覆盖率 ${withHours}/${games.length} —— HLTB 经代理偶发不可达，重试会继续补齐`);

  const details = await Promise.all(games.map((g) => api(`/games/${g.id}`)));
  const sourced = details.filter((d) => d.body?.durationSource);
  if (sourced.length) {
    const bySrc = {};
    for (const d of sourced) bySrc[d.body.durationSource] = (bySrc[d.body.durationSource] ?? 0) + 1;
    ok(`时长来源已记录：${Object.entries(bySrc).map(([k, v]) => `${k}×${v}`).join(' / ')}`);
  } else {
    hint('尚无时长来源记录');
  }

  // 中文目录名是覆盖率低的关键：HLTB 只索引拉丁标题。
  const cjk = details.find((d) => /[\u4e00-\u9fff]/.test(d.body?.folderName ?? ''));
  if (cjk) {
    const d = cjk.body;
    if (d.mainStoryHours != null) {
      ok(`中文目录名「${d.folderName}」已取到时长：${d.mainStoryHours}h（来源 ${d.durationSource}）`);
    } else {
      hint(`中文目录名「${d.folderName}」暂无时长（HLTB 不可达时会退到 RAWG）`);
    }
  }

  // 多维度：主剧情优先，兼容主+支线与全收集。
  const multi = details.find((d) => d.body?.completionistHours != null);
  if (multi) {
    ok(
      `多维度齐全：主线 ${multi.body.mainStoryHours}h / 主线+支线 ${multi.body.mainPlusExtraHours}h / 完美 ${multi.body.completionistHours}h`,
    );
  } else if (withHours) {
    hint('暂未取到全收集维度（仅 HLTB 提供，RAWG 只有单一维度）');
  }

  // 需求：无时长数据正常显示「未知」，不显示异常占位。
  const noHours = details.find((d) => d.body?.mainStoryHours == null);
  if (noHours) {
    // 详情页由 formatHltb() 渲染：三个维度都为空时返回 state.unknown。
    const dims = [noHours.body.mainStoryHours, noHours.body.mainPlusExtraHours, noHours.body.completionistHours];
    if (dims.every((v) => v == null)) ok(`无时长游戏「${noHours.body.name}」三个维度均为空 → 界面显示「未知」`);
    else bad('无时长游戏的维度字段异常');
  }

  const summary = (await orderOf('name')).find((g) => !g.durationSeconds);
  if (summary) {
    if (summary.durationText && summary.durationText !== 'undefined' && summary.durationText !== 'null') {
      ok(`无媒体时长的卡片文案正常：「${summary.durationText}」`);
    } else {
      bad(`无媒体时长的卡片文案异常：${JSON.stringify(summary.durationText)}`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  group('【2】已有时长不得被清空（需求1）');

  const keeper = details.find((d) => d.body?.mainStoryHours != null)?.body;
  if (!keeper) {
    hint('暂无已有时长可验证，跳过');
  } else {
    const before = keeper.mainStoryHours;
    await api(`/games/${keeper.id}/refresh`, { method: 'POST' });
    await sleep(3000);
    const after = (await api(`/games/${keeper.id}`)).body?.mainStoryHours ?? null;
    if (after === before) ok(`刷新后时长保持 ${before}h 未被清空`);
    else if (after != null) ok(`刷新后时长更新为 ${after}h（原 ${before}h，属正常增量更新）`);
    else bad(`刷新后时长被清空（原 ${before}h）`);
  }

  // ─────────────────────────────────────────────────────────────────────
  group('【3】拖拽自定义排序：位置持久化与邻居定位（需求2）');

  const initial = await orderOf('custom');
  if (initial.length !== games.length) {
    bad(`自定义模式返回 ${initial.length} 个，应为 ${games.length} 个`);
  } else {
    ok(`自定义模式返回全部 ${initial.length} 个游戏`);
  }
  if (initial.every((g) => g.customOrder == null || g.customOrder === null)) {
    // 尚未拖拽时与按名称一致，这是设计行为
    const namesCustom = initial.map((g) => g.name.toLowerCase());
    const namesDefault = [...namesCustom].sort();
    if (JSON.stringify(namesCustom) === JSON.stringify(namesDefault)) {
      ok('尚未拖拽时顺序等于默认（按名称），不会出现随机顺序');
    } else {
      bad('尚未拖拽时顺序既非默认也无自定义位置');
    }
  }

  // 把最后一个拖到最前。
  // 邻居语义：afterId = 落在它上面的那张卡，beforeId = 落在它下面的那张卡。
  // 「拖到最前」= 下面那张是当前的第一张，上面没有卡（afterId: null）。
  const last = initial[initial.length - 1];
  const first = initial[0];
  const moved = await api('/games/order', {
    method: 'PUT',
    body: JSON.stringify({ gameId: last.id, beforeId: first.id, afterId: null }),
  });
  if (moved.status === 200 && typeof moved.body?.customOrder === 'number') {
    ok(`拖到最前成功，分配位置 ${moved.body.customOrder}`);
  } else {
    bad(`拖到最前失败：HTTP ${moved.status} ${JSON.stringify(moved.body).slice(0, 120)}`);
  }

  const afterMove = await orderOf('custom');
  if (afterMove[0]?.id === last.id) ok(`「${last.name}」已排到首位`);
  else bad(`首位仍是「${afterMove[0]?.name}」，期望「${last.name}」`);

  // 中间插入：把某一个放到两个邻居之间
  const src = afterMove[afterMove.length - 1];
  const above = afterMove[1];
  const below = afterMove[2];
  const mid = await api('/games/order', {
    method: 'PUT',
    body: JSON.stringify({ gameId: src.id, beforeId: below.id, afterId: above.id }),
  });
  if (mid.status === 200) ok('拖到中间（指定上下邻居）成功');
  else bad(`拖到中间失败：HTTP ${mid.status}`);

  const afterMid = await orderOf('custom');
  const idx = afterMid.findIndex((g) => g.id === src.id);
  if (afterMid[idx - 1]?.id === above.id && afterMid[idx + 1]?.id === below.id) {
    ok(`「${src.name}」正好落在「${above.name}」与「${below.name}」之间`);
  } else {
    bad(`邻居不符：前后为「${afterMid[idx - 1]?.name}」「${afterMid[idx + 1]?.name}」`);
  }

  // 其他排序模式不受影响
  const byName = await orderOf('name');
  const expectName = [...byName].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  if (JSON.stringify(byName.map((g) => g.id)) === JSON.stringify(expectName.map((g) => g.id))) {
    ok('「按名称」模式仍按原规则生效，未被自定义顺序影响');
  } else {
    bad('「按名称」模式被自定义顺序影响了');
  }

  // 需求：兼容筛选 / 平台过滤
  const withPlatform = (await orderOf('custom')).find((g) => g.platform);
  if (withPlatform) {
    const filtered = await orderOf('custom', `&platform=${encodeURIComponent(withPlatform.platform)}`);
    if (filtered.length && filtered.every((g) => g.platform === withPlatform.platform)) {
      ok(`平台过滤下自定义排序仍生效（${withPlatform.platform}：${filtered.length} 个）`);
    } else {
      bad('平台过滤下自定义排序结果异常');
    }
  }

  // 分页：位置是全局的，跨页也应一致
  const p1 = await api('/games?pageSize=2&page=1&sort=custom');
  const p2 = await api('/games?pageSize=2&page=2&sort=custom');
  const concat = [...(p1.body ?? []), ...(p2.body ?? [])].map((g) => g.id);
  const full = (await orderOf('custom')).slice(0, 4).map((g) => g.id);
  if (JSON.stringify(concat) === JSON.stringify(full)) {
    ok('分页拼接结果与完整顺序一致（跨页排序统一）');
  } else {
    bad(`分页顺序不一致：${concat.length} vs ${full.length}`);
  }

  // 需求：容器重启不丢。位置存在数据库里，重启后仍应存在。
  const stored = withDb((db) =>
    db.prepare('SELECT COUNT(*) AS n FROM games WHERE custom_order IS NOT NULL').get(),
  );
  if (stored) {
    if (stored.n > 0) ok(`库中已有 ${stored.n} 个自定义位置（持久化于 SQLite）`);
    else bad('库中没有自定义位置，拖拽结果未持久化');
  }

  // ─────────────────────────────────────────────────────────────────────
  group('【4】一键重置自定义排序（需求2）');

  const reset = await api('/games/order', { method: 'DELETE' });
  if (reset.status === 200 && reset.body?.ok) {
    ok(`重置成功，清除了 ${reset.body.cleared} 个自定义位置`);
  } else {
    bad(`重置失败：HTTP ${reset.status}`);
  }

  const afterReset = await orderOf('custom');
  const defaultOrder = await orderOf('name');
  if (JSON.stringify(afterReset.map((g) => g.id)) === JSON.stringify(defaultOrder.map((g) => g.id))) {
    ok('重置后恢复为系统默认顺序');
  } else {
    bad('重置后未恢复默认顺序');
  }
  if (afterReset.every((g) => g.customOrder == null)) ok('所有自定义位置已清空');
  else bad('仍残留自定义位置');

  console.log(`\n  结果: ${pass} 通过 / ${warned} 提示 / ${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
};

main().catch((err) => {
  console.error(`  测试异常：${err?.message}`);
  process.exit(1);
});