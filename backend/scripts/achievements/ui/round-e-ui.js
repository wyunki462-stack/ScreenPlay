/**
 * 问题3：成就「手动选择游戏」弹窗的搜索提示必须是通用文案。
 *
 * 渲染真实组件，断言输入框 placeholder —— 而不是去读 i18n 字典，
 * 因为文案最终是用户看到的那个属性。
 */
const path = require('path');
process.env.TEST_DB = process.env.TEST_DB || path.join(__dirname, '..', '..', '..', '..', '.tmp-round-e', 'data', 'screenplay.db');
require('./setup.cjs');
const { render, screen, act, cleanup } = require('@testing-library/react');
const React = require('react');
const { pickDialogTree } = require('./out-e.cjs');

let pass = 0, fail = 0;
const ok = (m) => { console.log(`  \x1b[32m✓\x1b[0m ${m}`); pass++; };
const bad = (m) => { console.log(`  \x1b[31m✗\x1b[0m ${m}`); fail++; };

(async () => {
  cleanup();
  render(pickDialogTree({ gameId: 'ui-fixture', gameName: 'Bloodborne', onClose: () => {} }));
  await act(async () => { await new Promise((r) => setTimeout(r, 250)); });

  const input = document.querySelector('input');
  if (!input) { bad('没渲染出搜索输入框'); console.log(`\n  结果: ${pass} 通过 / ${fail} 失败\n`); process.exit(1); }

  const ph = input.getAttribute('placeholder') || '';
  console.log(`     实际 placeholder：${JSON.stringify(ph)}`);

  if (ph.includes('输入游戏名称搜索')) ok('提示为通用的「输入游戏名称搜索」');
  else bad('提示未包含通用文案');

  const forbidden = ['007', 'First Light', '如 ', 'e.g.', 'God of War'];
  const hit = forbidden.filter((f) => ph.includes(f));
  if (hit.length === 0) ok('已移除具体游戏示例（无 007 / e.g. / 如 等字样）');
  else bad(`提示中仍有具体示例：${hit.join(', ')}`);

  const body = document.body.textContent || '';
  if (!/007|First Light/.test(body)) ok('整个弹窗文本中都不含 007 First Light 示例');
  else bad('弹窗其它位置仍有 007 First Light');

  // 交互逻辑未被改动：底部按钮与标题仍在
  const btns = Array.from(document.querySelectorAll('button')).map((b) => b.textContent || '');
  const confirm = btns.find((t) => /确认并重新抓取/.test(t));
  if (confirm) ok('底部「确认并重新抓取」按钮保持不变');
  else bad(`确认按钮消失，弹窗结构被破坏（现有按钮：${btns.join(' / ')}）`);

  const title = document.querySelector('h3')?.textContent || '';
  if (title.includes('选择成就目标')) ok(`弹窗标题保持原样：${title}`);
  else bad(`弹窗标题异常：${title || '(空)'}`);

  console.log(`\n  结果: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('  测试异常:', e.message); process.exit(1); });
