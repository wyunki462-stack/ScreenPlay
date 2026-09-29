/**
 * 需求1：进入详情页默认从顶部开始（window.scrollTo 被调用）
 * 需求2：顶部有「上一个 / 下一个」按钮，标题带邻居游戏名
 *
 * 用真实组件 + 打桩的网络层渲染，断言的是用户真正看到的 DOM 与真实调用。
 */
const path = require('path');
process.env.TEST_DB = process.env.TEST_DB || path.join(__dirname, '..', '..', '..', '..', '.tmp-round-k', 'data', 'screenplay.db');
require('./setup.cjs');
const { render, act, cleanup, fireEvent } = require('@testing-library/react');
const React = require('react');
const { detailPage } = require('./out-k.cjs');

let pass = 0, fail = 0;
const ok = (m) => { console.log(`    \x1b[32m✓\x1b[0m ${m}`); pass++; };
const bad = (m) => { console.log(`    \x1b[31m✗\x1b[0m ${m}`); fail++; };
const settle = async (ms = 400) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); };

const GAME = {
  id: 'g2', name: 'Hades', folderName: 'Hades', platform: 'PC', platforms: ['PC'],
  posterUrl: '', posters: [], posterMode: 'static', posterList: [], knownPlatforms: [],
  mediaCount: 0, durationSeconds: 0, durationText: '未知', metacriticScore: 93,
  metacriticCriticCount: 88, metaError: null, firstPlayedAt: null, lastPlayedAt: null,
  mainStoryHours: 23.6, mainPlusExtraHours: 48.6, completionistHours: 95.2,
  durationSource: 'hltb', ratings: [], prices: [], screenshots: [], summary: '', genres: [],
  developers: [], publishers: [], releaseDate: null, voiceActors: [], customPlatform: false,
  achievements: null,
};
const NEIGHBORS = {
  prev: { id: 'g1', name: 'Astro Bot' },
  next: { id: 'g3', name: 'Bloodborne' },
  index: 4, total: 12,
};

let scrollCalls = [];
const seen = [];
global.fetch = async (url) => {
  const u = String(url);
  seen.push(u);
  const json = (data) => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) });
  if (u.includes('/neighbors')) return json(NEIGHBORS);
  if (u.includes('/media')) return json([]);
  if (/\/api\/games\/[^/?]+$/.test(u)) return json(GAME);
  if (u.includes('/api/games')) return json([GAME]);
  if (u.includes('/achievements')) return json({ status: 'empty', achievements: [], links: [] });
  return json({});
};
window.scrollTo = (...args) => { scrollCalls.push(args[0] ?? args); };
// jsdom 默认 scrollTo 是 not-implemented，必须在上面的赋值之后重新绑定
Object.defineProperty(window, 'scrollTo', { value: window.scrollTo, writable: true });

(async () => {
  cleanup();
  scrollCalls = [];
  render(detailPage('/game/g2'));
  await settle();

  // 需求1：进入即置顶
  const called = scrollCalls.some((c) => (typeof c === 'object' ? c.top === 0 : c === 0));
  if (called) ok('进入详情页时调用了 window.scrollTo 置顶');
  else bad(`进入详情页未置顶（调用：${JSON.stringify(scrollCalls)}）`);

  const body = document.body.textContent || '';
  if (body.includes('Hades')) ok('详情页正常渲染出游戏名');
  else bad('详情页未渲染出游戏名');

  // 需求2：导航按钮
  const buttons = Array.from(document.querySelectorAll('button'));
  const prev = buttons.find((b) => (b.textContent || '').trim() === '上一个');
  const next = buttons.find((b) => (b.textContent || '').trim() === '下一个');
  if (prev) ok('存在「上一个」按钮');
  else bad(`缺少「上一个」按钮（按钮：${buttons.map((b) => b.textContent.trim()).slice(0, 8).join('/')}）`);
  if (next) ok('存在「下一个」按钮');
  else bad('缺少「下一个」按钮');

  if (prev?.getAttribute('title')?.includes('Astro Bot')) ok('「上一个」的提示带真实邻居名：Astro Bot');
  else bad(`「上一个」提示异常：${prev?.getAttribute('title')}`);
  if (next?.getAttribute('title')?.includes('Bloodborne')) ok('「下一个」的提示带真实邻居名：Bloodborne');
  else bad(`「下一个」提示异常：${next?.getAttribute('title')}`);

  if (/第 5 \/ 12 个/.test(body)) ok('显示了在当前排序中的位置（第 5 / 12 个）');
  else bad('缺少位置指示');

  // 位置合理：按钮在标题之上，不遮挡标题
  const h1 = document.querySelector('h1');
  if (h1 && prev && (prev.compareDocumentPosition(h1) & Node.DOCUMENT_POSITION_FOLLOWING)) {
    ok('导航按钮位于游戏标题之前，不遮挡标题');
  } else {
    bad('导航按钮与标题的相对位置异常');
  }

  // 点击「下一个」应产生跳转（地址变化 → 组件重新取数）
  if (next) {
    scrollCalls = [];
    await act(async () => { fireEvent.click(next); });
    await settle();
    if (scrollCalls.some((c) => (typeof c === 'object' ? c.top === 0 : c === 0))) {
      ok('点击切换后再次置顶（切换游戏也从顶部开始）');
    } else {
      bad('切换游戏后未置顶');
    }
  }

  // 深色主题一致性。
  // 本轮把按钮从「藏在右上角按钮堆里的 zinc-900 小胶囊」改成标题上方独立一行的
  // zinc-700/800 按钮：原来的样式虽然同属深色主题，但在页面上几乎看不见（验收时
  // 被判定为「功能不可见」）。断言随之改为校验新的深色配色，而不是放宽要求。
  if (prev?.className.includes('bg-zinc-800') && prev?.className.includes('border-zinc-700')) {
    ok('导航按钮沿用深色主题样式（zinc-700/800）');
  } else {
    bad(`导航按钮样式与主题不一致：${prev?.className ?? 'n/a'}`);
  }

  if (fail) console.log('    请求过的 URL: ' + [...new Set(seen)].join(' | '));
  console.log(`\n    结果: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('    测试异常:', e.message); process.exit(1); });
