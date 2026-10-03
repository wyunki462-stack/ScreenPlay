#!/usr/bin/env node
/**
 * 缩略图的「无损高压缩」到底能不能省字节？—— 实测脚本（只读本地文件，不联网、不改仓库）
 *
 *   node scripts/perf-bench/thumb-compress.js [源图路径]
 *   默认源图：windows/src-tauri/icons/icon.png（仓库里唯一的一张真实大图）
 *
 * 背景：报告方向②里用户点名要「前端产物与缩略图的无损高压缩」。前端产物那半边已经落实
 * （构建期预压缩，优化项 9）；缩略图这半边要用数据回答「值不值得做」，本脚本就是那份数据。
 *
 * 做的事：用生产管线的同一套参数（sharp，480px，WebP quality 80 —— 即
 * backend/src/media/media-processor.service.ts 里 thumbnailWidth/thumbnailQuality 的默认行为）生成一张
 * 缩略图，然后分别施加四种「无损/近似无损」手段，看字节怎么变：
 *
 *   1. gzip -9 / brotli q11        —— HTTP 传输层压缩（中间件对图片故意不预压缩，见优化项 9）
 *   2. 对已生成的 WebP 做无损 WebP 重编码 —— 「无损再压一遍」最直觉的做法
 *   3. 从源图直接无损 WebP          —— 一开始就无损会是什么代价
 *   4. 降质量（有损，会改画面）      —— 唯一真能变小的办法，作为对照，不做
 *
 * 结论（实测数据见 docs/perf/thumb-compression.txt）：WebP 本身已是熵编码容器，
 * 无损手段全部无效甚至负收益（无损重编码 +308%），能省字节的只有降质量 —— 那会改变画面，
 * 属功能/画质退化，不做。缩略图这一侧真正的收益来自「让卡片用缩略图」（优化项 7，约 250 MB → 300 KB/屏）
 * 与「衍生件过期清理」（优化项 4），不是再压一遍。
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const sharp = require('sharp');

const SRC = path.resolve(process.argv[2] || 'windows/src-tauri/icons/icon.png');
const WIDTH = 480; // 与 configuration.ts 的 thumbnailWidth 默认值一致
const QUALITY = 80; // 与 thumbnailQuality 默认值一致

const pct = (a, b) => `${((a / b - 1) * 100 >= 0 ? '+' : '') + ((a / b - 1) * 100).toFixed(1)}%`;

async function main() {
  if (!fs.existsSync(SRC)) {
    console.error(`源图不存在：${SRC}`);
    process.exit(2);
  }
  const meta = await sharp(SRC).metadata();
  console.log('缩略图「无损高压缩」可行性实测（sharp，与生产管线同参数）');
  console.log(`源文件：${SRC}`);
  console.log(`        ${(fs.statSync(SRC).size / 1024).toFixed(1)} KiB，`
    + `${meta.width}x${meta.height} ${meta.format}`);
  console.log('');

  const base = await sharp(SRC)
    .resize({ width: WIDTH, withoutEnlargement: true })
    .webp({ quality: QUALITY })
    .toBuffer();
  console.log(`现行缩略图（${WIDTH}px WebP q${QUALITY}）= ${base.length} B  ← 基线`);
  console.log('');

  const gz = zlib.gzipSync(base, { level: 9 });
  const br = zlib.brotliCompressSync(base, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: base.length,
    },
  });
  console.log(`[1] HTTP 传输层压缩（中间件对图片不做，因此这里只是证明「做了也没用」）`);
  console.log(`    + gzip -9      = ${gz.length} B  (${pct(gz.length, base.length)})`);
  console.log(`    + brotli q11   = ${br.length} B  (${pct(br.length, base.length)})`);

  const reloss = await sharp(base).webp({ lossless: true, effort: 6 }).toBuffer();
  console.log(`[2] 对已生成的 WebP 再做「无损 WebP 重编码」= ${reloss.length} B  (${pct(reloss.length, base.length)})`);

  const lsrc = await sharp(SRC)
    .resize({ width: WIDTH, withoutEnlargement: true })
    .webp({ lossless: true, effort: 6 })
    .toBuffer();
  console.log(`[3] 源图直接无损 WebP（对照：一开始就无损的代价）= ${lsrc.length} B  (${pct(lsrc.length, base.length)})`);

  const q70 = await sharp(SRC).resize({ width: WIDTH, withoutEnlargement: true }).webp({ quality: 70 }).toBuffer();
  const q60 = await sharp(SRC).resize({ width: WIDTH, withoutEnlargement: true }).webp({ quality: 60 }).toBuffer();
  console.log(`[4] 参照（有损、像素会变，不做）：q70 = ${q70.length} B (${pct(q70.length, base.length)})，`
    + `q60 = ${q60.length} B (${pct(q60.length, base.length)})`);
  console.log('');
  console.log('判定：无损手段全部无效或负收益 ⇒ 缩略图不再压一遍；');
  console.log('      真正省带宽的是「让卡片用缩略图」（优化项 7）与「衍生件过期清理」（优化项 4）。');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});