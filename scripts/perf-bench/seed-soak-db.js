/**
 * 富 schema 基准库：给长跑 / 泄漏扫描（scripts/perf-bench/bench-soak.sh）用，比
 * seed-bench-db.js 的真实度高，能覆盖 detail / media / neighbors / 缩略图这些路径。
 *
 *   node scripts/perf-bench/seed-soak-db.js
 *
 * 关键点：表结构不是手抄的，而是**从产品代码里抽出来的** ——
 * 读 backend/src/database/database.service.ts 的 `private migrate()` 方法体，
 * 把其中的 `this.db.exec(\`…\`)` 模板原样执行，再把每一条
 * `this.addColumnIfMissing('表','列','定义')` 变成 `ALTER TABLE 表 ADD COLUMN 列 定义`。
 * 这样库里就有真实的 games / media / game_posters / rating_targets / settings / auth_* 等表，
 * 产品代码怎么改这里都跟着走，不会悄悄失真。
 *
 * 环境变量：SOAK_DB（默认 /tmp/perf-soak/screenplay.db）、SOAK_MEDIA_ROOT（默认 /tmp/perf-soak-media）、
 *          SOAK_GAMES（默认 500）、SOAK_MEDIA_PER_GAME（默认 3）。
 * 媒体文件是真的：每个 media 行对应一张真实存在的小 JPEG（用 sharp 生成，三种字节复用），
 * 这样 /api/media/:id/thumbnail 会真的走一遍 sharp 派生管线。
 */
const Module = require('module');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const SHIM = path.join(ROOT, 'backend', 'scripts', 'verify', 'sqlite-shim.js');
const orig = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  return request === 'better-sqlite3' ? SHIM : orig.call(this, request, ...args);
};

const DB = require('better-sqlite3');
const sharp = require('sharp');

const FILE = process.env.SOAK_DB || '/tmp/perf-soak/screenplay.db';
const MEDIA_ROOT = process.env.SOAK_MEDIA_ROOT || '/tmp/perf-soak-media';
const GAMES = Number(process.env.SOAK_GAMES || 500);
const PER_GAME = Number(process.env.SOAK_MEDIA_PER_GAME || 3);

fs.mkdirSync(path.dirname(FILE), { recursive: true });
fs.rmSync(FILE, { force: true });
fs.mkdirSync(MEDIA_ROOT, { recursive: true });

// ---------- 1) 从产品代码抽 schema ----------
const SRC = fs.readFileSync(path.join(ROOT, 'backend', 'src', 'database', 'database.service.ts'), 'utf8');
const start = SRC.indexOf('private migrate(): void {');
if (start < 0) throw new Error('没找到 migrate()，schema 抽取失败');
const rest = SRC.slice(start + 10);
const end = rest.indexOf('\n  private ');
const body = end < 0 ? rest : rest.slice(0, end);

const db = new DB(FILE);
const ddl = [...body.matchAll(/this\.db\.exec\(\s*`([\s\S]*?)`\s*\)/g)].map((m) => m[1]);
if (!ddl.length) throw new Error('migrate() 里没抽到 exec 模板');
for (const sql of ddl) db.exec(sql);

const alters = [...body.matchAll(/this\.addColumnIfMissing\('([^']+)',\s*'([^']+)',\s*("?[^'"]*"?|[^)]+)\)/g)];
let alterOk = 0;
for (const [, table, column, rawDef] of alters) {
  // 定义在源码里可能是 "TEXT NOT NULL DEFAULT '[]'" 或 'INTEGER'，去掉最外层引号再拼 ALTER，
  // 否则 SQLite 会把整串当成一个「类型名」，NOT NULL / DEFAULT 就丢了。
  let def = rawDef.trim();
  if ((def.startsWith('"') && def.endsWith('"')) || (def.startsWith("'") && def.endsWith("'"))) def = def.slice(1, -1);
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
    alterOk++;
  } catch (e) {
    if (!/duplicate column/i.test(String(e))) throw e;
  }
}
console.log(`schema：${ddl.length} 段 DDL + ${alterOk}/${alters.length} 条 ADD COLUMN（来自 migrate()）`);

// ---------- 2) 真实媒体文件 ----------
const sizes = [[1920, 1080], [1280, 720], [800, 600]];
const JPEGS = [];
for (let k = 0; k < PER_GAME; k++) {
  const [w, h] = sizes[k % sizes.length];
  JPEGS.push(
    sharp({ create: { width: w, height: h, channels: 3, background: { r: 20 + k * 60, g: 90, b: 140 } } })
      .jpeg({ quality: 82 })
      .toBuffer()
      .then((buf) => {
        JPEGS[k] = buf;
        return buf;
      }),
  );
}
const big = (n, c) => c.repeat(n);
const NOW = Date.UTC(2026, 2, 1, 0, 0, 0);

(async () => {
  const jpegs = await Promise.all(JPEGS);
  const insG = db.prepare(`INSERT INTO games (id, folder_name, folder_path, name, platform, aliases,
    manual_override, first_played_at, last_played_at, duration_seconds, main_duration_seconds,
    completionist_duration_seconds, poster_url, summary, developers, publishers, release_date,
    voice_actors, screenshots, main_story_hours, main_extra_hours, completionist_hours, ratings,
    prices, last_meta_refresh, meta_error, created_at, updated_at, platforms, poster_mode,
    custom_platform, custom_order, duration_source)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insM = db.prepare(`INSERT INTO media (id, game_id, file_name, file_path, type, mime_type,
    width, height, size_bytes, file_created_at, duration_seconds, thumb_path, cover_path, sort_order, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  db.exec('BEGIN');
  for (let i = 0; i < GAMES; i++) {
    const id = `11111111-2222-3333-4444-${String(i).padStart(12, '0')}`;
    const dir = path.join(MEDIA_ROOT, `Game ${i}`);
    fs.mkdirSync(dir, { recursive: true });
    insG.run(
      id, `Game ${i}`, dir, `Game ${i}`, 'PC', '[]', i % 7 === 0 ? 1 : 0,
      NOW - 86400000 * (i % 30), NOW - 3600000 * (i % 24), 3600 + i, 1800 + i, 5400 + i,
      `https://media.rawg.io/x${i}.jpg`, big(2048, 's'), '["Studio"]', '["Publisher"]', '2020-01-01',
      big(512, 'v'), JSON.stringify(Array.from({ length: 20 }, (_, k) => `https://x/${i}/${k}.jpg`)),
      12.5, 25.5, 60.5,
      JSON.stringify([{ source: 'metacritic', score: 70 + (i % 30), metascore: 60 + (i % 40) }]),
      JSON.stringify({ steam: '¥ 98' }), NOW, null, NOW, NOW, '["PC"]', 'single', 0, i, 'steam',
    );
    for (let m = 0; m < PER_GAME; m++) {
      const file = path.join(dir, `s${m}.jpg`);
      fs.writeFileSync(file, jpegs[m % jpegs.length]);
      insM.run(
        `99999999-8888-7777-6666-${String(i * 10 + m).padStart(12, '0')}`, id, `s${m}.jpg`, file,
        'image', 'image/jpeg', sizes[m % sizes.length][0], sizes[m % sizes.length][1],
        jpegs[m % jpegs.length].length, NOW - 86400000, null, null, null, m, NOW,
      );
    }
  }
  db.exec('COMMIT');

  const g = db.prepare('SELECT COUNT(*) AS c FROM games').get().c;
  const mm = db.prepare('SELECT COUNT(*) AS c FROM media').get().c;
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
  console.log(`games: ${g} media: ${mm}（每行一张真实 JPEG）`);
  console.log(`表：${tables.join(', ')}`);
  console.log(`DB: ${FILE}`);
  console.log(`媒体根: ${MEDIA_ROOT}`);
})();