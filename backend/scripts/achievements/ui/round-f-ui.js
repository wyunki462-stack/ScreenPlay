/**
 * 问题2：评分手动选择弹窗的 DOM 验证。
 *
 * 用真实组件渲染，校验入口文案、搜索框、底部按钮与深色主题类名，
 * 而不是只读 i18n 字典 —— 用户看到的是渲染结果。
 */
const path = require('path');
process.env.TEST_DB =
  process.env.TEST_DB || path.join(__dirname, '..', '..', '..', '..', '.tmp-round-f', 'data', 'screenplay.db');
require('./setup.cjs');
const { render, act, cleanup, fireEvent } = require('@testing-library/react');
const React = require('react');
const { ratingDialogTree } = require('./out-f.cjs');

let pass = 0, fail = 0;
const ok = (m) => { console.log(`    \x1b[32m✓\x1b[0m ${m}`); pass++; };
const bad = (m) => { console.log(`    \x1b[31m✗\x1b[0m ${m}`); fail++; };

(async () => {
  cleanup();
  let closed = false;
  render(ratingDialogTree({ gameId: 'ui-fixture', gameName: 'Hades', onClose: () => { closed = true; } }));
  await act(async () => { await new Promise((r) => setTimeout(r, 400)); });

  const title = document.querySelector('h3')?.textContent || '';
  if (title.includes('选择 M站 评分') && title.includes('Hades')) ok(`标题正确：${title}`);
  else bad(`标题异常：${title || '(空)'}`);

  const input = document.querySelector('input');
  if (input) ok(`搜索框存在，提示为「${input.getAttribute('placeholder')}」`);
  else bad('没有搜索框');

  const body = document.body.textContent || '';
  if (/不同平台|各平台|平台/.test(body)) ok('说明了「同一游戏不同平台评分不同」的原因');
  else bad('缺少平台差异的说明文案');
  // 状态行有三种可能：已手动选择 / 当前自动匹配 N 分 / 暂时没有可用评分。
  // 夹具的 gameId 不存在，因此这里走的是第三种。
  if (/当前手动选择|自动匹配|没有可用的/.test(body)) ok('显示了当前的评分来源状态');
  else bad('缺少当前状态说明');

  const btns = Array.from(document.querySelectorAll('button')).map((b) => b.textContent || '');
  if (btns.some((t) => /使用该评分/.test(t))) ok('底部有「使用该评分」按钮');
  else bad(`缺少确认按钮（现有：${btns.join(' / ')}）`);
  if (btns.some((t) => /关闭|Close/.test(t))) ok('底部有「关闭」按钮');
  else bad('缺少关闭按钮');

  // 未选中条目时确认按钮必须禁用，避免提交空选择
  const confirm = Array.from(document.querySelectorAll('button')).find((b) => /使用该评分/.test(b.textContent || ''));
  if (confirm?.disabled) ok('未选择条目时「使用该评分」为禁用状态');
  else bad('未选择条目时确认按钮可点击');

  // 「恢复自动匹配」只在已有手动选择时出现，此处应隐藏
  if (!btns.some((t) => /恢复自动匹配/.test(t))) ok('尚未手动选择时不显示「恢复自动匹配」');
  else bad('不该出现「恢复自动匹配」');

  // 深色主题一致性
  const shell = document.querySelector('.bg-zinc-900');
  if (shell) ok('弹窗外壳使用与其它弹窗一致的深色主题类（bg-zinc-900 / border-zinc-800）');
  else bad('弹窗外壳未使用统一的深色主题样式');

  // 点击关闭应回调 onClose
  const close = Array.from(document.querySelectorAll('button')).find((b) => /关闭|Close/.test(b.textContent || ''));
  if (close) {
    // jsdom 环境下 MouseEvent 不在 Node 全局上，用 testing-library 的 fireEvent
    await act(async () => { fireEvent.click(close); });
    if (closed) ok('关闭按钮能正常回调 onClose');
    else bad('关闭按钮未触发 onClose');
  }

  console.log(`\n    结果: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('    测试异常:', e.message); process.exit(1); });
