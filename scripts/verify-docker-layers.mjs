#!/usr/bin/env node
/**
 * ═════════════════════════════════════════════════════════════════════════════
 * ScreenPlay — Dockerfile 分层自查（静态、离线、不碰 docker）
 *
 * 为什么需要它：
 *   镜像体积里最容易被忽略的一类字节是「**先拷进来 / 先生成，再删掉**」的文件：
 *   删除只是在上层加了一个白洞，下层的字节仍然在镜像里躺着。它们不会让功能出问题，
 *   所以构建、健康检查、功能回归全都发现不了 —— 只有镜像体积会莫名偏大。
 *
 *   而本机（uid 973）没有 docker 权限，无法用 `docker history` 数层大小，
 *   因此这里做**纯文本静态核对**：把 Dockerfile 解析成「阶段 → 指令」，
 *   再检查下面这些规则。Dockerfile 里任何一处把「删除」拆到独立 RUN，
 *   或者把整目录 COPY 进运行阶段后漏删文件，都会在这里失败。
 *
 * 检查项：
 *   1. 运行阶段（最后一个 FROM）里，每个被 COPY 进来的**单文件**都能在同一个阶段
 *      被 `rm` 掉，且删除动作与安装/拷贝在同一 RUN（跨层删除 = 白洞，不算数）。
 *   2. 任何执行 apk 安装的 RUN（`apk add` 或 `apk-setup.sh`）必须**同一个 RUN** 里
 *      清 `/var/cache/apk/*`。
 *   3. 运行阶段不得出现 `COPY` 整个 `scripts/` 目录（会带进 build 阶段才用的脚本）。
 *   4. 运行阶段不得安装开发依赖（typescript / vite / @nestjs/cli / ts-node 之类）。
 *   5. `.dockerignore` 必须排除 `node_modules`、各处的 dist 目录、`.tmp*`、`.git`、`docs`，
 *      以及两个「只该留在宿主机」的大块：`windows/`（`du -sh` 835 MB ≈ 767.7 MiB，桌面构建链）与 `.pw/`
 *      （553.0 MiB / 147 个文件，Playwright Chromium，用它的套件都在宿主机上跑）。两者都在 = 上下文 2.0 MiB / 216 个文件。
 *   6. 部署契约没被动过：运行阶段仍是 `WORKDIR /app/backend` + `CMD ["node","dist/main.js"]`，
 *      且 `WEB_DIST=/app/public`、`DATA_DIR=/data`、`MEDIA_DIRS=/media` 三个 ENV 仍在。
 *   7. apk-setup.sh 内部用的是 `apk add --no-cache`（不留索引缓存）。
 *   8. 「非运行期文件类型」（`*.map` / `*.md` / `*.d.ts`，实测 3,737 个 / 10,320,488 B = 9.84 MiB，去重口径）必须在 **build**
 *      阶段删除 —— 运行阶段的 `node_modules` / `dist` / `public` 是 `COPY --from=build`
 *      搬过来的，在 COPY 之后再删等于往镜像里加一层白洞，字节照样占体积。
 *   9. 运行阶段的基础镜像形态：build 阶段仍是 node 镜像（node 二进制从它来），运行阶段是
 *      **最小 alpine** + `COPY --from=build /usr/local/bin/node`（不再带 npm / corepack /
 *      node 头文件那 148.6 MiB 的基础层），且必须装上 libstdc++（node 二进制的动态依赖），
 *      也不许把 npm / corepack / 全局 node_modules 拷进运行镜像。
 *      背景：删基础镜像层里的文件省不到字节，只能换基础镜像（报告第七节「层语义」）。
 *
 * 用法：
 *   node scripts/verify-docker-layers.mjs              # 仓库根
 *   node scripts/verify-docker-layers.mjs /path/to/repo
 *
 * 退出码：0 = 全部通过；1 = 有违规。
 * ═════════════════════════════════════════════════════════════════════════════
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, '..'));
const DOCKERFILE = path.join(ROOT, 'Dockerfile');
const DOCKERIGNORE = path.join(ROOT, '.dockerignore');
const APK_SETUP = path.join(ROOT, 'scripts/build/apk-setup.sh');

let pass = 0;
let fail = 0;
const ok = (m) => { console.log(`  \x1b[1;32m✓\x1b[0m ${m}`); pass++; };
const bad = (m) => { console.log(`  \x1b[1;31m✗\x1b[0m ${m}`); fail++; };
const head = (m) => console.log(`\n\x1b[1m${m}\x1b[0m`);

/** 把续行（行尾 `\`）拼成单条指令，同时保留起始行号。 */
function parseInstructions(text) {
  const out = [];
  const raw = text.split(/\r?\n/);
  let buf = null;
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i];
    const stripped = line.replace(/\s+$/, '');
    if (buf === null && /^\s*(#|$)/.test(stripped)) continue; // 顶层注释/空行
    if (buf === null) buf = { line: i + 1, text: '' };
    const continued = /\\$/.test(stripped);
    const piece = continued ? stripped.slice(0, -1) : stripped;
    buf.text += (buf.text ? '\n' : '') + piece;
    if (!continued) {
      const m = /^\s*([A-Za-z]+)\s+([\s\S]*)$/.exec(buf.text);
      if (m) out.push({ cmd: m[1].toUpperCase(), args: m[2].trim(), line: buf.line, raw: buf.text });
      buf = null;
    }
  }
  return out;
}

/** 去掉指令关键字（`RUN ...`）后的 shell 主体。 */
function runBody(ins) {
  return ins.raw.replace(/^\s*RUN\s+/, '');
}

/** 粗略拆分 shell 词（够用于 `rm -f a b c` / `apk add x y` 这类）。 */
function words(s) {
  return s
    .replace(/\\\n/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

if (!fs.existsSync(DOCKERFILE)) {
  bad(`找不到 ${DOCKERFILE}`);
  console.log(`\n\x1b[1m结果：${pass} 项通过 / ${fail} 项失败\x1b[0m`);
  process.exit(1);
}

const text = fs.readFileSync(DOCKERFILE, 'utf8');
const instructions = parseInstructions(text);

// ── 阶段切分 ────────────────────────────────────────────────────────────────
const stages = [];
for (const ins of instructions) {
  if (ins.cmd === 'FROM') {
    const m = /\sAS\s+(\S+)\s*$/i.exec(ins.args);
    stages.push({ name: m ? m[1] : `stage${stages.length}`, from: ins.args, instructions: [] });
  }
  if (stages.length) stages[stages.length - 1].instructions.push(ins);
}
const finalStage = stages[stages.length - 1];
const stageLabel = (st) => `${st.name}（第 ${st.instructions[0]?.line ?? '?'} 行起）`;

head('== 1. 运行阶段：临时文件是否在「用它的那一层」被删掉 ==');
{
  const TRANSIENT = /^\/(tmp|var\/tmp)\//;
  const runs = finalStage.instructions.filter((ins) => ins.cmd === 'RUN');
  const copied = [];

  // 枚举仓库里某个目录下的全部文件（用于「整目录 COPY 到 /tmp」的情形）。
  const walkFiles = (abs, base = abs, out = []) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const p = path.join(abs, e.name);
      if (e.isDirectory()) walkFiles(p, base, out);
      else out.push(path.relative(base, p));
    }
    return out;
  };

  for (const ins of finalStage.instructions) {
    if (ins.cmd !== 'COPY') continue;
    const fromBuild = /--from=/.test(ins.args);
    const parts = words(ins.args).filter((p) => !p.startsWith('--'));
    if (parts.length < 2) continue;
    const dest = parts[parts.length - 1];
    const srcs = parts.slice(0, -1);

    for (const src of srcs) {
      const isDir = src.endsWith('/');
      if (!isDir && srcs.length === 1 && !dest.endsWith('/')) {
        copied.push({ src, dest, line: ins.line, kind: 'file' });
        continue;
      }
      if (fromBuild) {
        copied.push({ src, dest, line: ins.line, kind: 'payload' }); // 构建阶段产物：不可枚举，视为载荷
        continue;
      }
      const abs = path.join(ROOT, src);
      let files = null;
      try {
        if (fs.statSync(abs).isDirectory()) files = walkFiles(abs);
      } catch {
        files = null;
      }
      if (files === null) {
        copied.push({ src, dest, line: ins.line, kind: 'payload' });
        continue;
      }
      const base = dest.endsWith('/') ? dest : `${dest}/`;
      for (const rel of files) copied.push({ src, dest: base + rel, line: ins.line, kind: 'dir' });
    }
  }

  // RUN 里「删除某路径」的所有位置：按 && / ; 切块，只看块首是 rm 的块。
  const deletedIn = (run, target) => {
    for (const chunk of runBody(run).split(/&&|;/)) {
      const w = words(chunk);
      const rmAt = w.findIndex((x) => x === 'rm' || x === '/bin/rm');
      if (rmAt === -1 || rmAt > 0) continue;
      if (w.slice(rmAt + 1).some((a) => !a.startsWith('-') && a.replace(/['"]/g, '') === target)) return true;
    }
    return false;
  };
  // 该 RUN 除了 rm 之外是否还「用到」这个路径（= 同一层里用完就删）。
  const usedIn = (run, target) =>
    runBody(run)
      .split(/&&|;/)
      .some((chunk) => !/^\s*rm\b/.test(chunk) && chunk.includes(target));

  const tmpCopies = copied.filter((c) => TRANSIENT.test(c.dest));
  const payload = copied.filter((c) => !TRANSIENT.test(c.dest));

  for (const c of tmpCopies) {
    const deleters = runs.filter((r) => r.line > c.line && deletedIn(r, c.dest));
    if (deleters.length === 0) {
      bad(`COPY ${c.src} → ${c.dest}（第 ${c.line} 行）进了运行镜像却从未删除`);
      continue;
    }
    const sameLayer = deleters.filter((r) => usedIn(r, c.dest));
    if (sameLayer.length > 0) {
      ok(`COPY ${c.src} → ${c.dest} 在与使用它的第 ${sameLayer[0].line} 行同一个 RUN 内用完即删（该脚本自身的字节仍留在 COPY 那一层，KB 级；经典构建器下无法避免，详见 Dockerfile 注释）`);
    } else if (c.kind === 'dir') {
      bad(
        `目录 COPY（第 ${c.line} 行）把 ${c.dest} 带进了运行镜像，但没有任何 RUN 使用它 —— ` +
          '纯浪费的一层：请改成只 COPY 真正要用的那一个文件',
      );
    } else {
      bad(
        `COPY ${c.src} → ${c.dest} 的删除发生在第 ${deleters[0].line} 行的**独立** rm RUN —— ` +
          '白洞层：字节仍留在第 ' + c.line + ' 行那一层',
      );
    }
  }
  if (tmpCopies.length === 0) ok('运行阶段没有 COPY 到 /tmp 的临时文件');
  for (const c of payload) ok(`COPY ${c.src} → ${c.dest} 是运行期载荷（本就该留在镜像里，第 ${c.line} 行）`);
}

head('== 2. apk 安装：索引缓存同层清理 + 工具链不进运行镜像 ==');
{
  const APK_INVOKE = /(?:^|[\s;&|])apk\s+add\b|\bsh\s+\/tmp\/apk-setup\.sh\b/;
  const installRuns = instructions.filter((ins) => ins.cmd === 'RUN' && APK_INVOKE.test(ins.raw));
  const finalInstalls = installRuns.filter((ins) => finalStage.instructions.includes(ins));

  // 2a. 运行阶段的安装必须在同一个 RUN 里清索引缓存（否则那一层留着缓存）。
  if (finalInstalls.length === 0) {
    bad('运行阶段没有任何 apk 安装 —— ffmpeg 应当由 apk-setup.sh 在本阶段装入');
  }
  for (const ins of finalInstalls) {
    if (/rm\s+(-\w+\s+)*-\w*r\w*f\w*\s+\/var\/cache\/apk/.test(ins.raw) || /rm\s+-rf\s+\/var\/cache\/apk/.test(ins.raw)) {
      ok(`第 ${ins.line} 行：运行阶段的 apk 安装在同一 RUN 里清了 /var/cache/apk/*`);
    } else {
      bad(`第 ${ins.line} 行：运行阶段的 apk 安装没有在同一 RUN 里清 /var/cache/apk/*`);
    }
  }

  // 2b. 任何裸的 `apk add` 都必须带 --no-cache（apk-setup.sh 内部另有第 7 项核对）。
  const naked = instructions.filter(
    (ins) => ins.cmd === 'RUN' && /(?:^|[\s;&|])apk\s+add\b/.test(ins.raw) && !/apk\s+add\b[\s\S]*?--no-cache/.test(ins.raw),
  );
  if (naked.length === 0) ok('没有裸露的 `apk add`（一律带 --no-cache 或走 apk-setup.sh）');
  else for (const o of naked) bad(`第 ${o.line} 行的 \`apk add\` 没有 --no-cache`);

  // 2c. python3/make/g++/git 这类只在 build 阶段需要的工具不许出现在运行阶段。
  const BUILD_ONLY = /(?:^|[\s])(python3|make|g\+\+|git|patch|perl)(?=\s|\\|$)/;
  const pkgText = (run) => {
    const m = /(?:apk-setup\.sh|apk\s+add(?:\s+--\S+)*)\s+([\s\S]*)$/.exec(run.raw);
    return m ? m[1].replace(/\\\n/g, ' ') : '';
  };
  const leaked = finalInstalls.filter((ins) => BUILD_ONLY.test(pkgText(ins)));
  if (leaked.length === 0) ok('运行阶段没有装 build 专用工具链（python3/make/g++/git…）');
  else for (const o of leaked) bad(`第 ${o.line} 行的运行阶段安装里出现 build 专用工具：${pkgText(o).trim()}`);
}

head('== 3. 运行阶段不得整目录 COPY 构建上下文里的目录 ==');
{
  // 判据：COPY 的某个源以 `/` 结尾（= 目录），且不是 `--from=` 构建阶段产物。
  const offenders = finalStage.instructions.filter((ins) => {
    if (ins.cmd !== 'COPY' || /--from=/.test(ins.args)) return false;
    const parts = words(ins.args).filter((p) => !p.startsWith('--'));
    return parts.slice(0, -1).some((p) => p.endsWith('/'));
  });
  if (offenders.length === 0) {
    ok('运行阶段只按文件 COPY 脚本，没有把构建上下文里的目录整块拖进来');
  } else {
    for (const o of offenders) {
      const parts = words(o.args).filter((p) => !p.startsWith('--'));
      const dirs = parts.slice(0, -1).filter((p) => p.endsWith('/'));
      bad(`第 ${o.line} 行整目录 COPY 了上下文目录 ${dirs.join(' ')}（会把 build 阶段脚本一起带进镜像）`);
    }
  }
}

head('== 4. 运行阶段不得装开发依赖 ==');
{
  const devish = /(typescript|ts-node|tsconfig-paths|@nestjs\/cli|@nestjs\/schematics|vite|autoprefixer|tailwindcss|playwright)/;
  const offenders = finalStage.instructions.filter((ins) => ins.cmd === 'RUN' && devish.test(ins.raw));
  if (offenders.length === 0) ok('运行阶段的 RUN 里没有开发依赖');
  else for (const o of offenders) bad(`第 ${o.line} 行的 RUN 提到开发依赖（${devish.exec(o.raw)[0]}）`);
}

head('== 5. .dockerignore 是否挡住不该进构建上下文的东西 ==');
{
  const want = [
    ['node_modules', /(^|\n)\s*\*?\*?\/?node_modules\/?\s*$/m],
    ['**/dist', /(^|\n)\s*\*?\*?\/?dist\/?\s*$/m],
    ['.tmp*', /(^|\n)\s*\.tmp\*/m],
    ['.git', /(^|\n)\s*\.git\/?\s*$/m],
    ['docs', /(^|\n)\s*docs\/?\s*$/m],
    // 这两条是「构建上下文只该有几个 MiB」的守门：windows/（du -sh 835 MB ≈ 767.7 MiB，桌面构建链）与
    // .pw/（553.0 MiB / 147 个文件，Playwright Chromium，用它的套件都在宿主机上跑）都不进镜像，
    // 一旦被谁从 .dockerignore 里删掉，每轮构建就要白传约 1.3 GiB（767.7 + 553.0 MiB）。
    ['windows', /(^|\n)\s*windows\/?\s*$/m],
    ['.pw', /(^|\n)\s*\.pw\/?\s*$/m],
  ];
  if (!fs.existsSync(DOCKERIGNORE)) {
    bad('.dockerignore 不存在');
  } else {
    const ig = fs.readFileSync(DOCKERIGNORE, 'utf8');
    for (const [name, re] of want) {
      if (re.test(ig)) ok(`.dockerignore 排除 ${name}`);
      else bad(`.dockerignore 未排除 ${name}`);
    }
  }
}

head('== 6. 部署契约（WORKDIR / CMD / 三个 ENV）没被动过 ==');
{
  const hasWorkdir = finalStage.instructions.some((ins) => ins.cmd === 'WORKDIR' && ins.args.trim() === '/app/backend');
  hasWorkdir ? ok('WORKDIR 仍是 /app/backend') : bad('WORKDIR 不是 /app/backend');

  const cmd = finalStage.instructions.find((ins) => ins.cmd === 'CMD');
  const cmdText = cmd ? cmd.args.replace(/\s+/g, '') : '';
  cmdText === '["node","dist/main.js"]'
    ? ok('CMD 仍是 ["node","dist/main.js"]')
    : bad(`CMD 变成了 ${cmd ? cmd.args : '(缺失)'}`);

  const envText = finalStage.instructions
    .filter((ins) => ins.cmd === 'ENV')
    .map((ins) => ins.args)
    .join('\n');
  for (const kv of ['DATA_DIR=/data', 'MEDIA_DIRS=/media', 'WEB_DIST=/app/public']) {
    const [k, v] = kv.split('=');
    new RegExp(`${k}=${v.replace(/[/]/g, '\\/')}`).test(envText)
      ? ok(`ENV ${kv} 仍在`)
      : bad(`ENV ${kv} 缺失`);
  }
}

head('== 7. apk-setup.sh 用 --no-cache 装包 ==');
{
  if (!fs.existsSync(APK_SETUP)) {
    bad('找不到 scripts/build/apk-setup.sh');
  } else {
    const s = fs.readFileSync(APK_SETUP, 'utf8');
    /apk\s+add\s+--no-cache/.test(s)
      ? ok('apk-setup.sh 内部是 `apk add --no-cache`')
      : bad('apk-setup.sh 里的 apk add 没有 --no-cache');
  }
}

head('== 8. 非运行期文件在 build 阶段删（不在运行阶段制造白洞） ==');
{
  const buildStage = stages[0];
  const NONRUNTIME = /find\s+node_modules[\s\S]*?'\*\.map'[\s\S]*?-delete/;
  const inBuild = buildStage.instructions.filter((ins) => ins.cmd === 'RUN' && NONRUNTIME.test(ins.raw));
  if (inBuild.length > 0) {
    ok(`第 ${inBuild[0].line} 行：build 阶段删掉 node_modules 的 *.map / *.md / *.d.ts（COPY 之前，字节真的不进镜像）`);
  } else {
    bad('build 阶段没有删 node_modules 里的非运行期文件（*.map / *.md / *.d.ts）—— 那 9.84 MiB 会原样进镜像');
  }

  // 运行阶段不得删除被 COPY 进来的载荷（跨层删除 = 白洞层，字节留在 COPY 层里）。
  const PAYLOAD_PATH = /(node_modules|\/app\/public|\bdist\b|build-info\.json)/;
  const whiteholes = [];
  for (const ins of finalStage.instructions) {
    if (ins.cmd !== 'RUN') continue;
    for (const chunk of runBody(ins).split(/&&|;/)) {
      const w = words(chunk);
      const rmAt = w.findIndex((x) => x === 'rm' || x === '/bin/rm');
      const isRm = rmAt === 0;
      const isFindDelete = w[0] === 'find' && /\s-delete\b/.test(chunk);
      if (!isRm && !isFindDelete) continue;
      const targets = w.filter((x) => !x.startsWith('-') && PAYLOAD_PATH.test(x));
      if (targets.length > 0) whiteholes.push({ line: ins.line, targets });
    }
  }
  if (whiteholes.length === 0) {
    ok('运行阶段没有删除 node_modules / dist / public 里的任何东西（那会变成白洞层）');
  } else {
    for (const o of whiteholes) {
      bad(`第 ${o.line} 行的运行阶段删了 ${o.targets.join(' ')} —— 载荷是 COPY 进来的，删除只会加白洞层；请挪到 build 阶段`);
    }
  }
}

head('== 9. 运行阶段基础镜像：最小 alpine + 只拷 node 二进制 ==');
{
  const buildFrom = (stages[0].from || '').trim().split(/\s+/)[0];
  const runFrom = (finalStage.from || '').trim().split(/\s+/)[0];
  const NODE_IMAGE = /node/i;

  if (NODE_IMAGE.test(buildFrom)) {
    ok(`构建阶段仍以 node 镜像为基础（${buildFrom}）：node 二进制从它这里 COPY`);
  } else {
    bad(`构建阶段的基础镜像 "${buildFrom}" 看起来不是 node 镜像 —— 下面就没有 node 二进制可拷了`);
  }

  if (NODE_IMAGE.test(runFrom)) {
    bad(`运行阶段仍以 node 镜像为基础（${runFrom}）—— npm / corepack / node 头文件会随那 148.6 MiB 的基础层进镜像`);
  } else if (/alpine/i.test(runFrom)) {
    ok(`运行阶段用最小基础镜像 ${runFrom}（npm / corepack / node 头文件都不再进镜像）`);
    // 版本必须与构建阶段 `node:22-alpine` 里的 alpine 同版本，否则 apk 会从另一套仓库装包：
    // ffmpeg 会静默跨大版本漂移（v3.22 = 6.1.2-r2 / v3.24 = 8.1.2-r0，已发布镜像跑的是后者）。
    // node 镜像哪天跳到 alpine 3.25，这里要跟着改 —— 这条断言就是那个提醒。
    const RUN_ALPINE = '3.24';
    if (new RegExp(`^[^:]*:${RUN_ALPINE.replace(/\./g, '\\.')}$`).test(runFrom)) {
      ok(`运行阶段 alpine 版本 = ${RUN_ALPINE}（与构建阶段 node:22-alpine 内的 alpine 同版本）`);
    } else {
      bad(
        `运行阶段基础镜像 "${runFrom}" 不是 alpine:${RUN_ALPINE} —— 版本与构建阶段不同会让 apk 从另一套仓库装包` +
          '（ffmpeg：3.22 装 6.1.2-r2，3.24 装 8.1.2-r0，现状是后者）。node:22-alpine 换 alpine 大版本时同步这里。',
      );
    }
  } else {
    bad(`运行阶段基础镜像 "${runFrom}" 既不是 node 镜像也不是 alpine —— 预期形态是 alpine + COPY node 二进制`);
  }

  const copyTokens = (ins) => ins.args.split(/\s+/).filter((t) => !t.startsWith('--'));
  const nodeCopy = finalStage.instructions.find((ins) => {
    if (ins.cmd !== 'COPY' || !/--from=/.test(ins.args)) return false;
    const t = copyTokens(ins);
    return t.length >= 2 && /(^|\/)node$/.test(t[0]) && t[t.length - 1] === '/usr/local/bin/node';
  });
  if (nodeCopy) {
    ok(`第 ${nodeCopy.line} 行：从构建阶段 COPY node 二进制到 /usr/local/bin/node`);
  } else {
    bad('运行阶段没有从构建阶段 COPY node 二进制到 /usr/local/bin/node —— 最小基础镜像里没有 node，容器起不来');
  }

  const apkRuns = finalStage.instructions.filter((ins) => ins.cmd === 'RUN' && /apk-setup\.sh/.test(runBody(ins)));
  if (apkRuns.some((ins) => /apk-setup\.sh\s+[^\n&|;]*libstdc\+\+/.test(runBody(ins)))) {
    ok('运行阶段装了 libstdc++（COPY 进来的 node 二进制的动态依赖；漏装则容器起来就退出）');
  } else {
    bad('运行阶段没有装 libstdc++ —— 搬进来的 node 二进制会加载失败（`node: not found` 那种形态）');
  }

  const forbidden = finalStage.instructions.filter(
    (ins) =>
      ins.cmd === 'COPY' &&
      /(^|[\s/=])(npm|npx|corepack|yarn|pnpm)([\s/]|$)|lib\/node_modules|include\/node/i.test(ins.args),
  );
  if (forbidden.length === 0) {
    ok('运行阶段没有 COPY 任何 npm / corepack / 全局 node_modules（这正是换基础镜像要省掉的部分）');
  } else {
    for (const ins of forbidden) {
      bad(`第 ${ins.line} 行把 npm/corepack 一类东西 COPY 进了运行镜像：${ins.args}`);
    }
  }
}

console.log(`\n\x1b[1m结果：${pass} 项通过 / ${fail} 项失败\x1b[0m`);
if (fail > 0) {
  console.log('\x1b[1;31mDockerfile 分层自查未通过 —— 镜像里会有白洞字节或工具残留。\x1b[0m');
  console.log('排查：把删除动作挪回创建/安装它的那个 RUN；运行阶段只 COPY 真正要用的文件。');
  process.exit(1);
}
console.log('\x1b[1;32mDockerfile 分层自查通过 —— 没有多余的「先拷进来再删掉」白洞字节（唯一保留：构建期必需的 apk-setup.sh，18,471 B）。\x1b[0m');