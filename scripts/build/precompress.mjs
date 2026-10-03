#!/usr/bin/env node
/**
 * Pre-compress the built frontend (brotli + gzip) next to the originals.
 *
 * Why at build time instead of a runtime compression middleware:
 *   - The bytes were measured: `index-*.js` 552,818 B → 159,299 gzip / 135,064
 *     brotli, `index-*.css` 73,622 → 12,569 / 10,959. That is a 72% saving on the
 *     first load, delivered with zero per-request CPU.
 *   - On a NAS the backend is the only server in front of the app, so paying a
 *     brotli-quality-11 compress on every request (or holding a gzip stream open
 *     per response) is exactly the kind of steady-state cost the optimization is
 *     meant to remove. Doing it once at build time costs nothing at runtime.
 *   - No new dependency: `node:zlib` has both codecs, and the backend serves the
 *     `.br`/`.gz` siblings via `precompressedStatic()` (`backend/src/common/http/
 *     precompressed-static.ts`).
 *
 * The siblings are written next to the original file (`app.js.br`, `app.js.gz`),
 * which is what the backend looks for, and are ignored by Vite/express.
 *
 * Usage: node scripts/build/precompress.mjs [distDir=web/dist]
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { brotliCompress, gzip, constants } from 'node:zlib';
import { promisify } from 'node:util';

const brotli = promisify(brotliCompress);
const gz = promisify(gzip);

/** Only these are worth compressing; images/fonts are already compressed. */
const EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.css', '.html', '.json', '.svg', '.txt']);

/** Below this, the payload is smaller than the framing gain — not worth a file. */
const MIN_BYTES = 1024;

/** A file whose compressed form is barely smaller is left alone (already dense). */
const MIN_SAVING = 0.05;

const distDir = path.resolve(process.argv[2] ?? 'web/dist');

async function walk(dir) {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function human(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  return kb < 1024 ? `${kb.toFixed(1)} KB` : `${(kb / 1024).toFixed(2)} MB`;
}

let files = 0;
let rawTotal = 0;
let bestTotal = 0;

const entries = (await walk(distDir)).filter((file) => EXTENSIONS.has(path.extname(file)));

for (const file of entries) {
  // Never compress a file that is itself a compressed variant.
  if (/\.(br|gz)$/.test(file)) continue;
  const raw = await fs.readFile(file);
  if (raw.byteLength < MIN_BYTES) continue;

  const name = path.relative(distDir, file);
  const br = await brotli(raw, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 11,
      [constants.BROTLI_PARAM_SIZE_HINT]: raw.byteLength,
    },
  });
  const gzBuf = await gz(raw, { level: 9 });

  const best = Math.min(br.byteLength, gzBuf.byteLength);
  if (best > raw.byteLength * (1 - MIN_SAVING)) {
    console.log(`  – ${name}: ${human(raw.byteLength)} — 压缩收益过低，跳过`);
    continue;
  }

  await fs.writeFile(`${file}.br`, br);
  await fs.writeFile(`${file}.gz`, gzBuf);
  files += 1;
  rawTotal += raw.byteLength;
  bestTotal += best;
  console.log(
    `  ✓ ${name}: ${human(raw.byteLength)} → br ${human(br.byteLength)} / gz ${human(
      gzBuf.byteLength,
    )}`,
  );
}

if (files === 0) {
  console.log(`[precompress] ${distDir}: 没有需要预压缩的文件`);
} else {
  const pct = ((1 - bestTotal / rawTotal) * 100).toFixed(1);
  console.log(
    `[precompress] ${files} 个文件：${human(rawTotal)} → ${human(bestTotal)}（省 ${pct}%）` +
      `，已写出 .br/.gz（后端按 Accept-Encoding 选择）`,
  );
}