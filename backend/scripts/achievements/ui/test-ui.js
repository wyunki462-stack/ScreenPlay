/**
 * 三项需求的前端真实 DOM 验证。
 *
 * 渲染真实的 GameCard / GameDetail 组件，数据来自真实的本地后端，
 * 因此验证的是「后端 → 前端 → 屏幕」整条链路。
 */
const path = require('path');
process.env.TEST_DB = process.env.TEST_DB || path.join(__dirname, '..', '..', '..', '..', '.tmp-v3', 'data', 'screenplay.db');
require('./setup.cjs');
const { render, screen, fireEvent, act, cleanup } = require('@testing-library/react');
const { detailTree, cardTree } = require('./out.cjs');

const BASE = global.__BASE__;
let pass = 0, fail = 0;
const ok = (m) => { console.log(`  \x1b[32m✓\x1b[0m ${m}`); pass++; };
const bad = (m) => { console.log(`  \x1b[31m✗\x1b[0m ${m}`); fail++; };
const info = (m) => console.log(`  \x1b[36m·\x1b[0m ${m}`);

const text = () => document.body.textContent || '';
const buttons = () => Array.from(document.querySelectorAll('button'));

async function until(label, fn, ms = 20000) {
  const t0 = Date.now();
  for (;;) {
    if (fn()) return true;
    if (Date.now() - t0 > ms) throw new Error(`超时：${label}`);
    await act(async () => { await new Promise((r) => setTimeout(r, 80)); });
  }
}
async function waitBtn(re) {
  let el = null;
  await until(`按钮 ${re}`, () => { el = buttons().find((b) => re.test(b.textContent || '')); return !!el; });
  return el;
}
const click = async (el) => { await act(async () => { fireEvent.click(el); }); };

(async () => {
  const games = await (await fetch(`${BASE}/api/games?pageSize=20`)).json();
  const bb = games.find((g) => g.name === 'Bloodborne') || games[0];
  const pc = games.find((g) => g.name === 'Portal 2') || games[1];
  info(`夹具：${games.map((g) => g.name).join(' / ')}`);

  // =========================================================================
  console.log('\n【A】游戏卡片 16:9 横向比例');
  cleanup();
  render(cardTree({
    id: bb.id, name: bb.name, posterUrl: '/api/media/c4478fd6-0336-5f95-a4f1-2c4957802bd9/thumbnail', posters: [], posterMode: 'static',
    platforms: ['PlayStation 4'], platform: null, durationText: '12 小时', mediaCount: 2,
    metacriticScore: 92, metacriticCriticCount: 70, customPlatform: true, metaError: null,
  }));
  await act(async () => { await new Promise((r) => setTimeout(r, 300)); });

  const ratioNode = document.querySelector('.aspect-video');
  if (ratioNode) ok('卡片封面容器使用 aspect-video（16:9）');
  else bad('卡片封面容器未使用 16:9');
  const legacy = document.querySelector('.aspect-\\[2\\/3\\]');
  if (!legacy) ok('卡片中已无 2:3 竖版比例残留');
  else bad('仍有 2:3 竖版容器');

  const imgs = Array.from(document.querySelectorAll('img'));
  if (imgs.length === 0) {
    bad('卡片未渲染任何封面图片（无法验证裁切方式）');
  } else {
    const cls = imgs[0].className;
    if (/object-cover/.test(cls) && /object-center/.test(cls)) {
      ok(`真实封面图使用 object-cover + object-center（居中裁切、不拉伸变形）：${imgs[0].getAttribute('src')?.slice(0, 44)}…`);
    } else {
      bad(`封面图裁切样式不正确：${cls}`);
    }
    if (/h-full/.test(cls) && /w-full/.test(cls)) ok('封面图填满 16:9 容器（配合 cover 裁切）');
    else bad('封面图未填满容器');
  }
  const cardText = text();
  for (const label of [bb.name, 'PlayStation 4', '12 小时', '2']) {
    if (cardText.includes(label)) ok(`横向卡片信息可见：${label}`);
    else bad(`横向卡片信息缺失：${label}`);
  }
  // 信息在图片下方（DOM 顺序），因此不遮挡海报主体
  const cardLink = document.querySelector('a[href^="/game/"]');
  if (cardLink) {
    const kids = Array.from(cardLink.children);
    const ratioIdx = kids.findIndex((k) => k.className.includes('aspect-video'));
    const infoIdx = kids.findIndex((k) => k.className.includes('flex-1'));
    if (ratioIdx >= 0 && infoIdx > ratioIdx) {
      ok('标题/平台/时长信息位于海报下方（与图片不重叠，不遮挡画面主体）');
    } else {
      bad(`信息层叠顺序异常：ratio=${ratioIdx} info=${infoIdx}`);
    }
  }

  // =========================================================================
  console.log('\n【B】成就失败提示：统一文案且不暴露数据源站点名');
  // 让这台测试实例回到「自动匹配 + Steam 无 Key」的失败态：
  // 上一次运行可能已通过弹窗给它绑定过奖杯目标。
  // 稳定构造「抓取失败」态：给 PC 夹具手动指定一个 Steam 目标。
  // 本机没有 Steam API Key，抓取必然失败（成功路径无法伪造）。
  // 不能依赖自动匹配 —— 没匹配上时压根没有 binding，状态会落到 unsupported。
  await fetch(`${BASE}/api/achievements/${pc.id}/target`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source: 'steam', externalId: '620', name: 'Portal 2' }),
  });
  const pcState = await (await fetch(`${BASE}/api/achievements/${pc.id}`)).json();
  info(`PC 夹具当前状态：${pcState.status}${pcState.error ? ' / ' + String(pcState.error).slice(0, 40) + '…' : ''}`);
  if (pcState.status !== 'failed') {
    info('预期 failed 才能验证失败文案；若不是，下面的断言会失败并说明原因');
  }
  cleanup();
  render(detailTree(pc.id));
  await until('详情页', () => buttons().some((b) => /手动匹配|媒体/.test(b.textContent || '')));
  await click(await waitBtn(/^成就$/));
  await until('失败提示', () => /加载成就失败/.test(text()));

  if (text().includes('加载成就失败')) ok('主标题为「加载成就失败」');
  else bad('主标题不正确');
  const hint = '当前游戏成就数据暂不可用，请尝试手动选择游戏或稍后重试';
  if (text().includes(hint)) ok(`说明文案统一：「${hint}」`);
  else bad('说明文案与要求不一致');

  const leaks = ['psnine', 'PSNINE', 'api.steampowered', 'Steam API Key', 'GetSchemaForGame'];
  const found = leaks.filter((s) => text().includes(s));
  if (found.length === 0) ok('界面未暴露任何数据源站点名或接口细节');
  else bad(`界面泄露了技术细节：${found.join(', ')}`);

  // =========================================================================
  console.log('\n【C】「手动选择游戏」弹窗：搜索 → 选定 → 重新抓取');
  const target = await waitBtn(/手动选择游戏/);
  if (target) ok('成就标签页存在「手动选择游戏」入口');
  else bad('找不到「手动选择游戏」入口');
  await click(target);

  const input = document.querySelector('input[placeholder]');
  if (input && /搜索/.test(input.placeholder)) ok(`弹窗已打开，搜索框提示：「${input.placeholder}」`);
  else bad('弹窗未打开或搜索框缺失');
  if (/自动匹配依据文件夹名推断/.test(text())) ok('弹窗含说明（解释为何需要手动指定）');
  else bad('弹窗缺少说明文案');

  const keyword = '血源诅咒';
  await act(async () => {
    fireEvent.change(input, { target: { value: keyword } });
  });
  await until('候选出现', () => /血源诅咒/.test(text()), 30000);
  const candBtn = buttons().find((b) => /血源诅咒/.test(b.textContent || ''));
  if (candBtn) {
    ok(`搜索「${keyword}」返回候选：${(candBtn.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 46)}`);
  } else {
    bad('搜索结果里没有可点选的候选');
  }
  if (/PSNINE|psnine/.test(candBtn?.textContent || '')) {
    info('候选副标题标注来源（弹窗内用于区分，不属于失败提示）');
  }

  await click(candBtn);
  const confirm = await waitBtn(/确认并重新抓取/);
  if (confirm) ok('选定后可点「确认并重新抓取」');
  else bad('找不到确认按钮');
  await click(confirm);
  await until('应用完成', () => /已应用|应用失败/.test(text()), 90000);
  if (/已应用/.test(text())) ok('应用成功，弹窗给出成功提示');
  else bad('应用未成功');

  await click(buttons().find((b) => /^关闭$|^Close$/.test((b.textContent || '').trim())) || buttons().find((b) => /关闭|Close/.test(b.textContent || '')));
  await until('弹窗关闭', () => !/为「/.test(text()), 15000);

  await until('奖杯列表刷新', () => /全球达成率|白金/.test(text()), 30000);
  if (/共 40 个/.test(text())) ok('关闭弹窗后成就标签页已实时刷新为 40 条奖杯');
  else bad('成就标签页未刷新出新数据');
  if (/白金1|白金 1/.test(text())) ok('分等级统计同步更新（白金 1）');
  else bad('分等级统计未更新');

  cleanup();
  console.log(`\n  结果: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('\n  测试异常:', e.message);
  console.error(e.stack?.split('\n').slice(0, 6).join('\n'));
  process.exit(2);
});