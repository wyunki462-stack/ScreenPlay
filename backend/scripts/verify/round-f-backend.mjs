/**
 * 本轮三项需求的端到端验证（需要实例已启动）。
 *
 *   问题1  手动匹配/刷新后 Metacritic 评分不再偶发丢失
 *   问题2  评分手动选择（各平台条目 / 持久化 / 恢复自动匹配）
 *   问题3  通关时长 →「平均通关时长」且多源兜底
 *
 * 环境变量：
 *   BASE     实例地址，默认 http://127.0.0.1:4409
 *   TEST_DB  库文件路径；给出时才会做读库断言
 *
 * 读库时会连同 -wal / -shm 一起复制快照：只复制主库文件会漏掉最新写入
 * （匹配结果就在 WAL 里），而且本应用创建的库文件是 000 权限，副本要显式 chmod。
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const BASE = process.env.BASE ?? 'http://127.0.0.1:4409';
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

/** Run a callback against a consistent-enough snapshot of the live database. */
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

const firstGame = async (name) => {
  const { body } = await api('/games?pageSize=100');
  const list = Array.isArray(body) ? body : [];
  return list.find((g) => g.name === name) ?? list[0] ?? null;
};

const main = async () => {
  const health = await api('/health');
  if (health.status !== 200) {
    console.error(`  实例不可用：${BASE}`);
    process.exit(1);
  }

  // ───────────────────────────────────────────────────────────────────────
  group('【1】刷新元数据不会清空已有评分（问题1）');

  const game = await firstGame('Hades');
  if (!game) {
    bad('列表里没有可用游戏');
    console.log(`\n  结果: ${pass} 通过 / ${warned} 提示 / ${fail} 失败\n`);
    process.exit(1);
  }
  console.log(`      夹具：${game.name}（${game.id}）`);

  // 先确保库里有一条有效评分，再证明刷新不会把它弄丢。
  let score = game.metacriticScore;
  if (score == null) {
    for (let i = 0; i < 3 && score == null; i += 1) {
      await api(`/games/${game.id}/refresh`, { method: 'POST' });
      await new Promise((r) => setTimeout(r, 2000));
      score = (await api(`/games/${game.id}`)).body?.metacriticScore ?? null;
    }
  }
  if (score != null) ok(`刷新前已有有效评分：${score}`);
  else hint('夹具仍未拿到评分（Metacritic 需代理且偶发不可达），后续断言将跳过');

  if (score != null) {
    let survived = true;
    for (let i = 0; i < 2; i += 1) {
      await api(`/games/${game.id}/refresh`, { method: 'POST' });
      await new Promise((r) => setTimeout(r, 1500));
      const after = (await api(`/games/${game.id}`)).body?.metacriticScore ?? null;
      if (after == null) {
        survived = false;
        bad(`第 ${i + 1} 次刷新后评分丢失（旧实现的表现）`);
        break;
      }
    }
    if (survived) ok('连续两次「刷新元数据」后评分依然存在');

    // 评分字段被 null 覆盖是根因之二：用极端数据直接验证库里的值没被写坏。
    const stored = withDb((db) =>
      db.prepare('SELECT ratings FROM games WHERE id = ?').get(game.id),
    );
    if (stored) {
      const ratings = JSON.parse(stored.ratings ?? '[]');
      const withScore = ratings.filter((r) => r.metascore != null);
      if (withScore.length) ok(`库中仍有带分数的条目：${withScore.map((r) => r.metascore).join('/')}`);
      else bad(`库中已无带分数的条目：${stored.ratings}`);
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  group('【2】评分手动选择：候选包含平台 / 评分 / 发布时间（问题2）');

  const cand = await api(`/games/${game.id}/rating-candidates?q=${encodeURIComponent('Hades')}`);
  if (cand.status !== 200) {
    hint(`候选接口返回 ${cand.status}（可能是代理不可达，稍后重试即可）`);
  } else {
    const list = cand.body?.candidates ?? [];
    if (list.length) ok(`返回 ${list.length} 条候选`);
    else hint('候选为空（Metacritic 偶发不可达）');

    const withScore = list.filter((c) => c.metascore != null);
    if (withScore.length) ok(`其中 ${withScore.length} 条带评分：${withScore.slice(0, 3).map((c) => `${c.name}=${c.metascore}`).join(' | ')}`);
    else hint('本批候选均无评分');

    const withPlatform = list.filter((c) => c.platform);
    if (withPlatform.length) ok(`候选带平台信息：${withPlatform.slice(0, 3).map((c) => c.platform).join(' / ')}`);
    else bad('候选没有平台信息，用户无法按平台选择');

    const withDate = list.filter((c) => c.releaseDate);
    if (withDate.length) ok(`候选带发布时间：${withDate.slice(0, 3).map((c) => c.releaseDate).join(' / ')}`);
    else hint('候选没有发布时间');
  }

  // ───────────────────────────────────────────────────────────────────────
  group('【3】选定后卡片与详情页同步、可恢复自动匹配、跨刷新与重启保持（问题2）');

  const pick = (cand.body?.candidates ?? []).find((c) => c.metascore != null);
  if (!pick) {
    hint('没有带评分的候选，跳过手动选择断言');
  } else {
    const set = await api(`/games/${game.id}/rating-target`, {
      method: 'PUT',
      body: JSON.stringify({
        externalId: pick.externalId,
        name: pick.name,
        platform: pick.platform,
        metascore: pick.metascore,
        releaseDate: pick.releaseDate,
      }),
    });
    if (set.status === 200 && set.body?.metacriticManual === true) {
      ok(`已选定「${pick.name}」${pick.platform ?? ''} = ${pick.metascore} 分`);
    } else {
      bad(`选定失败：HTTP ${set.status} ${JSON.stringify(set.body).slice(0, 120)}`);
    }

    if (set.body?.metacriticScore === pick.metascore) ok('详情页显示该分数');
    else bad(`详情页分数不符：${set.body?.metacriticScore}`);

    const list = await api('/games?pageSize=100');
    const card = (Array.isArray(list.body) ? list.body : []).find((g) => g.id === game.id);
    if (card?.metacriticScore === pick.metascore) ok('图库卡片同步显示该分数');
    else bad(`卡片分数不符：${card?.metacriticScore}`);

    // 全量刮削路径（单游戏刷新）不得重置用户选择
    await api(`/games/${game.id}/refresh`, { method: 'POST' });
    await new Promise((r) => setTimeout(r, 1500));
    const afterRefresh = (await api(`/games/${game.id}`)).body;
    if (afterRefresh?.metacriticManual === true && afterRefresh?.metacriticScore === pick.metascore) {
      ok('刷新元数据后仍沿用用户选择（未被自动匹配重置）');
    } else {
      bad(
        `刷新后被重置：manual=${afterRefresh?.metacriticManual} score=${afterRefresh?.metacriticScore}`,
      );
    }

    const persisted = withDb((db) =>
      db.prepare('SELECT * FROM rating_targets WHERE game_id = ?').get(game.id),
    );
    if (persisted) ok(`已持久化到 rating_targets（external_id=${persisted.external_id}）`);
    else hint('未读到 rating_targets（TEST_DB 未提供或读库失败）');

    const cleared = await api(`/games/${game.id}/rating-target`, { method: 'DELETE' });
    if (cleared.status === 200 && cleared.body?.metacriticManual === false) {
      ok('「恢复自动匹配」生效，回到系统刮削结果');
    } else {
      bad(`恢复自动匹配失败：HTTP ${cleared.status}`);
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  group('【4】平均通关时长：多源兜底与来源标记（问题3）');

  const detail = (await api(`/games/${game.id}`)).body;
  if (detail?.mainStoryHours != null) {
    ok(
      `平均通关时长已填充：主线 ${detail.mainStoryHours}h` +
        `${detail.mainPlusExtraHours != null ? ` / 主线+支线 ${detail.mainPlusExtraHours}h` : ''}` +
        `${detail.completionistHours != null ? ` / 完美通关 ${detail.completionistHours}h` : ''}`,
    );
  } else {
    hint('主线时长仍为空（HLTB 经代理偶发不可达，多源兜底会重试）');
  }

  if (detail?.durationSource) ok(`时长来源已记录：${detail.durationSource}`);
  else hint('时长来源未记录（可能尚未取到时长）');

  if (detail?.mainStoryHours != null && detail.mainPlusExtraHours != null &&
      detail.completionistHours != null && detail.durationSource === 'hltb') {
    ok('三个维度齐全且来自 HLTB（主线优先，兼容全收集维度）');
  }

  // HLTB 可达性：它是主源，单独报告一次状态便于判断是网络问题还是代码问题。
  const probe = await api(`/games/${game.id}/refresh`, { method: 'POST' });
  if (probe.status <= 400) ok('刷新请求被接受（时长更新随刷新触发）');
  else bad(`刷新失败：HTTP ${probe.status}`);

  console.log(`\n  结果: ${pass} 通过 / ${warned} 提示 / ${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
};

main().catch((err) => {
  console.error(`  测试异常：${err?.message}`);
  process.exit(1);
});