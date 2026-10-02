#!/usr/bin/env node
/**
 * ScreenPlay 桌面图标自检 —— 零依赖。
 *
 * 为什么要单独写一个：图标是**提交进仓库的二进制产物**（windows/src-tauri/icons/，
 * 由 scripts/gen-icons.mjs 生成）。构建脚本不会重新生成它们，所以「改了品牌几何但忘了
 * 重跑生成器」会静默通过一切结构检查 —— 只有把像素解出来看颜色才能发现。
 *
 * 这里用 node:zlib 自己解 PNG（IHDR/IDAT/IEND + 5 种 filter），断言四件事：
 *   1. 尺寸正确，圆角外的像素透明（真的是圆角方块，不是方角图）；
 *   2. 左上角像素是品牌渐变 violet-600 #7c3aed，右下角是 cyan-500 #06b6d4
 *      —— 期望值直接用「同一条对角线的混合公式」算出来再比，容差很小；
 *   3. 存在足量纯白像素（lucide Gamepad2 的描边），而不是旧版那个蓝色 S；
 *   4. 不存在旧版深色底（近黑不透明像素为 0）。
 *
 * 用法：
 *   node windows/scripts/verify-icons.mjs            # 独立跑，打印结果
 *   import { verifyIcons } from './verify-icons.mjs' # 复用 verify-desktop 的计数器
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ICON_DIR = path.join(HERE, '..', 'src-tauri', 'icons');

/** 与 gen-icons.mjs 完全相同的品牌常量（改一处就要三处同步）。 */
const BOX = 36;
const GRAD_TOP = [124, 58, 237]; // #7c3aed
const GRAD_BOTTOM = [6, 182, 212]; // #06b6d4
const MIX = (a, b, t) => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

/** 解一张 8bit RGBA、无隔行的 PNG → { width, height, data }。 */
function decodePng(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) {
    throw new Error('不是 PNG（签名不符）');
  }
  let off = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];
  let sawIEND = false;
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      sawIEND = true;
      break;
    }
    off += 12 + len;
  }
  if (!sawIEND) throw new Error('缺少 IEND');
  if (bitDepth !== 8 || colorType !== 6 || interlace !== 0) {
    throw new Error(`只支持 8bit RGBA 非隔行 PNG，实际 bitDepth=${bitDepth} colorType=${colorType} interlace=${interlace}`);
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const out = Buffer.alloc(height * stride);
  const expectRaw = height * (stride + 1);
  if (raw.length !== expectRaw) throw new Error(`IDAT 解压后 ${raw.length} 字节，期望 ${expectRaw}`);

  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const row = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? row[x - 4] : 0;
      const b = prev[x];
      const c = x >= 4 ? prev[x - 4] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) {
        throw new Error(`未知的 PNG filter ${filter}（第 ${y} 行）`);
      }
      row[x] = v & 0xff;
    }
    prev = row;
  }
  return { width, height, data: out };
}

const px = (img, x, y) => {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
};

const near = (got, want, tol) => Math.max(...[0, 1, 2].map((i) => Math.abs(got[i] - want[i]))) <= tol;

/** 单张图标的全套断言；`check(cond, label, detail)` 由调用方提供。 */
function checkOne(name, img, check) {
  const n = img.width;
  const tol = n <= 64 ? 14 : 8; // 小图抗锯齿更糙，样本点仍在内侧

  check(img.height === n, `${name} 为正方形（${n}×${n}）`);

  // 1) 圆角：极端角落必须透明。
  const cornerA = px(img, 0, 0)[3];
  check(cornerA <= 16, `${name} 圆角外透明（(0,0) alpha=${cornerA}）`, `size=${n}`);

  // 2) 渐变：取样点按同一条对角线算期望色，容差极小。
  const inset = Math.max(2, Math.round(n * 0.12));
  const tOf = (x, y) => (((x + 0.5) / n) * BOX + ((y + 0.5) / n) * BOX) / (2 * BOX);
  const tl = px(img, inset, inset);
  const br = px(img, n - 1 - inset, n - 1 - inset);
  const wantTl = MIX(GRAD_TOP, GRAD_BOTTOM, tOf(inset, inset));
  const wantBr = MIX(GRAD_TOP, GRAD_BOTTOM, tOf(n - 1 - inset, n - 1 - inset));
  check(
    tl[3] >= 250 && near(tl, wantTl, tol),
    `${name} 左上角是品牌紫 #7c3aed（rgb=${tl.slice(0, 3).join(',')}，期望 ${wantTl.map((v) => Math.round(v)).join(',')}）`,
    `size=${n}`,
  );
  check(
    br[3] >= 250 && near(br, wantBr, tol),
    `${name} 右下角是品牌青 #06b6d4（rgb=${br.slice(0, 3).join(',')}，期望 ${wantBr.map((v) => Math.round(v)).join(',')}）`,
    `size=${n}`,
  );
  check(tl[0] > br[0] && br[1] > tl[1], `${name} 渐变方向为左上紫 → 右下青（bg-gradient-to-br）`);

  // 3) 白色字形 + 4) 旧深色底必须绝迹。
  let white = 0;
  let brightSmall = 0;
  let maxLum = 0;
  let nearBlack = 0;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const p = px(img, x, y);
      if (p[3] < 250) continue;
      const lum = 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2];
      if (lum > maxLum) maxLum = lum;
      if (p[0] >= 245 && p[1] >= 245 && p[2] >= 245) white++;
      if (Math.min(p[0], p[1], p[2]) >= 230) brightSmall++;
      if (p[0] < 20 && p[1] < 20 && p[2] < 40) nearBlack++;
    }
  }
  const whiteMin = Math.max(4, Math.round(n * n * 0.005));
  if (n >= 128) {
    check(white >= whiteMin, `${name} 含白色 lucide Gamepad2 描边（白像素 ${white} ≥ ${whiteMin}）`, `size=${n}`);
  } else {
    // 32px 上描边只有约 1.3px 宽，抗锯齿必然把白和渐变混在一起，没有像素能达到 245；
    // 但字形必须仍然"很亮"。旧版蓝色 S（#3d7eff，最亮约 130）在这里必然不合格。
    check(
      brightSmall >= 6 && maxLum >= 235,
      `${name} 描边在 32px 仍清晰（近白像素 ${brightSmall}，最亮亮度 ${maxLum.toFixed(0)}）`,
      `size=${n}`,
    );
  }
  check(nearBlack === 0, `${name} 不含旧版深色底（近黑不透明像素 ${nearBlack}）`, `size=${n}`);
}

/**
 * @param {(cond: boolean, label: string, detail?: string) => void} check
 * @returns {{icons: number}} 已检查的图标数（含 .ico 内嵌的 256×256）
 */
export function verifyIcons(check) {
  const files = [
    ['icon.png', 1024],
    ['128x128.png', 128],
    ['32x32.png', 32],
  ];
  let icons = 0;
  for (const [name, size] of files) {
    const file = path.join(ICON_DIR, name);
    if (!fs.existsSync(file)) {
      check(false, `${name} 存在`, file);
      continue;
    }
    let img;
    try {
      img = decodePng(fs.readFileSync(file));
    } catch (e) {
      check(false, `${name} 可解码为 PNG`, String(e.message));
      continue;
    }
    check(img.width === size, `${name} 尺寸 ${size}×${size}`, `实际 ${img.width}×${img.height}`);
    checkOne(name, img, check);
    icons++;
  }

  // .ico：单条 256×256 PNG 记录，把它解出来同样验证品牌几何。
  const icoFile = path.join(ICON_DIR, 'icon.ico');
  if (!fs.existsSync(icoFile)) {
    check(false, 'icon.ico 存在', icoFile);
  } else {
    const ico = fs.readFileSync(icoFile);
    try {
      const payloadSize = ico.readUInt32LE(14);
      const payloadOffset = ico.readUInt32LE(18);
      const img = decodePng(ico.subarray(payloadOffset, payloadOffset + payloadSize));
      check(img.width === 256 && img.height === 256, 'icon.ico 内嵌 256×256 PNG', `${img.width}×${img.height}`);
      checkOne('icon.ico', img, check);
      icons++;
    } catch (e) {
      check(false, 'icon.ico 内嵌 PNG 可解码', String(e.message));
    }
  }
  return { icons };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  let ok = 0;
  let bad = 0;
  const check = (cond, label, detail = '') => {
    if (cond) {
      ok++;
      console.log(`  ✓ ${label}`);
    } else {
      bad++;
      console.log(`  ✗ ${label}${detail ? `  （${detail}）` : ''}`);
    }
  };
  console.log('Windows 端 exe 图标 —— 像素级品牌自检（与 web/public/favicon.svg 同一几何）');
  const { icons } = verifyIcons(check);
  console.log(`\n检查图标 ${icons} 个（windows/src-tauri/icons/）`);
  console.log(`结果：${ok} 项通过 / ${bad} 项失败`);
  process.exit(bad === 0 ? 0 : 1);
}