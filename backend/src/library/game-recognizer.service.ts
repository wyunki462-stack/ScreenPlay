/**
 * Game-name recognition.
 *
 * Media on disk uses messy scene/steam naming: `Grand.Theft.Auto.V.CODEX`,
 * `The_Witcher_3_[v4.04]_Repack_1080p`, etc. This module normalises such names
 * by stripping version strings, resolution suffixes, crack-group tags and
 * edition markers, then uses fuse.js to fuzzy-match against a known title list
 * (fed by the metadata providers) so the display name converges on a canonical,
 * de-duplicated title.
 */

import { Injectable, Logger } from '@nestjs/common';
import Fuse from 'fuse.js';

/** Well-known crack/repack groups and scene tags. */
const GROUP_TAGS = [
  'codex', 'plaza', 'skidrow', 'reloaded', 'razor1911', 'razor', 'dark0',
  'darksiders', 'cpy', 'hoodlum', 'dodi', 'elamigos', 'fitgirl', 'masquerade',
  'tinyiso', 'rune', 'empress', 'flt', 'prophet', 'altyx', 'tenoke', 'goldberg',
  'chronos', 'kaoskrew', 'st-games',
].map((t) => new RegExp(`(^|[\\s._\\[\\]()-])${t}($|[\\s._\\[\\]()-])`, 'i'));

/**
 * Common edition suffixes that don't change the core title.
 *
 * The lone word `edition` matters: real library entries look like
 * "Bloodborne™ The Old Hunters Edition", and without it the suffix survived
 * normalization and dragged the fuzzy score down to 0.52, which made the
 * Metacritic provider reject an otherwise valid match.
 */
const EDITION_TAGS = [
  'goty', 'edition', 'game of the year edition', 'complete edition', 'deluxe edition',
  'ultimate edition', 'definitive edition', 'remastered', 'remaster', 'repack', 'proper',
  'multi10', 'multi 10', 'multilingual', 'eno', 'drm-free', 'drm free',
  // Chinese edition markers, so CJK titles normalize consistently as well.
  '完全版', '豪华版', '决定版', '终极版', '重制版', '年度版', '合辑', '合集',
];

@Injectable()
export class GameRecognizerService {
  private readonly logger = new Logger(GameRecognizerService.name);

  /**
   * Normalize a raw folder/file name into a clean display title.
   * Returns at most one canonical name; edge tokens are dropped (but stored as
   * aliases by the caller if desired).
   */
  normalize(raw: string): string {
    if (!raw) return '未命名游戏';
    let name = raw.trim();

    // Strip bracketed blocks that are metadata, not titles.
    name = name.replace(/\[[^\]]*\]/g, ' ').replace(/\([^)]*\)/g, ' ');

    // Drop version strings FIRST (while dots are still intact): v1.2.3, 1.2.3.
    // Use alnum lookarounds (not \b) because scene names delimit with
    // underscores, which are word characters and defeat \b.
    name = name.replace(/(?<![A-Za-z0-9])v?\d+(?:\.\d+)+(?![A-Za-z0-9])/g, ' ');

    // Scene convention: dots / underscores separate words.
    name = name.replace(/_/g, ' ').replace(/\./g, ' ');

    // Drop build / release tokens: build 12345, r1234
    name = name.replace(/\bbuild\s*\d+/gi, ' ');
    name = name.replace(/\br\d+\b/gi, ' ');

    // Drop resolution / framerate tokens: 4K, 2160p, 1080p, 60fps…
    name = name.replace(/\b\d{3,4}p\b/gi, ' ');
    name = name.replace(/\b\d{3,4}x\d{3,4}\b/g, ' ');
    name = name.replace(/\b[4-8]k\b/gi, ' ');
    name = name.replace(/\b\d{2,3}fps\b/gi, ' ');

    // Drop crack-group tags.
    for (const tag of GROUP_TAGS) name = name.replace(tag, ' ');

    // Drop edition / repack markers (boundary-aware).
    //
    // `\b` is useless for CJK: a Han character is not a word character in JS
    // regex, so `\b完全版\b` never matches and Chinese edition tags would be
    // dead code. Use an explicit "not preceded/followed by a letter or digit"
    // guard, which behaves correctly for both Latin and Han text.
    for (const tag of EDITION_TAGS) {
      const body = tag.replace(/ /g, '\\s*');
      name = name.replace(
        new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'giu'),
        ' ',
      );
    }

    // Drop common wrappers like "GOG Edition".
    name = name.replace(/\bgog\b/gi, ' ');

    // Collapse whitespace and punctuation leftovers.
    name = name.replace(/[^\p{L}\p{N}\p{M}'’\- :+!™®©]/gu, ' ');
    name = name.replace(/\s{2,}/g, ' ').trim();
    // Strip dangling leading/trailing separators left by removed group tags
    // (e.g. "Red Dead Redemption 2 -" → "Red Dead Redemption 2").
    name = name.replace(/^[-–—:+\s]+|[-–—:+\s]+$/g, '').trim();

    // Only normalise case for scene-style names (all-upper like "GRAND.THEFT.AUTO"
    // or all-lower like "the_witcher_3"). Preserve names that are already
    // human-cased ("God of War Ragnarök") so minor words and stylised case stay
    // intact instead of being force-cased to "God Of War Ragnarök".
    const hasUpper = /\p{Lu}/u.test(name);
    const hasLower = /\p{Ll}/u.test(name);
    if (!hasUpper || !hasLower) {
      name = this.titleCase(name);
    }

    return name || '未命名游戏';
  }

  /** Fuzzy-match a candidate name against a list of known titles. */
  fuzzyMatch<T>(candidate: string, items: T[], getTitle: (item: T) => string): {
    item: T | null;
    score: number; // 0..1 (higher = better)
  } {
    if (!candidate || items.length === 0) return { item: null, score: 0 };
    const indexed = items.map((item) => ({ item, title: getTitle(item) }));
    const fuse = new Fuse(indexed, {
      keys: ['title'],
      threshold: 0.4,
      ignoreLocation: true,
      includeScore: true,
    });
    const result = fuse.search(candidate, { limit: 1 })[0];
    if (!result) return { item: null, score: 0 };
    return { item: result.item.item, score: 1 - (result.score ?? 0) };
  }

  private readonly minorWords = new Set([
    'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'if', 'in',
    'of', 'on', 'or', 'the', 'to', 'via', 'vs', 'with',
  ]);

  private titleCase(input: string): string {
    // Capitalise the first letter of each word but keep English minor words
    // lowercase ("God of War", not "God Of War"), preserve roman numerals and
    // accented letters (é, ö, …) as-is. CJK passes through unchanged.
    let first = true;
    return input.replace(/[\p{L}][\p{L}'’]*/gu, (word) => {
      const upper = word.toUpperCase();
      const lower = word.toLowerCase();
      let out: string;
      if (/^[IVXLCDM]+$/i.test(word) && word.length <= 4) {
        out = upper;
      } else if (!first && this.minorWords.has(lower)) {
        out = lower;
      } else {
        out = word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
      }
      first = false;
      return out;
    });
  }
}