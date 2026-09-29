#!/usr/bin/env node
/**
 * 生成 .source-hash —— 必须与 Dockerfile 里算出的 sourceHash **逐字节一致**，
 * 否则 scripts/docker-deploy.sh 会一直提示「镜像可能过期」，那个提示就废了。
 *
 * Dockerfile 里的算法（build 阶段）：
 *   find backend/src web/src -type f -a \( -name '*.ts' -o -name '*.tsx' -o -name '*.css' \) \
 *     | LC_ALL=C sort | xargs cat | sha256sum | cut -c1-16
 *
 * 这里刻意复刻它，包括两个容易忽略的细节：
 *   1) 排序是 LC_ALL=C 的字节序，不是 JS 默认的 UTF-16 字典序 ——
 *      仓库里有中文目录/文件时两者结果不同；
 *   2) 文件内容**直接拼接**（cat 的语义），文件之间不插任何分隔符。
 *
 * 用法：
 *   node scripts/gen-source-hash.mjs            # 写入 .source-hash
 *   node scripts/gen-source-hash.mjs --check    # 只比较；过期时退出码 1
 */
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROOTS = ['backend/src', 'web/src'];
const EXT = /\.(ts|tsx|css)$/;

const files = [];
const walk = (dir) => {
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(rel);
    else if (EXT.test(e.name) && statSync(join(ROOT, rel)).isFile()) files.push(rel);
  }
};
for (const r of ROOTS) walk(r);

// LC_ALL=C 的字节序：按 UTF-8 字节比较，而不是 JS 的 UTF-16 code unit 顺序。
files.sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));

const hash = createHash('sha256');
for (const f of files) hash.update(readFileSync(join(ROOT, f)));
const value = hash.digest('hex').slice(0, 16);

const target = join(ROOT, '.source-hash');
const check = process.argv.includes('--check');

if (check) {
  const current = existsSync(target) ? readFileSync(target, 'utf8').trim() : '';
  if (current === value) {
    console.log(`✓ .source-hash 是最新的（${value}，${files.length} 个文件）`);
    process.exit(0);
  }
  console.error(`✗ .source-hash 过期：文件里是 ${current || '(空)'}，当前源码是 ${value}`);
  console.error('  运行 node scripts/gen-source-hash.mjs 更新它。');
  process.exit(1);
}

writeFileSync(target, `${value}\n`);
console.log(`.source-hash = ${value}（${files.length} 个文件）`);