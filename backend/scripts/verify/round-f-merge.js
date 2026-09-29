/**
 * 评分完整性 + 时长来源优先级 的单元测试（纯函数，无数据库、无网络）。
 *
 * 直接用 esbuild 打包 `metadata-merge.ts` 后运行：
 *   bash scripts/verify-round-f.sh
 *
 * 背景（对应「问题1 Metacritic 评分偶发丢失」）：
 * Metacritic 对「有用户评分但还没有媒体评分」的页面会解析出
 * `{metascore: null, criticCount: 3, userScore: 8.4}`，而旧的 persist() 是
 * 整个数组替换 —— 于是先前的 93 分被一次这样的抓取抹掉，卡片与详情页的
 * 评分标识随之消失，且只在部分游戏出现。
 */
const M = require('./merge.cjs');

let pass = 0, fail = 0, warned = 0;
const ok = (m) => { console.log(`    \x1b[32m✓\x1b[0m ${m}`); pass++; };
const bad = (m) => { console.log(`    \x1b[31m✗\x1b[0m ${m}`); fail++; };
const group = (m) => console.log(`\n  \x1b[1m${m}\x1b[0m`);

const good = JSON.stringify([
  { source: 'metacritic', metascore: 93, criticCount: 88, userScore: 8.1, userCount: 900 },
]);
const parse = (json) => JSON.parse(json ?? '[]');
const score = (json) => parse(json).find((r) => r.metascore != null)?.metascore ?? null;

// ─────────────────────────────────────────────────────────────────────────
group('【1】无媒体评分的抓取不得抹掉已有评分');

const partial = { source: 'metacritic', metascore: null, criticCount: 3, userScore: 8.4, userCount: 12 };
ok(`先确认这是真实存在的形态：${JSON.stringify(partial)}`);

const merged1 = M.mergeRatings(good, partial);
if (score(merged1) === 93) ok('已有 93 分被保留（旧实现会变成 null，标识消失）');
else bad(`评分被覆盖：${score(merged1)}`);
const m1 = parse(merged1)[0];
if (m1.userScore === 8.4 && m1.criticCount === 3) ok('同时吸收了本次抓到的用户评分与评测数（不是简单丢弃）');
else bad(`本次数据未吸收：${JSON.stringify(m1)}`);
if (m1.metascore === 93) ok('metascore 仍是 93 而不是 null');
else bad(`metascore=${m1.metascore}`);

group('【2】真正的更新仍然会覆盖为最新值');

const newer = { source: 'metacritic', metascore: 88, criticCount: 100, userScore: 7.5, userCount: 50 };
if (score(M.mergeRatings(good, newer)) === 88) ok('新抓到的 88 分会替换旧的 93 分（要求「有新值则更新」）');
else bad('新值没有生效');

group('【3】空/无值数据不得破坏已存评分');

for (const [label, incoming] of [
  ['完全空对象', { source: 'metacritic', metascore: null, criticCount: null, userScore: null, userCount: null }],
  ['undefined', undefined],
  ['null', null],
]) {
  const r = M.mergeRatings(good, incoming);
  if (score(r) === 93) ok(`${label} → 93 分保持`);
  else bad(`${label} → 评分被破坏为 ${score(r)}`);
}

group('【4】没有任何历史数据时正常写入');

const first = M.mergeRatings(null, newer);
if (score(first) === 88) ok('首次写入成功');
else bad('首次写入失败');
if (score(M.mergeRatings(JSON.stringify([]), newer)) === 88) ok('空数组历史也能写入');
else bad('空数组历史写入失败');

group('【5】多个来源互不干扰');

const multi = M.mergeRatings(
  JSON.stringify([{ source: 'metacritic', metascore: 93 }, { source: 'opencritic', metascore: 90 }]),
  { source: 'metacritic', metascore: null, userScore: 9 },
);
const kept = parse(multi).find((r) => r.source === 'opencritic');
if (kept?.metascore === 90) ok('其它来源的条目未被触碰');
else bad('其它来源条目丢失');
if (parse(multi).length === 2) ok('条目数不变（不会重复插入同一来源）');
else bad(`条目数变为 ${parse(multi).length}`);

group('【6】hasMetascore 判定');

if (M.hasMetascore(good)) ok('有分数 → true');
else bad('有分数却判为 false');
if (!M.hasMetascore(JSON.stringify([partial]))) ok('只有用户评分 → false（正是丢失场景的特征）');
else bad('误判为有分数');
if (!M.hasMetascore(null) && !M.hasMetascore('') && !M.hasMetascore('{坏 JSON')) ok('空值/坏 JSON → false，不抛异常');
else bad('空值处理异常');

// ─────────────────────────────────────────────────────────────────────────
group('【7】时长按来源优先级合并，而不是谁先返回谁赢');

const hltb = { mainStoryHours: 23.6, mainExtraHours: 48.6, completionistHours: 95.2, durationSource: 'hltb' };
const rawg = { mainStoryHours: 40.2, durationSource: 'rawg' };

let d = M.mergeDuration(undefined, rawg);
if (d.main_story_hours === 40.2 && d.duration_source === 'rawg') ok('先写入弱源（rawg 平均游玩时长）');
else bad(`弱源写入异常：${JSON.stringify(d)}`);

d = M.mergeDuration(d, hltb);
if (d.main_story_hours === 23.6 && d.duration_source === 'hltb') ok('强源（hltb 主线时长）随后覆盖，与顺序无关');
else bad(`强源未能覆盖：${JSON.stringify(d)}`);
if (d.main_extra_hours === 48.6 && d.completionist_hours === 95.2) ok('多维时长（主线+支线 / 完美通关）一并写入');
else bad('多维时长缺失');

group('【8】弱源只能填空，不能覆盖强源');

d = M.mergeDuration({ main_story_hours: 23.6, main_extra_hours: null, completionist_hours: null, duration_source: 'hltb' },
                    { mainStoryHours: 40.2, mainExtraHours: 60, durationSource: 'rawg' });
if (d.main_story_hours === 23.6) ok('rawg 不能覆盖 hltb 的主线时长');
else bad(`主线被弱源覆盖为 ${d.main_story_hours}`);
if (d.duration_source === 'hltb') ok('来源标记仍为 hltb');
else bad(`来源被改为 ${d.duration_source}`);
if (d.main_extra_hours === 60) ok('但强源缺失的维度由弱源补齐（兜底生效）');
else bad('兜底未生效');

group('【9】空时长不破坏已有数据');

const filled = { main_story_hours: 23.6, main_extra_hours: 48.6, completionist_hours: 95.2, duration_source: 'hltb' };
for (const [label, frag] of [
  ['无时长字段', { summary: 'x' }],
  ['显式 null', { mainStoryHours: null, mainExtraHours: null, completionistHours: null }],
]) {
  const r = M.mergeDuration(filled, frag);
  if (r.main_story_hours === 23.6 && r.duration_source === 'hltb') ok(`${label} → 时长保持不变`);
  else bad(`${label} → 时长被破坏`);
}

console.log(`\n  \x1b[1m结果: ${pass} 通过 / ${warned} 提示 / ${fail} 失败\x1b[0m\n`);
process.exit(fail ? 1 : 0);