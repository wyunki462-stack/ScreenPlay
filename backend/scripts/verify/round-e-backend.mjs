/**
 * ScreenPlay 第二轮修复的后端端到端验证。
 *
 * 覆盖：
 *   问题1  手动匹配更换游戏时，旧游戏的自动刮削数据被全量清除，
 *          而用户上传的海报 / 自定义封面 / 本地相册 / 手动平台选择被保留
 *   问题2  任天堂游戏的搜索候选数量、metacritic 条目能否绑定成功、
 *          绑定失败时的提示是否给出原因与可试关键词
 *
 * 需要后端实例在跑（BASE 环境变量，默认 http://127.0.0.1:4407）。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE || 'http://127.0.0.1:4407';
const TEST_DB = process.env.TEST_DB;

let pass = 0, fail = 0, warned = 0;
const ok = (m) => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${m}`); };
const bad = (m) => { fail++; console.log(`  \x1b[31m✗\x1b[0m ${m}`); };
const hint = (m) => { warned++; console.log(`  \x1b[33m!\x1b[0m ${m}`); };

async function api(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* keep text */ }
  return { status: res.status, json, text };
}

/** 直接读库（后端在跑时 SQLite 被占用，所以用只读方式打开副本）。 */
function sql(statements) {
  if (!TEST_DB) return null;
  const copy = TEST_DB + '.probe';
  // The live instance keeps its recent writes in the WAL, so copying only the
  // main file would silently read a stale snapshot — and the files are created
  // mode 000 by the app, so both source and copies need an explicit chmod.
  for (const suffix of ['', '-wal', '-shm']) {
    const src = TEST_DB + suffix;
    if (!fs.existsSync(src)) continue;
    try { fs.chmodSync(src, 0o644); } catch { /* best effort */ }
    fs.copyFileSync(src, copy + suffix);
    try { fs.chmodSync(copy + suffix, 0o644); } catch { /* best effort */ }
  }
  const script = `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(${JSON.stringify(copy)}, { readOnly: true });
    const out = {};
    ${statements}
    console.log(JSON.stringify(out));
  `;
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(copy + suffix, { force: true });
  if (r.status !== 0) throw new Error('读库失败: ' + (r.stderr || '').slice(0, 300));
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

/** 等到后端可用。 */
async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return true; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

/** 找一个已刮到数据的夹具游戏。 */
async function pickFixture() {
  const list = await api('GET', '/api/games?pageSize=50');
  const games = list.json ?? [];
  return games.find((g) => g.name.includes('E-Rematch')) ?? games[0];
}

// ─────────────────────────────────────────────────────────────
async function main() {
  if (!(await waitReady())) { bad('后端未就绪'); return; }

  console.log('\n【1】手动匹配后：旧刮削数据被全量清除');
  const game = await pickFixture();
  if (!game) { bad('没有夹具游戏'); return; }
  const id = game.id;

  const before = sql(`
    out.game = db.prepare('SELECT screenshots, ratings, prices, summary, poster_url, achievements_status, achievements_error, trophy_source, platforms, custom_platform, duration_seconds FROM games WHERE id = ?').get(${JSON.stringify(id)});
    out.scrapedPosters = db.prepare("SELECT COUNT(*) c FROM game_posters WHERE game_id = ? AND source = 'scraped'").get(${JSON.stringify(id)}).c;
    out.userPosters = db.prepare("SELECT COUNT(*) c FROM game_posters WHERE game_id = ? AND source IN ('upload','media')").get(${JSON.stringify(id)}).c;
    out.userPosterIdCsv = db.prepare("SELECT COALESCE(GROUP_CONCAT(id, '|'), '') v FROM game_posters WHERE game_id = ? AND source IN ('upload','media')").get(${JSON.stringify(id)}).v;
    out.selectedUser = db.prepare("SELECT COUNT(*) c FROM game_posters WHERE game_id = ? AND source IN ('upload','media') AND is_selected = 1").get(${JSON.stringify(id)}).c;
    out.media = db.prepare('SELECT COUNT(*) c FROM media WHERE game_id = ?').get(${JSON.stringify(id)}).c;
    out.achRows = db.prepare('SELECT COUNT(*) c FROM achievements WHERE game_id = ?').get(${JSON.stringify(id)}).c;
    out.achLink = db.prepare('SELECT COUNT(*) c FROM achievement_links WHERE game_id = ?').get(${JSON.stringify(id)}).c;
  `);
  if (!before) { hint('未提供 TEST_DB，跳过读库断言'); return; }
  const beforeIds = String(before.userPosterIdCsv ?? '').split('|').filter(Boolean);
  // 读库自检：如果连"肯定有行"的 scaped 集合都读不出来，说明问题在探针本身，
  // 不能把它当成"用户海报丢了"。第四轮起会补入 media 行，更容易掩盖这个问题。
  if (before.userPosterIdCsv == null) {
    bad('读库探针异常：读不到用户海报 id，无法判断它们是否被保留');
    return;
  }

  console.log(`     匹配前：刮削海报 ${before.scrapedPosters} / 用户海报 ${before.userPosters}（选中 ${before.selectedUser}） / ids=[${before.userPosterIdCsv}]`
    + ` / 相册 ${before.media} / 成就 ${before.achRows} 行 / 手动成就目标 ${before.achLink} / 状态 ${before.game.achievements_status ?? 'null'}`);

  const shotsBefore = JSON.parse(before.game.screenshots || '[]').length;
  const durations = before.game.duration_seconds;

  // 换绑到一个明确不同的游戏：Metacritic 的 pokemon-violet。
  const cands = await api('GET', '/api/games/match/search?q=' + encodeURIComponent('宝可梦 紫'));
  const mc = (cands.json ?? []).find((c) => c.provider === 'metacritic');
  if (!mc) { hint('搜索结果里没有 metacritic 候选（代理波动），跳过换绑断言'); return; }
  if (!(before.scrapedPosters > 0 && shotsBefore > 0 && before.achRows > 0)) {
    hint('夹具的刮削数据不足，部分断言会退化');
  }

  const res = await api('POST', `/api/games/${id}/match`, { provider: 'metacritic', externalId: mc.externalId });
  if (res.status !== 201 && res.status !== 200) {
    bad(`换绑失败 HTTP ${res.status}: ${res.text.slice(0, 160)}`);
    return;
  }
  ok(`换绑到 metacritic:${mc.externalId} 成功（${res.json?.name}）`);

  const after = sql(`
    out.game = db.prepare('SELECT name, screenshots, ratings, summary, poster_url, achievements_status, achievements_error, trophy_source, platforms, custom_platform, duration_seconds FROM games WHERE id = ?').get(${JSON.stringify(id)});
    out.scrapedPosters = db.prepare("SELECT COUNT(*) c FROM game_posters WHERE game_id = ? AND source = 'scraped'").get(${JSON.stringify(id)}).c;
    out.userPosters = db.prepare("SELECT COUNT(*) c FROM game_posters WHERE game_id = ? AND source IN ('upload','media')").get(${JSON.stringify(id)}).c;
    out.userPosterIdCsv = db.prepare("SELECT COALESCE(GROUP_CONCAT(id, '|'), '') v FROM game_posters WHERE game_id = ? AND source IN ('upload','media')").get(${JSON.stringify(id)}).v;
    out.selectedUser = db.prepare("SELECT COUNT(*) c FROM game_posters WHERE game_id = ? AND source IN ('upload','media') AND is_selected = 1").get(${JSON.stringify(id)}).c;
    out.media = db.prepare('SELECT COUNT(*) c FROM media WHERE game_id = ?').get(${JSON.stringify(id)}).c;
    out.achRows = db.prepare('SELECT COUNT(*) c FROM achievements WHERE game_id = ?').get(${JSON.stringify(id)}).c;
    out.achLink = db.prepare('SELECT COUNT(*) c FROM achievement_links WHERE game_id = ?').get(${JSON.stringify(id)}).c;
  `);

  // —— 清除侧
  if (after.achRows === 0) ok('旧游戏的成就行已全部删除（不再是 0 残留）');
  else bad(`旧成就行仍残留 ${after.achRows} 行`);

  if (after.achLink === 0) ok('旧游戏的手动成就目标已清除');
  else bad(`achievement_links 仍残留 ${after.achLink} 行`);

  // The columns must not carry the OLD game's verdict. They may legitimately be
  // written again by the refresh that follows: a Nintendo title is genuinely
  // "unsupported" (no Steam binding, not a PlayStation platform), and that fresh
  // verdict is correct — what must never survive is the previous game's "ok".
  const staleStatus =
    after.game.achievements_status === before.game.achievements_status &&
    after.game.trophy_source === before.game.trophy_source;
  if (!staleStatus) {
    ok(
      `旧成就状态未残留（旧 status=${before.game.achievements_status}/source=${before.game.trophy_source}` +
        ` → 新 status=${after.game.achievements_status ?? 'null'}/source=${after.game.trophy_source ?? 'null'}）`,
    );
  } else {
    bad(`旧成就状态原样残留：${JSON.stringify({ s: after.game.achievements_status, t: after.game.trophy_source })}`);
  }
  if (after.game.achievements_status === 'unsupported' && after.game.achievements_error) {
    ok('新条目得到了属于它自己的判定（非 PlayStation / 无 Steam 绑定 → unsupported，且带说明）');
  }

  if (after.game.name !== game.name) ok(`游戏名已更新为新条目：「${after.game.name}」`);
  else bad(`游戏名未更新，仍是「${after.game.name}」`);

  const shotsAfter = JSON.parse(after.game.screenshots || '[]');
  const leaked = shotsBefore > 0 && shotsAfter.length > 0
    && JSON.parse(before.game.screenshots).every((u) => shotsAfter.includes(u));
  if (!leaked) ok(`截图列表已替换（旧 ${shotsBefore} 张 → 新 ${shotsAfter.length} 张，无旧图残留）`);
  else bad('截图列表仍是旧游戏的图片');

  // —— 保留侧
  // 判据是「原有的用户海报一张都没丢」，不是「数量完全不变」。
  //
  // 数量会合法增长：换绑定后的刷新会调用 `ensureRotationFloor()`，在轮播帧数
  // 不足时把本地相册截图补进轮播（第四轮「保证每个游戏都能翻页」的做法），
  // 于是 game_posters 里会多出 source='media' 的行。那是新登记的行，不是
  // 「用户海报被清掉」—— 用数量相等当判据会把它误报成丢失。
  //
  // 真正要防的是：用户自己上传/选过的那几张行被删除或换了 id。
  const afterIds = String(after.userPosterIdCsv ?? '').split('|').filter(Boolean);
  const lostIds = beforeIds.filter((pid) => !afterIds.includes(pid));
  if (lostIds.length === 0) {
    const added = afterIds.length - beforeIds.length;
    ok(
      `用户上传/相册海报被保留（原有 ${beforeIds.length} 张一张未丢` +
        `${added > 0 ? `，另有 ${added} 张相册截图按轮播下限被补入` : ''}）`,
    );
  } else {
    bad(`用户海报丢失 ${lostIds.length} 张（${before.userPosters} → ${after.userPosters}）`);
  }

  if (after.selectedUser >= before.selectedUser && before.selectedUser > 0) {
    ok('用户自定义封面选择被保留（仍处于选中态）');
  } else if (before.selectedUser === 0) {
    hint('夹具没有用户选中的封面，未覆盖该断言');
  } else {
    bad('用户自定义封面选择被清掉了');
  }

  if (after.media === before.media) ok(`本地相册媒体被保留（${after.media} 个）`);
  else bad(`本地媒体数量变化：${before.media} → ${after.media}`);

  if (after.game.custom_platform === before.game.custom_platform) ok('手动平台选择标记被保留');
  else bad('custom_platform 被改动');

  if (after.game.duration_seconds === durations) ok('游玩时长（本地数据，非刮削）被保留');
  else bad(`游玩时长被改动：${durations} → ${after.game.duration_seconds}`);

  console.log('\n【2】任天堂游戏：搜索候选与 metacritic 绑定');
  const nintendo = await api('GET', '/api/games/match/search?q=' + encodeURIComponent('宝可梦 紫'));
  const list = nintendo.json ?? [];
  if (list.length >= 5) ok(`「宝可梦 紫」返回 ${list.length} 条候选（原先每个源只有 1 条）`);
  else bad(`候选过少：${list.length} 条`);

  const byProvider = list.reduce((a, c) => ((a[c.provider] = (a[c.provider] ?? 0) + 1), a), {});
  console.log('     按来源分布：' + JSON.stringify(byProvider));
  if (Object.values(byProvider).some((n) => n > 1)) ok('至少一个数据源提供了多条候选');
  else bad('每个数据源仍只返回 1 条');

  const mcNames = list.filter((c) => c.provider === 'metacritic').map((c) => c.name);
  if (mcNames.length) console.log('     metacritic 候选：' + mcNames.slice(0, 4).join(' | '));

  const met = list.find((c) => c.provider === 'metacritic' && /violet/i.test(c.name));
  if (!met) {
    hint('本轮搜索结果里没有 metacritic 的 Pokemon Violet 候选（代理波动），跳过绑定断言');
  } else {
    const bind = await api('POST', `/api/games/${id}/match`, { provider: 'metacritic', externalId: met.externalId });
    if (bind.status === 200 || bind.status === 201) {
      ok(`metacritic 条目绑定成功（原先必失败）：${met.externalId} → 「${bind.json?.name}」`);
    } else {
      bad(`metacritic 绑定仍失败 HTTP ${bind.status}: ${bind.text.slice(0, 200)}`);
    }
    const rating = sql(`out.g = db.prepare('SELECT ratings FROM games WHERE id = ?').get(${JSON.stringify(id)});`);
    const rs = rating ? JSON.parse(rating.g.ratings || '[]') : [];
    const mc2 = rs.find((r) => r.source === 'metacritic');
    if (mc2 && typeof mc2.metascore === 'number') ok(`任天堂游戏拿到评分：Metascore ${mc2.metascore}（${mc2.criticCount ?? '?'} 家媒体）`);
    else hint('本次未写入 metacritic 评分（代理波动），可在详情页手动刷新重试');
  }

  console.log('\n【3】绑定失败提示：含原因与可试关键词');
  const failRes = await api('POST', `/api/games/${id}/match`, { provider: 'metacritic', externalId: 'this-slug-does-not-exist-99999' });
  if (failRes.status === 400) {
    const msg = failRes.json?.message ?? failRes.text;
    console.log('     提示：' + msg);
    if (/常见原因|已被站点下架/.test(msg)) ok('提示说明了失败原因');
    else bad('提示未说明原因');
    if (/可换个关键词再搜|请换个关键词/.test(msg)) ok('提示给出了可尝试的搜索关键词方向');
    else bad('提示未给出关键词方向');
  } else {
    bad(`预期 400，实际 HTTP ${failRes.status}`);
  }

  console.log(`\n  结果: ${pass} 通过 / ${warned} 提示 / ${fail} 失败\n`);
  // 不用 process.exit()：它会在 stdout 落盘前终止进程，把真正的异常信息吞掉，
  // 只留下一个退出码 1。
  process.exitCode = fail ? 1 : 0;
}

main().catch((e) => {
  console.error('  测试异常:', e.stack || e.message);
  process.exitCode = 1;
});

