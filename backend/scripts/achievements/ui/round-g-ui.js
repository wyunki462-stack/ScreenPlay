/**
 * 需求2：拖拽排序的视觉反馈与可拖拽属性（真实 DOM）。
 */
const path = require('path');
process.env.TEST_DB = process.env.TEST_DB || path.join(__dirname, '..', '..', '..', '..', '.tmp-round-g', 'data', 'screenplay.db');
require('./setup.cjs');
const { render, act, cleanup } = require('@testing-library/react');
const React = require('react');
const { cardPlain, cardWithDrag } = require('./out-g.cjs');

let pass = 0, fail = 0;
const ok = (m) => { console.log(`    \x1b[32m✓\x1b[0m ${m}`); pass++; };
const bad = (m) => { console.log(`    \x1b[31m✗\x1b[0m ${m}`); fail++; };
const settle = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 200)); }); };
const root = () => document.querySelector('.group');

(async () => {
  // 1) 非自定义模式：卡片不可拖拽
  cleanup();
  render(cardPlain());
  await settle();
  if (root()?.getAttribute('draggable') !== 'true') ok('非自定义排序模式下卡片不可拖拽');
  else bad('普通模式下卡片仍可拖拽，会干扰正常操作');
  if (!root()?.className.includes('cursor-grab')) ok('普通模式下不显示抓取光标');
  else bad('普通模式显示了抓取光标');

  // 2) 自定义模式：可拖拽 + 抓取光标
  cleanup();
  render(cardWithDrag({}));
  await settle();
  if (root()?.getAttribute('draggable') === 'true') ok('「自定义排序」模式下卡片可拖拽');
  else bad('自定义模式下卡片不可拖拽');
  if (root()?.className.includes('cursor-grab')) ok('显示抓取光标（可拖拽的视觉提示）');
  else bad('缺少抓取光标');
  if (document.querySelector('a')?.getAttribute('draggable') === 'false') ok('内部链接已禁用原生拖拽，避免拖走链接');
  else bad('内部链接未禁用原生拖拽');

  // 3) 拖拽中：占位符（淡出 + 虚线框）
  cleanup();
  render(cardWithDrag({ dragging: true }));
  await settle();
  const draggingCls = root()?.className || '';
  if (draggingCls.includes('opacity-40')) ok('拖拽中的卡片淡出，形成占位符效果');
  else bad('拖拽中的卡片缺少占位符样式');
  if (draggingCls.includes('[&>a]:border-dashed')) ok('占位符使用虚线边框');
  else bad('占位符缺少虚线边框');

  // 4) 落点：高亮指示条
  for (const side of ['before', 'after']) {
    cleanup();
    render(cardWithDrag({ dropSide: side }));
    await settle();
    const bar = root()?.querySelector('span[aria-hidden]');
    if (bar && bar.className.includes('bg-violet-500')) ok(`落点指示条（${side}）已渲染并高亮`);
    else bad(`缺少 ${side} 落点指示条`);
    if (root()?.className.includes('ring-2')) ok(`落点卡片有高亮描边（${side}）`);
    else bad(`落点卡片缺少高亮描边（${side}）`);
  }

  // 5) 深色主题一致性
  cleanup();
  render(cardPlain());
  await settle();
  if (document.querySelector('a')?.className.includes('bg-zinc-900/60')) ok('卡片沿用原有深色主题样式');
  else bad('卡片主题样式被改动');

  console.log(`\n    结果: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('    测试异常:', e.message); process.exit(1); });
