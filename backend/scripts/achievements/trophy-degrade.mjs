/**
 * 奖杯「多源降级」验证。
 *
 * 目标：证明数据源策略真的会降级——第一个源失败时自动换下一个，全部失败时给出
 * 明确原因（绝不静默返回空），且成功过的源会被记住、下次优先。
 *
 * 这里注册两个源：一个必定失败的假源（排在最前）+ 真实的 psnine（联网）。
 * 这样既验证了降级逻辑，也验证了 psnine 在真实网络下确实能顶上来。
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { TrophiesService, PsnineTrophySource, HttpService } = require('./trophy.cjs');
const Database = require('./sqlite-shim.js');

let pass = 0, fail = 0;
const ok = (m) => { console.log(`  \x1b[32m✓\x1b[0m ${m}`); pass++; };
const bad = (m) => { console.log(`  \x1b[31m✗\x1b[0m ${m}`); fail++; };

const TROPHY_GAME = 'ps-bb';
const rng = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** 内存库，形状与 DatabaseService 一致。 */
function makeDb() {
  const raw = new Database(':memory:');
  raw.exec(`CREATE TABLE games (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT, platforms TEXT,
    aliases TEXT DEFAULT '[]', achievements_status TEXT, achievements_error TEXT,
    last_achievements_refresh INTEGER, trophy_source TEXT)`);
  raw.exec(`CREATE TABLE achievements (
    id TEXT PRIMARY KEY, game_id TEXT NOT NULL, external_id TEXT, name TEXT NOT NULL,
    description TEXT, icon_url TEXT, global_percent REAL, unlocked INTEGER DEFAULT 0,
    tier TEXT, rarity TEXT, source TEXT, dlc_app_id INTEGER, dlc_name TEXT,
    sort_order INTEGER DEFAULT 0)`);
  return {
    raw,
    run: (sql, params = []) => raw.prepare(sql).run(...params),
    all: (sql, params = []) => raw.prepare(sql).all(...params),
    get: (sql, params = []) => raw.prepare(sql).get(...params),
    prepare: (sql) => raw.prepare(sql),
    close: () => raw.close(),
  };
}

const config = {
  get: (k) => ({
    crawlerMinIntervalMs: 200, crawlerMaxRetries: 0, rawgProxy: '',
    crawlerUserAgent: 'ScreenPlay/0.1 (+test)', trophyPsnineDisabled: false,
  })[k],
};
const recognizer = {
  // 真实实现用 fuse.js；这里取第一个候选即可，重点不在打分。
  fuzzyMatch: (name, list) => (list.length ? { item: list[0], score: 1, ...list[0] } : null),
};

/** 一个永远失败的源，用来验证降级。 */
function failingSource() {
  let attempts = 0;
  return {
    name: 'd7vg',
    label: '二饼（模拟不可达）',
    enabled: true,
    get attempts() { return attempts; },
    async search() {
      attempts++;
      throw new Error('getaddrinfo ENOTFOUND d7vg.com');
    },
    async fetch() {
      attempts++;
      throw new Error('getaddrinfo ENOTFOUND d7vg.com');
    },
  };
}

(async () => {
  const db = makeDb();
  db.run(
    `INSERT INTO games (id, name, platforms) VALUES (?, ?, ?)`,
    [TROPHY_GAME, 'Bloodborne', '["PlayStation 4"]'],
  );

  console.log('\n【1】第一个源不可达时，自动降级到 psnine（真实联网）');
  const http = new HttpService(config);
  const realPsnine = new PsnineTrophySource(config, http);
  // 包一层计数，用来观察「是否真的重新发了网络请求」。
  let psnineCalls = 0;
  const psnine = {
    name: realPsnine.name,
    label: realPsnine.label,
    get enabled() { return realPsnine.enabled; },
    async search(q) { psnineCalls++; return realPsnine.search(q); },
    async fetch(...a) { psnineCalls++; return realPsnine.fetch(...a); },
  };
  console.log(`  已注册数据源：${psnine.name}/${psnine.label}，enabled=${psnine.enabled}`);

  const bad1 = failingSource();
  const svc = new TrophiesService(db, recognizer, [bad1, psnine]);
  const out = await svc.sync(TROPHY_GAME, true);

  if (bad1.attempts > 0) ok(`确实先尝试了排在前面的源（尝试 ${bad1.attempts} 次，全部失败）`);
  else bad('没有尝试排在前面的源——降级顺序未生效');

  if (out.status === 'ok' && out.source === 'psnine') {
    ok(`降级成功：由 ${out.source} 顶上，抓到 ${out.total} 条奖杯`);
  } else {
    bad(`降级失败：status=${out.status} source=${out.source} error=${out.error}`);
  }
  const counts = svc.countsFor(TROPHY_GAME);
  if (counts.total === 40 && counts.platinum === 1 && counts.gold === 7) {
    ok(`分等级统计正确：白金${counts.platinum} 金${counts.gold} 银${counts.silver} 铜${counts.bronze}（共 ${counts.total}）`);
  } else {
    bad(`统计异常：${JSON.stringify(counts)}`);
  }

  console.log('\n【2】成功过的源会被记住（下次优先尝试）');
  const row = db.get('SELECT trophy_source, achievements_status FROM games WHERE id = ?', [TROPHY_GAME]);
  if (row?.trophy_source === 'psnine') ok('trophy_source 已记录为 psnine');
  else bad(`trophy_source 记录异常：${row?.trophy_source}`);
  if (row?.achievements_status === 'ok') ok('achievements_status = ok');
  else bad(`状态异常：${row?.achievements_status}`);

  console.log('\n【3】全部源都失败时，必须给出明确原因（不能静默返回空）');
  const db2 = makeDb();
  db2.run(`INSERT INTO games (id, name, platforms) VALUES (?, ?, ?)`,
    ['ps-x', 'Some PS Game', '["PlayStation 5"]']);
  const badA = failingSource();
  const badB = { ...failingSource(), name: 'jump', label: 'Jump（模拟不可达）' };
  const svc2 = new TrophiesService(db2, recognizer, [badA, badB]);
  const out2 = await svc2.sync('ps-x', true);
  if (out2.status === 'failed') ok('状态为 failed（不是空数组假装的"没有奖杯"）');
  else bad(`状态异常：${out2.status}`);
  if (out2.error && /d7vg|jump|不可达|ENOTFOUND/.test(out2.error)) {
    ok(`失败原因汇总了各源：${out2.error.slice(0, 96)}…`);
  } else {
    bad(`失败原因缺失：${JSON.stringify(out2.error)}`);
  }
  const persisted = db2.get('SELECT achievements_status, achievements_error FROM games WHERE id = ?', ['ps-x']);
  if (persisted?.achievements_status === 'failed' && persisted?.achievements_error) {
    ok('失败状态与原因已落库（重启后前端仍能看到原因）');
  } else {
    bad(`未落库：${JSON.stringify(persisted)}`);
  }
  const n2 = db2.get('SELECT COUNT(*) c FROM achievements WHERE game_id = ?', ['ps-x']).c;
  if (n2 === 0) ok('失败时不写入任何半截数据');
  else bad(`失败时写入了 ${n2} 行`);

  console.log('\n【4】非 PlayStation 平台：返回 unsupported，且不写状态（由调用方决定）');
  const db3 = makeDb();
  db3.run(`INSERT INTO games (id, name, platforms) VALUES (?, ?, ?)`,
    ['pc-1', 'Portal 2', '["PC"]']);
  const svc3 = new TrophiesService(db3, recognizer, [failingSource(), psnine]);
  const out3 = await svc3.sync('pc-1', true);
  if (out3.status === 'unsupported') ok('PC 游戏返回 unsupported');
  else bad(`状态异常：${out3.status}`);
  const row3 = db3.get('SELECT achievements_status FROM games WHERE id = ?', ['pc-1']);
  if (!row3?.achievements_status) {
    ok('未越权写状态——避免把 Steam 的真实失败原因覆盖成「无奖杯源」');
  } else {
    bad(`不应写状态，但写入了：${row3.achievements_status}`);
  }

  console.log('\n【5】同一 PS 游戏换到已记住的源时，不会丢掉另一来源的数据');
  const before = db.get("SELECT COUNT(*) c FROM achievements WHERE game_id = ? AND source = 'psnine'", [TROPHY_GAME]).c;
  db.run(`INSERT INTO achievements (id, game_id, external_id, name, source, unlocked, sort_order)
          VALUES ('ps-bb:steam:X', ?, 'X', '假 Steam 成就', 'steam', 0, 999)`, [TROPHY_GAME]);
  await svc.sync(TROPHY_GAME, true);
  const after = db.get("SELECT COUNT(*) c FROM achievements WHERE game_id = ? AND source = 'psnine'", [TROPHY_GAME]).c;
  const steamLeft = db.get("SELECT COUNT(*) c FROM achievements WHERE game_id = ? AND source = 'steam'", [TROPHY_GAME]).c;
  if (before === after && after === 40) ok(`重复刮取后 psnine 行数不变（${after}）`);
  else bad(`psnine 行数变化：${before} → ${after}`);
  if (steamLeft === 1) ok('steam 来源的行未被误删（多来源互不干扰）');
  else bad(`steam 行被误删：${steamLeft}`);

  console.log('\n【6】TTL 内不重复抓取（增量：省流量、避免被站点限流）');
  const callsBefore = psnineCalls;
  await svc.sync(TROPHY_GAME, false);
  const afterTtl = psnineCalls;
  if (afterTtl === callsBefore) {
    ok('未强制刷新时命中新鲜度（15 天 TTL），一次网络请求都没发');
  } else {
    bad(`TTL 未生效，又发了 ${afterTtl - callsBefore} 次请求`);
  }
  await svc.sync(TROPHY_GAME, true);
  if (psnineCalls > afterTtl) {
    ok(`强制刷新确实重新抓取（发了 ${psnineCalls - afterTtl} 次请求，「重新抓取」按钮有效）`);
  } else {
    bad('强制刷新没有触发重新抓取');
  }

  db.close(); db2.close(); db3.close();
  console.log(`\n  结果: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('\n  测试异常:', e.message);
  console.error(e.stack?.split('\n').slice(0, 6).join('\n'));
  process.exit(2);
});