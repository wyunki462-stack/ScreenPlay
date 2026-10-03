/**
 * Curated CJK → Latin title aliases for Metacritic lookups.
 *
 * WHY THIS EXISTS
 * ---------------
 * Metacritic's search endpoint takes a **slug**, not a free-text query
 * (`/search/<slug>/`), and its catalogue is indexed by English titles only.
 * A Chinese/Japanese/Korean title therefore produces either an empty slug
 * ("宇宙机器人" → "") or a junk one ("女神异闻录5皇家版" → "5"), and the response
 * is a handful of unrelated games. Verified directly against the live site:
 *
 *   /search/<encoded CJK>/  →  2 unrelated cards ("-2025", "-5")
 *   /search/astro-bot/      →  23 relevant cards
 *
 * So no amount of parsing can recover a score for a CJK-named entry: the
 * English title has to be supplied. This table supplies it for the common
 * cases, which is what lets a Chinese-language library show Metascores at all.
 *
 * Matching is exact on a normalized key (case/™®©/punctuation-insensitive), so
 * "機戰傭兵™VI 境界天火™" and "機戰傭兵VI 境界天火" both resolve.
 *
 * EXTENDING
 * ---------
 * This table is a convenience default, not a closed set — anything missing can
 * be matched manually from the UI ("匹配数据源"/重命名 followed by 刷新元数据),
 * which stores a durable binding and never needs this list. Add entries here
 * when a title is common enough to deserve automatic resolution.
 */

/** normalized CJK (or mixed) title → English title Metacritic indexes. */
const CJK_TITLE_ALIASES: Record<string, string> = {
  // ── Simplified Chinese ──────────────────────────────────────────────
  '007初露锋芒': '007 First Light',
  宇宙机器人: 'Astro Bot',
  宇宙机器人无线控制器使用指南: 'Astro Bot Rescue Mission',
  宝可梦紫: 'Pokemon Violet',
  宝可梦朱: 'Pokemon Scarlet',
  星之卡比探索发现: 'Kirby and the Forgotten Land',
  赛博朋克2077: 'Cyberpunk 2077',
  女神异闻录5皇家版: 'Persona 5 Royal',
  女神异闻录5: 'Persona 5',
  命运2: 'Destiny 2',
  无双深渊: 'Dynasty Warriors: Abyss',
  沙罗周期: 'Saros',
  逆转裁判456王泥喜精选集: 'Apollo Justice: Ace Attorney Trilogy',
  马力欧vs咚奇刚: 'Mario vs. Donkey Kong',
  天国拯救2: 'Kingdom Come: Deliverance II',
  天国拯救: 'Kingdom Come: Deliverance',
  'uncharted盗贼传奇合辑': 'Uncharted: Legacy of Thieves Collection',
  盗贼传奇合辑: 'Uncharted: Legacy of Thieves Collection',
  神秘海域4盗贼末路: 'Uncharted 4: A Thief’s End',
  最后的生还者: 'The Last of Us',
  最后的生还者2: 'The Last of Us Part II',
  战神诸神黄昏: 'God of War Ragnarok',
  战神: 'God of War',
  艾尔登法环: 'Elden Ring',
  只狼影逝二度: 'Sekiro: Shadows Die Twice',
  黑暗之魂3: 'Dark Souls III',
  血源诅咒: 'Bloodborne',
  漫威蜘蛛侠: 'Marvel’s Spider-Man',
  漫威蜘蛛侠2: 'Marvel’s Spider-Man 2',
  漫威蜘蛛侠迈尔斯莫拉莱斯: 'Marvel’s Spider-Man: Miles Morales',
  地平线西之绝境: 'Horizon Forbidden West',
  地平线零之曙光: 'Horizon Zero Dawn',
  对马岛之魂: 'Ghost of Tsushima',
  羊蹄山之魂: 'Ghost of Yotei',
  死亡搁浅2: 'Death Stranding 2: On the Beach',
  死亡搁浅: 'Death Stranding',
  恶魔之魂: 'Demon’s Souls',
  最终幻想7重制版: 'Final Fantasy VII Remake',
  最终幻想16: 'Final Fantasy XVI',
  塞尔达传说旷野之息: 'The Legend of Zelda: Breath of the Wild',
  塞尔达传说王国之泪: 'The Legend of Zelda: Tears of the Kingdom',
  超级马力欧奥德赛: 'Super Mario Odyssey',
  怪物猎人荒野: 'Monster Hunter Wilds',
  生化危机4: 'Resident Evil 4',
  巫师3狂猎: 'The Witcher 3: Wild Hunt',
  荒野大镖客2: 'Red Dead Redemption 2',
  刺客信条幻景: 'Assassin’s Creed Mirage',
  刺客信条英灵殿: 'Assassin’s Creed Valhalla',
  刺客信条奥德赛: 'Assassin’s Creed Odyssey',
  地平线: 'Horizon Zero Dawn',
  极限竞速地平线5: 'Forza Horizon 5',
  微软飞行模拟: 'Microsoft Flight Simulator',
  光环无限: 'Halo Infinite',
  星空: 'Starfield',
  死亡回归: 'Returnal',
  瑞奇与叮当时空跳转: 'Ratchet & Clank: Rift Apart',
  麻布仔大冒险: 'Sackboy: A Big Adventure',
  尘埃终成: 'Neva',
  需要正义: 'Indika',

  // ── Traditional Chinese ─────────────────────────────────────────────
  機戰傭兵VI境界天火: 'Armored Core VI: Fires of Rubicon',
  機戰傭兵境界天火: 'Armored Core VI: Fires of Rubicon',
  最終幻想7重製版: 'Final Fantasy VII Remake',
  惡魔靈魂: 'Demon’s Souls',
  對馬戰鬼: 'Ghost of Tsushima',
  戰神諸神黃昏: 'God of War Ragnarok',
  地平線西域禁地: 'Horizon Forbidden West',
  秘境探險盜賊傳奇合輯: 'Uncharted: Legacy of Thieves Collection',
  跑車浪漫旅7: 'Gran Turismo 7',
  拉捷特與克拉克時空裂縫: 'Ratchet & Clank: Rift Apart',

  // ── Japanese (romanized/latin titles Metacritic indexes) ─────────────
  ゼルダの伝説ブレスオブザワイルド: 'The Legend of Zelda: Breath of the Wild',
  ゼルダの伝説ティアーズオブザキングダム: 'The Legend of Zelda: Tears of the Kingdom',
  ファイナルファンタジー16: 'Final Fantasy XVI',
  エルデンリング: 'Elden Ring',
  モンスターハンターワイルズ: 'Monster Hunter Wilds',
  ペルソナ5ザロイヤル: 'Persona 5 Royal',
};

/** Strip ™/®/©, punctuation, spaces and case so aliases match loosely. */
export function aliasKey(raw: string): string {
  return (raw || '')
    // Remove ™/®/© BEFORE any normalization: NFKC decomposes "™" into the
    // literal letters "TM" (and "©" into "(C)"), which would corrupt the key
    // for titles like "機戰傭兵™VI 境界天火™".
    .replace(/[\u2122\u00ae\u00a9]/g, '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

/**
 * Resolve a title to the English name Metacritic indexes, or null when the
 * title is already Latin (nothing to translate) or unknown.
 *
 * Lookup is by normalized key first, then by prefix so that a title carrying an
 * extra marker still resolves: "機戰傭兵™VI 境界天火™" normalizes to
 * "機戰傭兵vi境界天火", which does not equal the table key "機戰傭兵境界天火",
 * but does start with the table's CJK prefix. Matching on the longest table key
 * that is a prefix of the input keeps that working without letting a short key
 * hijack a longer title.
 */
export function resolveMetacriticAlias(raw: string): string | null {
  const key = aliasKey(raw);
  if (!key) return null;
  const direct = CJK_TITLE_ALIASES[key];
  if (direct) return direct;

  // Longest-prefix fallback for titles with embedded latin markers.
  let best: { len: number; value: string } | null = null;
  for (const [k, v] of Object.entries(CJK_TITLE_ALIASES)) {
    // Compare on the CJK-leading portion only, so "vi" inside the input does
    // not prevent the match.
    const cjkPrefix = k.match(/^[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]+/)?.[0];
    if (!cjkPrefix || cjkPrefix.length < 3) continue;
    if (key.startsWith(cjkPrefix) && (!best || cjkPrefix.length > best.len)) {
      best = { len: cjkPrefix.length, value: v };
    }
  }
  return best?.value ?? null;
}

/**
 * The longest run of Latin letters/digits in a title.
 *
 * Used as a secondary search query for mostly non-Latin names
 * (e.g. "機戰傭兵™VI 境界天火™" → "VI"). Deliberately a plain function rather
 * than a method so every provider can share it.
 */
export function latinFragment(raw: string): string {
  const runs = (raw || '').match(/[A-Za-z][A-Za-z0-9'’\-:! ]*[A-Za-z0-9]|[A-Za-z0-9]{2,}/g) ?? [];
  return runs
    .map((r) => r.trim())
    .sort((a, b) => b.length - a.length)[0] ?? '';
}

/**
 * Build the search queries to try for a title, best first.
 *
 * RAWG and Steam index Latin titles and rank by text similarity, so feeding
 * them a pure-CJK name returns unrelated games rather than nothing: measured
 * against the live APIs, "命运2" resolved to "Fateline(命运线)" on RAWG and to
 * an unrelated visual novel on Steam, while "Destiny 2" resolved correctly on
 * both. The Metacritic provider already solved this with the alias table; this
 * exposes the same resolution so every provider benefits, which is what makes
 * manual matching work for a Chinese-named library.
 *
 * Order:
 *  1. the curated English alias, when one exists;
 *  2. a distinctive Latin fragment inside a CJK title (>= 4 chars);
 *  3. the original title — correct for Latin names, harmless otherwise.
 *
 * `titleQueryCandidates` is the raw ordered list; callers that need to
 * de-duplicate (by alias key, by URL slug, …) key that list themselves, so the
 * strategy above — the length/script thresholds in particular — lives in one place.
 */
export function titleQueryCandidates(raw: string): string[] {
  const out: string[] = [];
  const push = (q: string) => {
    const t = (q || '').trim();
    if (t) out.push(t);
  };

  push(resolveMetacriticAlias(raw) ?? '');
  const latin = latinFragment(raw);
  if (latin && latin.length >= 4 && /\p{L}/u.test(latin)) push(latin);
  push(raw);
  return out;
}

/** The same candidates, de-duplicated case/™-insensitively via `aliasKey`. */
export function titleQueryVariants(raw: string): string[] {
  const out: string[] = [];
  for (const q of titleQueryCandidates(raw)) {
    if (out.some((o) => aliasKey(o) === aliasKey(q))) continue;
    out.push(q);
  }
  return out;
}
