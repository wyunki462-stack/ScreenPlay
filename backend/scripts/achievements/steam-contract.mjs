/**
 * SteamProvider 契约测试：验证「成就抓取成功路径」。
 *
 * 开发机没有可用的 Steam API Key，无法对真实接口跑成功路径（真实接口只会返回
 * 400/403）。这里用**与 Steam 官方响应同构的报文**喂给真实的 SteamProvider，
 * 验证解析、DLC 归属、排序、维度完整性，以及「全球解锁率接口挂掉时必须降级
 * 而不是整体失败」。报文按 GetSchemaForGame / GetGlobalAchievementPercentagesForApp
 * / appdetails 的官方结构构造。
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { SteamProvider, storeAchievements } = require('./contract.cjs');

// 与 steam.provider.ts 中的常量保持一致（用于让替身按 URL 分派）。
const APP_DETAILS = 'store.steampowered.com/api/appdetails';
const SCHEMA = 'api.steampowered.com/ISteamUserStats/GetSchemaForGame';
const GLOBAL_PCT = 'ISteamUserStats/GetGlobalAchievementPercentagesForApp';
const STORE_SEARCH = 'store.steampowered.com/api/storesearch';

let pass = 0, fail = 0;
const ok = (m) => { console.log(`  \x1b[32m✓\x1b[0m ${m}`); pass++; };
const bad = (m) => { console.log(`  \x1b[31m✗\x1b[0m ${m}`); fail++; };

const APPID = 620;
const DLC_APPID = 441830;

/** 官方 GetSchemaForGame 的响应形状。 */
const schemaFor = (appName, list) => ({
  game: {
    gameName: appName,
    gameVersion: '1',
    availableGameStats: {
      achievements: list.map(([name, displayName, description, icon, hidden]) => ({
        name, defaultvalue: 0, displayName, hidden, description, icon, icongray: icon,
      })),
    },
  },
});

const SCHEMA_BASE = schemaFor('Portal 2', [
  ['ACH_WAKEUP', 'Wake Up Call', '完成第 1 章。', 'https://cdn.akamai.steamstatic.com/steamcommunity/public/images/apps/620/a1.jpg', 0],
  ['ACH_LUNCH', 'Lunacy', '在第 2 章存活。', 'https://cdn.akamai.steamstatic.com/steamcommunity/public/images/apps/620/a2.jpg', 0],
  ['ACH_SECRET', 'Hidden One', '隐藏成就。', 'https://cdn.akamai.steamstatic.com/steamcommunity/public/images/apps/620/a3.jpg', 1],
]);
const SCHEMA_DLC = schemaFor('Portal 2 - Peer Review', [
  ['DLC_CLEAR', 'Peer Review 通关', '完成 Peer Review 全部关卡。', 'https://cdn.akamai.steamstatic.com/steamcommunity/public/images/apps/441830/d1.jpg', 0],
  ['DLC_BONUS', '合作大师', '拿到全部合作奖杯。', 'https://cdn.akamai.steamstatic.com/steamcommunity/public/images/apps/441830/d2.jpg', 0],
]);

const PCT_RESP = {
  achievementpercentages: {
    achievements: [
      { name: 'ACH_WAKEUP', percent: 71.4 },
      { name: 'ACH_LUNCH', percent: 22.35 },
      { name: 'ACH_SECRET', percent: 3.1 },
      { name: 'DLC_CLEAR', percent: 8.8 },
      { name: 'DLC_BONUS', percent: 4.2 },
      { name: 'NOT_IN_SCHEMA', percent: 99 },
    ],
  },
};

const APP_DETAILS_RESP = {
  [APPID]: {
    success: true,
    data: {
      type: 'game', name: 'Portal 2', steam_appid: APPID,
      short_description: 'test', developers: ['Valve'], publishers: ['Valve'],
      release_date: { coming_soon: false, date: '2011年4月19日' },
      platforms: { windows: true, mac: false, linux: true },
      dlc: [DLC_APPID],
    },
  },
};

/** 可编程的 HttpService 替身：按 URL 决定返回什么。 */
function makeHttp(handlers) {
  const calls = [];
  return {
    calls,
    async get(url, options) {
      calls.push({ url, params: options?.params });
      for (const [frag, fn] of Object.entries(handlers)) {
        if (url.includes(frag)) {
          const out = fn(url, options);
          if (out instanceof Error) throw out;
          return { data: out };
        }
      }
      throw new Error(`未预期的请求：${url}`);
    },
  };
}

const config = { get: (k) => (k === 'cacheTtlAchievementsSeconds' ? 0 : '') };
const recognizer = {
  fuzzyMatch: (name, list, keyFn) => (list.length ? { ...list[0], score: 1, item: list[0] } : null),
};

function makeProvider(http, settings) {
  return new SteamProvider(config, http, recognizer, settings);
}

const settingsWithKey = { getApiKeys: () => ({ steamApiKey: 'TESTKEY' }) };

(async () => {
  console.log('\n【1】成功路径：本体 + DLC 成就全量解析');
  const http = makeHttp({
    [APP_DETAILS]: () => APP_DETAILS_RESP,
    [SCHEMA]: (url, o) => (String(o?.params?.appid) === String(DLC_APPID) ? SCHEMA_DLC : SCHEMA_BASE),
    [GLOBAL_PCT]: () => PCT_RESP,
    [STORE_SEARCH]: () => ({ total: 0, items: [] }),
  });
  const p = makeProvider(http, settingsWithKey);
  const frag = await p.fetch({ externalId: String(APPID), name: 'Portal 2', platform: 'PC', releaseYear: 2011 });

  if (frag.achievementsError) bad(`不应报错，但得到：${frag.achievementsError}`);
  else ok('刮取成功（无错误）');

  const a = frag.achievements ?? [];
  if (a.length === 5) ok(`共解析 ${a.length} 条（本体 3 + DLC 2）`);
  else bad(`条数异常：${a.length}（期望 5）`);

  console.log('\n【2】五个维度：名称 / 描述 / 图标 / 解锁条件 / 全球解锁率');
  const need = ['name', 'description', 'iconUrl', 'globalPercent'];
  for (const k of need) {
    const have = a.filter((x) => x[k] !== null && x[k] !== undefined && x[k] !== '').length;
    if (have === a.length) ok(`「${k}」全部齐全（${have}/${a.length}）`);
    else bad(`「${k}」缺失 ${a.length - have} 条`);
  }
  const first = a.find((x) => x.name === 'Wake Up Call');
  if (first?.globalPercent === 71.4) ok(`全球解锁率数值正确（Wake Up Call = 71.4%）`);
  else bad(`解锁率错误：${JSON.stringify(first?.globalPercent)}`);
  if (first?.unlocked === false) ok('解锁条件字段 unlocked=false（本地尚未解锁）');
  else bad(`unlocked 异常：${first?.unlocked}`);
  const hiddenAch = a.find((x) => x.name === 'Hidden One');
  if (hiddenAch) ok('隐藏成就也被抓取（需要隐藏标记被忽略，成就本身保留）');
  else bad('隐藏成就丢失');

  console.log('\n【3】DLC 成就识别与归属');
  const dlcRows = a.filter((x) => x.dlcAppId);
  if (dlcRows.length === 2) ok(`2 条成就归属到 DLC（appid ${DLC_APPID}）`);
  else bad(`DLC 成就数异常：${dlcRows.length}`);
  if (dlcRows.every((x) => String(x.dlcAppId) === String(DLC_APPID))) ok('DLC appid 正确');
  else bad('DLC appid 错误');
  if (dlcRows.some((x) => /Peer Review/.test(x.dlcName ?? ''))) {
    ok(`DLC 名称取自子 schema（${dlcRows.find((x) => x.dlcName)?.dlcName}）`);
  } else {
    bad(`DLC 名称为空：${JSON.stringify(dlcRows.map((x) => x.dlcName))}`);
  }
  const baseRows = a.filter((x) => !x.dlcAppId);
  if (baseRows.length === 3 && baseRows.every((x) => x.dlcAppId === null || x.dlcAppId === undefined)) {
    ok('本体成就未被误标为 DLC');
  } else {
    bad(`本体成就标记异常：${baseRows.length} 条`);
  }
  if (a.every((x) => x.source === 'steam')) ok('全部条目标记 source=steam');
  else bad('source 标记异常');
  const orders = a.map((x) => x.sortOrder);
  if (new Set(orders).size === orders.length) ok('sortOrder 唯一（可稳定排序）');
  else bad(`sortOrder 有重复：${orders.join(',')}`);
  const schemaCalls = http.calls.filter((c) => c.url.includes('GetSchemaForGame'));
  if (schemaCalls.length === 2) ok('分别请求了本体与 DLC 两个 schema');
  else bad(`schema 请求次数异常：${schemaCalls.length}`);

  console.log('\n【4】全球解锁率接口挂掉时必须降级（不能整体失败）');
  const http2 = makeHttp({
    [APP_DETAILS]: () => APP_DETAILS_RESP,
    [SCHEMA]: (url, o) => (String(o?.params?.appid) === String(DLC_APPID) ? SCHEMA_DLC : SCHEMA_BASE),
    [GLOBAL_PCT]: () => new Error('socket disconnected before secure TLS connection'),
    [STORE_SEARCH]: () => ({ total: 0, items: [] }),
  });
  const frag2 = await makeProvider(http2, settingsWithKey).fetch({
    externalId: String(APPID), name: 'Portal 2', platform: 'PC', releaseYear: 2011,
  });
  const a2 = frag2.achievements ?? [];
  if (!frag2.achievementsError && a2.length === 5) {
    ok(`解锁率接口失败但成就仍全部保留（${a2.length} 条）——名称/描述/图标不受影响`);
  } else {
    bad(`未降级：error=${frag2.achievementsError} 条数=${a2.length}`);
  }
  if (a2.every((x) => x.globalPercent === null)) ok('这些条目的 globalPercent 为 null（界面显示为「—」而不是坏数据）');
  else bad('globalPercent 未按预期置空');

  console.log('\n【5】Schema 失败必须上报原因（旧实现会静默为空）');
  const http3 = makeHttp({
    [APP_DETAILS]: () => APP_DETAILS_RESP,
    [SCHEMA]: () => new Error('Request failed with status code 403'),
    [GLOBAL_PCT]: () => PCT_RESP,
    [STORE_SEARCH]: () => ({ total: 0, items: [] }),
  });
  const frag3 = await makeProvider(http3, settingsWithKey).fetch({
    externalId: String(APPID), name: 'Portal 2', platform: 'PC', releaseYear: 2011,
  });
  if (frag3.achievementsError && /403/.test(frag3.achievementsError)) {
    ok(`失败原因已上报：${frag3.achievementsError.slice(0, 72)}…`);
  } else {
    bad(`未上报失败原因：${JSON.stringify(frag3.achievementsError)}`);
  }
  if ((frag3.achievements ?? []).length === 0) ok('失败时不写入半截成就数据');
  else bad('失败时仍写入了部分数据');

  console.log('\n【6】未配置 Key 时必须明确提示（不能悄悄返回空）');
  const noKeyHttp = makeHttp({
    [APP_DETAILS]: () => APP_DETAILS_RESP,
    [STORE_SEARCH]: () => ({ total: 0, items: [] }),
    [SCHEMA]: () => new Error('不应被调用（无 Key 时不该发请求）'),
  });
  const frag4 = await makeProvider(noKeyHttp, { getApiKeys: () => ({}) }).fetch({
    externalId: String(APPID), name: 'Portal 2', platform: 'PC', releaseYear: 2011,
  });
  if (frag4.achievementsError && /API Key/.test(frag4.achievementsError)) {
    ok(`提示明确：${frag4.achievementsError.slice(0, 60)}…`);
  } else {
    bad(`未提示 Key 缺失：${JSON.stringify(frag4.achievementsError)}`);
  }

  console.log('\n【7】落库 + 增量：同一批数据反复写入不产生重复行');
  const Database = require('./sqlite-shim.js');
  const raw = new Database(':memory:');
  // storeAchievements 接收的是 DatabaseService（有 run/all/get + raw 访问器），
  // 不是裸驱动句柄——这里复刻同样的形状。
  const db = {
    raw,
    run: (sql, params = []) => raw.prepare(sql).run(...params),
    all: (sql, params = []) => raw.prepare(sql).all(...params),
    get: (sql, params = []) => raw.prepare(sql).get(...params),
    // 方便测试自身直接查库（DatabaseService 无此方法，仅测试用）
    prepare: (sql) => raw.prepare(sql),
  };
  raw.exec(`CREATE TABLE achievements (
    id TEXT PRIMARY KEY, game_id TEXT NOT NULL, external_id TEXT, name TEXT NOT NULL,
    description TEXT, icon_url TEXT, global_percent REAL, unlocked INTEGER DEFAULT 0,
    tier TEXT, rarity TEXT, source TEXT, dlc_app_id INTEGER, dlc_name TEXT,
    sort_order INTEGER DEFAULT 0)`);
  storeAchievements(db, 'g1', 'steam', a);
  const n1 = db.prepare('SELECT COUNT(*) c FROM achievements').get().c;
  storeAchievements(db, 'g1', 'steam', a);
  storeAchievements(db, 'g1', 'steam', a);
  const n2 = db.prepare('SELECT COUNT(*) c FROM achievements').get().c;
  if (n1 === 5 && n2 === 5) ok(`3 次写入后仍为 5 行（增量更新，无重复）`);
  else bad(`增量异常：${n1} → ${n2}`);
  const dlcStored = db.prepare('SELECT COUNT(*) c FROM achievements WHERE dlc_app_id IS NOT NULL').get().c;
  if (dlcStored === 2) ok('DLC 归属已持久化到本地库');
  else bad(`DLC 持久化异常：${dlcStored}`);
  const pct = db.prepare("SELECT global_percent p FROM achievements WHERE name = 'Wake Up Call'").get().p;
  if (pct === 71.4) ok('全球解锁率已持久化');
  else bad(`解锁率持久化异常：${pct}`);
  // 更新场景：Steam 端删掉一个成就，重新刮取应当同步删除
  storeAchievements(db, 'g1', 'steam', a.slice(0, 3));
  const n3 = db.prepare('SELECT COUNT(*) c FROM achievements').get().c;
  if (n3 === 3) ok('上游删除的成就会被清理（本来源增量同步正确）');
  else bad(`清理异常：${n3}（期望 3）`);
  raw.close();

  console.log(`\n  结果: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('\n  测试异常:', e.message);
  console.error(e.stack?.split('\n').slice(0, 6).join('\n'));
  process.exit(2);
});