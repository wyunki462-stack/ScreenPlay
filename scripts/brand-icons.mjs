#!/usr/bin/env node
/**
 * 品牌图标生成器（零依赖）—— 从真源 `web/public/favicon.svg` 派生三端共用的图标资源。
 *
 * 真源与既有约定：
 *   - `web/public/favicon.svg` 是唯一的矢量真源（Web 页眉品牌块 / 浏览器标签 /
 *     Windows 安装包图标 / 安卓应用图标都源自它）；
 *   - `windows/scripts/gen-icons.mjs` 用同一份几何栅格化 Windows 的 PNG/ICO，并在构建时
 *     `assertBrandSvg()` 逐字断言 favicon.svg 的关键常量（改图标必须同步改它）；
 *   - 本脚本是第三个消费者：**只读** favicon.svg，不修改它（改图标仍需同时改
 *     favicon.svg + gen-icons.mjs + 本脚本 + windows/src-tauri/splash/index.html）。
 *
 * 产物：
 *   - flutter/lib/widgets/brand_glyph.dart
 *       字形几何（绝对坐标）+ 品牌常量，供 App 内 [BrandMark] 小部件绘制；
 *   - flutter/android/app/src/main/res/drawable/ic_launcher_background.xml
 *       自适应图标背景层（品牌对角渐变，铺满 108dp）；
 *   - .../drawable/ic_launcher_foreground.xml
 *       自适应图标前景层（白色 Gamepad2 字形，落在中心 72dp 安全区内）；
 *   - .../drawable/ic_launcher_monochrome.xml
 *       主题图标（Android 13+ 单色层）；
 *   - .../mipmap-anydpi-v26/ic_launcher.xml
 *       自适应图标装配文件（minSdk 28 ⇒ 所有设备都走这条路，不再需要 PNG mipmap）。
 *
 * 用法：
 *   node scripts/brand-icons.mjs            # 生成 / 覆盖产物
 *   node scripts/brand-icons.mjs --check    # 只校验产物是否与真源一致（CI 用，不一致退出 1）
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SVG_FILE = resolve(ROOT, 'web/public/favicon.svg');

const DART_OUT = resolve(ROOT, 'flutter/lib/widgets/brand_glyph.dart');
const RES = resolve(ROOT, 'flutter/android/app/src/main/res');
const BG_OUT = resolve(RES, 'drawable/ic_launcher_background.xml');
const FG_OUT = resolve(RES, 'drawable/ic_launcher_foreground.xml');
const MONO_OUT = resolve(RES, 'drawable/ic_launcher_monochrome.xml');
const ADAPTIVE_OUT = resolve(RES, 'mipmap-anydpi-v26/ic_launcher.xml');

const CHECK = process.argv.includes('--check');

// ---------------------------------------------------------------------------
// 1. 读真源 + 断言品牌常量
// ---------------------------------------------------------------------------

const svg = readFileSync(SVG_FILE, 'utf8');
const problems = [];
const expect = (ok, msg) => {
  if (!ok) problems.push(msg);
};

const BOX = 36; // favicon viewBox 边长
const RX = 8; // 圆角半径
const GRADIENT = ['#7c3aed', '#06b6d4'];
const STROKE = '#ffffff';
const STROKE_WIDTH = 2;
const GLYPH_OFFSET = 11.33333; // <g transform="translate(…)">
const GLYPH_SCALE = 0.555556; //   … scale(…) —— 24 单位字形 → 20 px

expect(/viewBox="0 0 36 36"/.test(svg), 'viewBox 必须是 "0 0 36 36"');
expect(
  new RegExp(`<rect x="0" y="0" width="36" height="36" rx="${RX}" fill="url\\(#sp\\)"`).test(svg),
  `品牌方块必须是 36×36 rx=${RX} 且填充 url(#sp)`,
);
expect(
  svg.includes(`<stop offset="0" stop-color="${GRADIENT[0]}"`) &&
    svg.includes(`<stop offset="1" stop-color="${GRADIENT[1]}"`),
  `渐变必须是 ${GRADIENT[0]} → ${GRADIENT[1]}`,
);
expect(
  svg.includes(`transform="translate(${GLYPH_OFFSET} ${GLYPH_OFFSET}) scale(${GLYPH_SCALE})"`),
  `字形 transform 必须是 translate(${GLYPH_OFFSET} ${GLYPH_OFFSET}) scale(${GLYPH_SCALE})`,
);
expect(
  svg.includes(
    `fill="none" stroke="${STROKE}" stroke-width="${STROKE_WIDTH}" stroke-linecap="round" stroke-linejoin="round"`,
  ),
  `字形必须是 fill=none stroke=${STROKE} stroke-width=${STROKE_WIDTH} 圆头圆角`,
);

const groupMatch = svg.match(/<g[^>]*transform="translate\([^)]*\) scale\([^)]*\)"[^>]*>([\s\S]*?)<\/g>/);
if (!groupMatch) {
  problems.push('找不到字形分组 <g transform="…">…</g>');
}
const groupBody = groupMatch ? groupMatch[1] : '';

const lineMatches = [...groupBody.matchAll(/<line x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)"\s*\/>/g)].map(
  (m) => ({ x1: Number(m[1]), y1: Number(m[2]), x2: Number(m[3]), y2: Number(m[4]) }),
);
expect(lineMatches.length === 4, `字形分组里应当有 4 条 <line>，实际 ${lineMatches.length} 条`);

const pathMatch = groupBody.match(/<path d="([^"]+)"\s*\/>/);
if (!pathMatch) problems.push('找不到字形轮廓 <path d="…">');
const glyphD = pathMatch ? pathMatch[1] : '';

if (problems.length > 0) {
  console.error('✗ 品牌图标真源校验失败（web/public/favicon.svg）：');
  for (const p of problems) console.error(`  - ${p}`);
  console.error('  若确实要改图标，请同时更新：web/public/favicon.svg、windows/scripts/gen-icons.mjs、');
  console.error('  windows/src-tauri/splash/index.html、scripts/brand-icons.mjs。');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 2. SVG path → 绝对坐标线段表
// ---------------------------------------------------------------------------

/** 把 SVG 的 d 属性解析成绝对坐标线段表（只支持本图标用到的命令）。 */
function parsePathData(d) {
  const tokens = d.match(/[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) ?? [];
  const out = [];
  let i = 0;
  let cmd = null;
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  const num = () => {
    if (i >= tokens.length) throw new Error(`路径数据在命令 ${cmd} 处提前结束`);
    return Number(tokens[i++]);
  };

  while (i < tokens.length) {
    if (/^[A-Za-z]$/.test(tokens[i])) cmd = tokens[i++];
    if (cmd === null) throw new Error('路径数据以数字开头');
    switch (cmd) {
      case 'M':
      case 'm': {
        const first = cmd === 'M';
        x = first ? num() : x + num();
        y = first ? num() : y + num();
        out.push({ t: 'M', x, y });
        startX = x;
        startY = y;
        cmd = first ? 'L' : 'l'; // 后续隐式续写按 lineTo 处理（SVG 规范）
        break;
      }
      case 'L':
      case 'l': {
        const abs = cmd === 'L';
        const nx = num();
        const ny = num();
        x = abs ? nx : x + nx;
        y = abs ? ny : y + ny;
        out.push({ t: 'L', x, y });
        break;
      }
      case 'H':
      case 'h': {
        const nx = num();
        x = cmd === 'H' ? nx : x + nx;
        out.push({ t: 'L', x, y });
        break;
      }
      case 'V':
      case 'v': {
        const ny = num();
        y = cmd === 'V' ? ny : y + ny;
        out.push({ t: 'L', x, y });
        break;
      }
      case 'C':
      case 'c': {
        const abs = cmd === 'C';
        const values = [num(), num(), num(), num(), num(), num()];
        const p = abs
          ? values
          : [x + values[0], y + values[1], x + values[2], y + values[3], x + values[4], y + values[5]];
        out.push({ t: 'C', x1: p[0], y1: p[1], x2: p[2], y2: p[3], x: p[4], y: p[5] });
        x = p[4];
        y = p[5];
        break;
      }
      case 'A':
      case 'a': {
        const abs = cmd === 'A';
        const rx = num();
        const ry = num();
        const rotation = num();
        const largeArc = num() !== 0;
        const sweep = num() !== 0;
        const ex = num();
        const ey = num();
        const nx = abs ? ex : x + ex;
        const ny = abs ? ey : y + ey;
        out.push({ t: 'A', rx, ry, rotation, largeArc, sweep, x: nx, y: ny });
        x = nx;
        y = ny;
        break;
      }
      case 'Z':
      case 'z': {
        out.push({ t: 'Z' });
        x = startX;
        y = startY;
        break;
      }
      default:
        throw new Error(`暂不支持的路径命令：${cmd}（需要时在 parsePathData 里补充）`);
    }
  }
  return out;
}

const segments = parsePathData(glyphD);
for (const s of segments) {
  if (s.t === 'A' && (Math.abs(s.rx - s.ry) > 1e-9 || s.rotation !== 0)) {
    console.error('✗ 只支持圆弧的圆（rx == ry 且 rotation == 0）；当前弧为非圆/带旋转，需改用贝塞尔近似。');
    process.exit(1);
  }
}

const fmt = (n) => {
  // 保留 6 位小数：favicon.svg 里的 scale(0.555556) / translate(11.33333 11.33333)
  // 是 6 位精度，截到 4 位会让 Android 组变换与 App 内小部件出现亚像素级偏移。
  const rounded = Number(n.toFixed(6));
  return Object.is(rounded, -0) ? '0' : String(rounded);
};

// ---------------------------------------------------------------------------
// 3. 产物：Dart 字形几何
// ---------------------------------------------------------------------------

function dartGeometry() {
  const lines = [];
  for (const l of lineMatches) {
    lines.push(`  ..moveTo(${fmt(l.x1)}, ${fmt(l.y1)})`);
    lines.push(`  ..lineTo(${fmt(l.x2)}, ${fmt(l.y2)})`);
  }
  for (const s of segments) {
    switch (s.t) {
      case 'M':
        lines.push(`  ..moveTo(${fmt(s.x)}, ${fmt(s.y)})`);
        break;
      case 'L':
        lines.push(`  ..lineTo(${fmt(s.x)}, ${fmt(s.y)})`);
        break;
      case 'C':
        lines.push(
          `  ..cubicTo(${fmt(s.x1)}, ${fmt(s.y1)}, ${fmt(s.x2)}, ${fmt(s.y2)}, ${fmt(s.x)}, ${fmt(s.y)})`,
        );
        break;
      case 'A':
        lines.push(
          `  ..arcToPoint(const Offset(${fmt(s.x)}, ${fmt(s.y)}),\n` +
            `      radius: const Radius.circular(${fmt(s.rx)}),\n` +
            `      largeArc: ${s.largeArc},\n` +
            `      clockwise: ${s.sweep})`,
        );
        break;
      case 'Z':
        lines.push('  ..close()');
        break;
      default:
        throw new Error(`未处理的线段类型：${s.t}`);
    }
  }

  return `// GENERATED FILE — 请勿手改。
// 由 \`node scripts/brand-icons.mjs\` 从 \`web/public/favicon.svg\` 生成。
//
// 为什么不手写：品牌图标是「三端同一份几何」（Web favicon / Windows gen-icons.mjs /
// 安卓自适应图标 / App 内 <BrandMark> 小部件），任何一处手抖都会让三端看上去不一样。
// 生成器每次都会逐字断言真源里的品牌常量，改图标时只能改真源 + 重新生成。
//
// 几何说明：字形写在 24 单位的 glyph 空间里，favicon.svg 用
// \`transform="translate(${GLYPH_OFFSET} ${GLYPH_OFFSET}) scale(${GLYPH_SCALE})"\`
// 把它放进 ${BOX} 单位的品牌方块。本文件保存的是 **glyph 空间的原始坐标**
// （与 SVG \`<g>\` 内那些数字逐字相同），应用时由 [BrandMark] 施加同一个变换。

import 'dart:ui';

/// 品牌方块边长（favicon viewBox 边长）。
const double kBrandBoxSize = ${fmt(BOX)};

/// 品牌方块圆角半径。
const double kBrandCornerRadius = ${fmt(RX)};

/// 字形（24 单位 glyph 空间）在方块内的缩放系数与偏移。
const double kBrandGlyphScale = ${fmt(GLYPH_SCALE)};
const double kBrandGlyphOffset = ${fmt(GLYPH_OFFSET)};

/// 字形描边宽度（glyph 空间）。
const double kBrandStrokeWidth = ${fmt(STROKE_WIDTH)};

/// 品牌渐变两端（#7c3aed → #06b6d4，对角 左上 → 右下）。
const int kBrandGradientStart = 0xFF${GRADIENT[0].slice(1).toUpperCase()};
const int kBrandGradientEnd = 0xFF${GRADIENT[1].slice(1).toUpperCase()};

/// 字形（Gamepad2）路径 —— 4 个功能键圆点 + 手柄轮廓，全部为描边（无填充）。
///
/// 对应 SVG：\`${glyphD.slice(0, 60)}…\`
Path buildBrandGlyphPath() => Path()
${lines.join('\n')};
`;
}

// ---------------------------------------------------------------------------
// 4. 产物：Android 自适应图标
// ---------------------------------------------------------------------------

const ANDROID_HEADER = `<?xml version="1.0" encoding="utf-8"?>
<!-- GENERATED FILE — 请勿手改；由 \`node scripts/brand-icons.mjs\` 从 web/public/favicon.svg 生成。 -->`;

// 自适应图标：前景层 108dp，可见安全区是中心 72dp（即 favicon 的 36 单位 × 2）。
const ART_SCALE = 2;
const ART_ORIGIN = (108 - BOX * ART_SCALE) / 2; // 18
const GLYPH_SCALE_ANDROID = GLYPH_SCALE * ART_SCALE; // 1.111112
const GLYPH_OFFSET_ANDROID = ART_ORIGIN + GLYPH_OFFSET * ART_SCALE; // 40.66666

function androidBackground() {
  return `${ANDROID_HEADER}
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <!-- 品牌对角渐变（#7c3aed → #06b6d4）；形状由系统自适应图标蒙版裁切。 -->
    <path android:pathData="M0,0h108v108h-108z">
        <aapt:attr xmlns:aapt="http://schemas.android.com/aapt" name="android:fillColor">
            <gradient
                android:type="linear"
                android:startX="0"
                android:startY="0"
                android:endX="108"
                android:endY="108">
                <item android:offset="0" android:color="#FF${GRADIENT[0].slice(1).toUpperCase()}" />
                <item android:offset="1" android:color="#FF${GRADIENT[1].slice(1).toUpperCase()}" />
            </gradient>
        </aapt:attr>
    </path>
</vector>
`;
}

function androidGlyphPath(extra) {
  const dots = lineMatches
    .map((l) => `M${fmt(l.x1)},${fmt(l.y1)}L${fmt(l.x2)},${fmt(l.y2)}`)
    .join(' ');
  return `${ANDROID_HEADER}${extra}
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <!-- 与 favicon.svg 完全相同的字形：同一个 group transform + 同一个 pathData。 -->
    <group
        android:translateX="${fmt(GLYPH_OFFSET_ANDROID)}"
        android:translateY="${fmt(GLYPH_OFFSET_ANDROID)}"
        android:scaleX="${fmt(GLYPH_SCALE_ANDROID)}"
        android:scaleY="${fmt(GLYPH_SCALE_ANDROID)}">
        <path
            android:pathData="${dots}"
            android:fillColor="#00000000"
            android:strokeColor="#FFFFFFFF"
            android:strokeWidth="${fmt(STROKE_WIDTH)}"
            android:strokeLineCap="round"
            android:strokeLineJoin="round" />
        <path
            android:pathData="${glyphD}"
            android:fillColor="#00000000"
            android:strokeColor="#FFFFFFFF"
            android:strokeWidth="${fmt(STROKE_WIDTH)}"
            android:strokeLineCap="round"
            android:strokeLineJoin="round" />
    </group>
</vector>
`;
}

function adaptiveIcon() {
  return `${ANDROID_HEADER}
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@drawable/ic_launcher_background" />
    <foreground android:drawable="@drawable/ic_launcher_foreground" />
    <!-- Android 13+ 主题图标：系统用单色层做蒙版着色。 -->
    <monochrome android:drawable="@drawable/ic_launcher_monochrome" />
</adaptive-icon>
`;
}

// ---------------------------------------------------------------------------
// 5. 写出 / 校验
// ---------------------------------------------------------------------------

const artifacts = [
  [DART_OUT, dartGeometry()],
  [BG_OUT, androidBackground()],
  [FG_OUT, androidGlyphPath('\n<!-- 前景层：白色品牌字形，落在中心 72dp 安全区内。 -->')],
  [MONO_OUT, androidGlyphPath('\n<!-- 主题图标单色层：同一几何，系统负责着色。 -->')],
  [ADAPTIVE_OUT, adaptiveIcon()],
];

let drift = 0;
for (const [file, content] of artifacts) {
  const rel = file.slice(ROOT.length + 1);
  if (CHECK) {
    let current = null;
    try {
      current = readFileSync(file, 'utf8');
    } catch {
      current = null;
    }
    if (current !== content) {
      drift += 1;
      console.error(`✗ 产物与真源不一致：${rel}（运行 node scripts/brand-icons.mjs 重新生成）`);
    }
    continue;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf8');
  console.log(`✓ ${rel}`);
}

if (CHECK) {
  if (drift > 0) process.exit(1);
  console.log('✓ 品牌图标产物与 web/public/favicon.svg 一致');
}