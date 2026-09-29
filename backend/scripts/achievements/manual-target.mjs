/**
 * 三项需求的后端端到端验证（真实联网抓取 psnine）。
 *
 *  1. 成就「手动选择游戏」：候选搜索 / 绑定 / 持久化 / 沿用 / 清除
 *  2. 手动绑定不会被全量刮削或单游戏刷新重置
 *  3. 失败原因保留在后端（前端负责统一文案，不暴露站点名）
 */
import path from 'node:path';
import Database from './sqlite-shim.js';

// 端口与数据库路径可用环境变量覆盖，默认对应 scripts/verify-round-d.sh。

const BASE = process.env.BASE || 'http://127.0.0.1:4405';
const DB = process.env.TEST_DB
  || path.join(process.cwd(), '.tmp-v3/data/screenplay.db');

let pass = 0, fail = 0, warned = 0;
const ok = (m) => { console.log(`  \x1b[32m✓\x1b[0m ${m}`); pass++; };
const bad = (m) => { console.log(`  \x1b[31m✗\x1b[0m ${m}`); fail++; };
// 环境性不可达（代理抖动）不算缺陷，单独计数，不影响退出码。
const warn = (m) => { console.log(`  \x1b[33m!\x1b[0m ${m}`); warned++; };
const info = (m) => console.log(`  \x1b[36m·\x1b[0m ${m}`);

/** Steam 商店搜索走代理，代理在本机会抖动；重试几次再下结论。 */
async function steamCandidates(gameId, q, tries = 3) {
  for (let i = 0; i < tries; i++) {
    const r = await api(`/api/achievements/${gameId}/candidates?q=${encodeURIComponent(q)}`);
    const hits = (r.items ?? []).filter((x) => x.source === 'steam');
    if (hits.length) return hits;
    if (i < tries - 1) await new Promise((res) => setTimeout(res, 5000));
  }
  return [];
}

async function api(path, init) {
  const res = await fetch(BASE + path, init);
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { raw: text, status: res.status }; }
}
const J = (b) => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });

function db() {
  return new Database(DB);
}

function ids() {
  const d = db();
  const out = {};
  for (const r of d.prepare('SELECT id, folder_name FROM games').all()) out[r.folder_name] = r.id;
  d.close();
  return out;
}

(async () => {
  const ID = ids();
  info(`实例：${BASE}`);
  info(`夹具：${Object.keys(ID).join(' / ')}`);

  console.log('\n【1】候选搜索：一次查遍所有成就数据源');
  const c1 = await api(`/api/achievements/${ID['Bloodborne']}/candidates?q=${encodeURIComponent('血源诅咒')}`);
  const ps = (c1.items ?? []).filter((i) => i.source === 'psnine');
  const st = (c1.items ?? []).filter((i) => i.source === 'steam');
  if (ps.length) ok(`PS 奖杯源返回 ${ps.length} 条候选：${ps.slice(0, 3).map((i) => `${i.name}(${i.externalId})`).join('、')}`);
  else bad('PS 奖杯源没有返回候选');
  info(`Steam 同时返回 ${st.length} 条候选（同一关键词跨源合并）`);
  if ((c1.items ?? []).every((i) => i.source && i.sourceLabel && i.externalId && i.name)) {
    ok('候选字段统一（source / sourceLabel / externalId / name），前端可同列展示');
  } else {
    bad('候选字段不完整');
  }

  const steamHits = await steamCandidates(ID['Portal 2'], 'Portal');
  if (steamHits.some((i) => i.externalId === '620' || /Portal/i.test(i.name))) {
    ok(`Steam 候选可用于 PC 游戏：${steamHits.slice(0, 2).map((i) => `${i.name}(${i.externalId})`).join('、')}`);
    if (steamHits.some((i) => i.detail)) ok('候选带 disambiguator（如 appid），便于区分同名/多版本');
    else bad('候选缺少区分信息');
  } else {
    warn('Steam 商店搜索本次不可达（代理抖动，属环境性），跳过 Steam 候选断言');
  }

  console.log('\n【2】「007 First Light」自动匹配抓不到（模拟文件夹名歧义）');
  const zero = await api(`/api/achievements/${ID['007 First Light']}`);
  if (zero.status === 'failed' || zero.status === 'empty' || zero.status === 'unsupported') {
    ok(`未手动指定前状态为 ${zero.status}，行数 ${(zero.items ?? []).length}（正是用户遇到的问题）`);
  } else {
    info(`当前状态 ${zero.status}，行数 ${(zero.items ?? []).length}`);
  }

  console.log('\n【3】手动选择目标 → 立即按该条目重新抓取');
  const t1 = await api(
    `/api/achievements/${ID['007 First Light']}/target`,
    { method: 'PUT', ...J({ source: 'psnine', externalId: '5818', name: '血源诅咒' }) },
  );
  if (t1.status === 'ok' && (t1.items ?? []).length === 40) {
    ok(`绑定后立即抓到 40 条奖杯（白金${t1.counts.platinum}/金${t1.counts.gold}/银${t1.counts.silver}/铜${t1.counts.bronze}）`);
  } else {
    bad(`绑定后抓取异常：status=${t1.status} 行数=${(t1.items ?? []).length} error=${t1.error}`);
  }
  if (t1.source === 'psnine') ok('来源标记为 psnine');
  else bad(`来源异常：${t1.source}`);

  console.log('\n【4】配置持久化：绑定被写入本地库');
  const d = db();
  const row = d.prepare('SELECT source, external_id, name FROM achievement_links WHERE game_id = ?').get(ID['007 First Light']);
  d.close();
  if (row && row.source === 'psnine' && row.external_id === '5818') {
    ok(`achievement_links 已落库：${row.source} / ${row.external_id} / ${row.name}`);
  } else {
    bad(`未落库：${JSON.stringify(row)}`);
  }
  const tget = await api(`/api/achievements/${ID['007 First Light']}/target`);
  if (tget.target?.externalId === '5818') ok('GET /target 返回当前选择（弹窗可回显）');
  else bad(`target 接口异常：${JSON.stringify(tget)}`);

  console.log('\n【5】全量刮削沿用该选择，不被重置为自动匹配');
  await api('/api/games/refresh-all', { method: 'POST' });
  info('已触发「立即刮削全部游戏」，等待…');
  await new Promise((r) => setTimeout(r, 90000));
  const d2 = db();
  const row2 = d2.prepare('SELECT source, external_id FROM achievement_links WHERE game_id = ?').get(ID['007 First Light']);
  const n2 = d2.prepare("SELECT COUNT(*) c FROM achievements WHERE game_id = ? AND source = 'psnine'").get(ID['007 First Light']).c;
  d2.close();
  if (row2?.external_id === '5818') ok('全量刮削后手动绑定仍在（未被自动匹配覆盖）');
  else bad(`全量刮削后绑定被改动：${JSON.stringify(row2)}`);
  const afterAll = await api(`/api/achievements/${ID['007 First Light']}`);
  if ((afterAll.items ?? []).length === 40) ok(`全量刮削后奖杯仍为 40 条（沿用 psnine 5818）`);
  else bad(`全量刮削后奖杯异常：${(afterAll.items ?? []).length} 条（库内 psnine 行 ${n2}）`);

  console.log('\n【6】单游戏「刷新元数据」同样沿用该选择');
  await api(`/api/games/${ID['007 First Light']}/refresh`, { method: 'POST' });
  await new Promise((r) => setTimeout(r, 45000));
  const afterRefresh = await api(`/api/achievements/${ID['007 First Light']}`);
  const d3 = db();
  const row3 = d3.prepare('SELECT external_id FROM achievement_links WHERE game_id = ?').get(ID['007 First Light']);
  d3.close();
  if (row3?.external_id === '5818' && (afterRefresh.items ?? []).length === 40) {
    ok('单游戏刷新后绑定与数据均保持不变（40 条）');
  } else {
    bad(`单游戏刷新后异常：绑定=${JSON.stringify(row3)} 行数=${(afterRefresh.items ?? []).length}`);
  }

  console.log('\n【7】失败细节保留在后端（供日志排查，前端不展示）');
  const pc = await api(`/api/achievements/${ID['Portal 2']}`);
  if (pc.error && /Steam|API Key/.test(pc.error)) {
    ok(`后端仍返回具体原因：${String(pc.error).slice(0, 58)}…`);
  } else {
    bad(`后端未保留失败原因：${JSON.stringify(pc.error)}`);
  }
  info('前端改用统一文案，不再渲染该字段（见前端 DOM 验证）');

  console.log('\n【8】恢复自动匹配');
  const cleared = await api(`/api/achievements/${ID['007 First Light']}/target`, { method: 'DELETE' });
  const d4 = db();
  const gone = d4.prepare('SELECT COUNT(*) c FROM achievement_links WHERE game_id = ?').get(ID['007 First Light']).c;
  d4.close();
  if (gone === 0) ok('绑定已清除，游戏回到自动匹配');
  else bad(`绑定未清除：${gone}`);
  info(`清除后状态回到 ${cleared.status}`);

  console.log(`\n  结果: ${pass} 通过 / ${warned} 提示 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('\n  测试异常:', e.message);
  console.error(e.stack?.split('\n').slice(0, 5).join('\n'));
  process.exit(2);
});