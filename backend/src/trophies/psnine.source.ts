/**
 * PSNINE (psnine.com, “PSN中文站”) trophy source — HTML scraping.
 *
 * Sony publishes no usable trophy API and the official PSN endpoints are
 * unreliable from mainland China, so PlayStation trophy lists are scraped from
 * psnine. No account or credential is involved: every page used here is public.
 *
 * All requests go through the project's {@link HttpService}, which owns the
 * per-host rate limit (>= 1.2 s by default) and retry/backoff — psnine answers a
 * burst of unthrottled requests by serving a blank or error page, which used to
 * look like “this game has no trophies”.
 *
 * The markup itself is parsed by `psnine.parse.ts`; this class only decides what
 * to request and turns failures into user-facing {@link TrophySourceError}s, since
 * scraping must never fail silently (`games.achievements_error` shows the message).
 */

import { Injectable, Logger } from '@nestjs/common';
import { titleQueryVariants } from '../metadata/providers/metacritic-aliases';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { HttpService } from '../common/http/http.service';
import { countTiers, TrophySourceError } from './trophy-source.interface';
import type {
  TrophyFetchResult,
  TrophySearchHit,
  TrophySource,
} from './trophy-source.interface';
import { PSNINE_SEARCH_LIMIT, parsePsnineGamePage, parsePsnineSearch } from './psnine.parse';

const DEFAULT_BASE_URL = 'https://psnine.com';

/**
 * Used only when the configured `CRAWLER_USER_AGENT` is empty, so the request
 * never goes out as the axios default: psnine blocks anonymous-looking clients,
 * and a descriptive UA is the polite thing to send anyway.
 */
const FALLBACK_USER_AGENT = 'ScreenPlay/0.6 (+personal metadata library)';

/** psnine game ids are the numeric path segment of `/psngame/<id>`. */
const GAME_ID_PATTERN = /^\d+$/;

/** Values that mean “switched off”. */
const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

@Injectable()
export class PsnineTrophySource implements TrophySource {
  readonly name = 'psnine';
  readonly label = 'PSNINE（PSN中文站）';

  private readonly logger = new Logger(PsnineTrophySource.name);

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly http: HttpService,
  ) {}

  /**
   * Site root, overridable with `TROPHY_PSNINE_BASE_URL`.
   *
   * Reachability is network-dependent: the same host can be blocked from one
   * machine and fine from another. Pointing this at a mirror or a local reverse
   * proxy needs no code change.
   */
  private get baseUrl(): string {
    const raw = this.config.get('trophyPsnineBaseUrl', { infer: true }) || DEFAULT_BASE_URL;
    return raw.trim().replace(/\/+$/, '');
  }

  get enabled(): boolean {
    // Public data, no credential — on by default. `ConfigService.get()` falls
    // through to `process.env` and the loaded `.env`, so the site can be switched
    // off with `TROPHY_PSNINE_DISABLED=1` without touching configuration.ts.
    return !this.config.get('trophyPsnineDisabled', { infer: true });
  }

  /**
   * Find candidate games for a title.
   *
   * psnine filters on the `title` query parameter (`q` is silently ignored and
   * returns the whole catalogue). No match is a normal outcome, not an error.
   */
  async search(name: string): Promise<TrophySearchHit[]> {
    const title = (name ?? '').trim();
    if (!title) return [];

    // Try the title as given first (psnine is a Chinese site, so a Chinese name
    // is the best query), then fall back to the shared CJK/Latin variants. The
    // fallback is what rescues library folders whose name does not match the
    // site's spelling — e.g. an English folder name for a Chinese entry.
    const queries = [title, ...titleQueryVariants(title).filter((q) => q !== title)].slice(0, 3);
    let hits: TrophySearchHit[] = [];
    for (const q of queries) {
      const html = await this.getHtml(`${this.baseUrl}/psngame`, { title: q }, `搜索「${q}」`);
      hits = parsePsnineSearch(html, PSNINE_SEARCH_LIMIT);
      if (hits.length) return hits;
    }
    this.logger.debug(`No psnine match for "${title}" (tried: ${queries.join(' / ')})`);
    return hits;
  }

  /** Fetch and parse one game's trophy list. */
  async fetch(externalId: string): Promise<TrophyFetchResult> {
    const id = (externalId ?? '').trim();
    // A non-numeric id cannot exist on psnine; failing loudly beats requesting
    // `/psngame/undefined` and reporting “this game has no trophies”.
    if (!GAME_ID_PATTERN.test(id)) {
      throw new TrophySourceError(
        `PSNINE 游戏 ID 无效：「${externalId}」，PSNINE 的游戏 ID 必须是纯数字`,
        this.name,
      );
    }

    const url = `${this.baseUrl}/psngame/${id}`;
    const html = await this.getHtml(url, {}, `获取奖杯列表（游戏 ID ${id}）`);
    const page = parsePsnineGamePage(html);

    if (page.rowCount === 0) {
      // psnine answers an unknown id with HTTP 200 and a “PSN游戏不存在” page, so
      // the absence of `<tr class="trophy">` rows is the only usable signal here.
      throw new TrophySourceError(
        `PSNINE 页面没有奖杯列表：游戏 ID ${id} 可能不存在${
          page.gameTitle ? `（页面标题「${page.gameTitle}」）` : ''
        }，或网站结构已变更`,
        this.name,
      );
    }
    if (page.achievements.length === 0) {
      throw new TrophySourceError(
        `PSNINE 页面找到 ${page.rowCount} 条奖杯记录但全部无法解析，网站页面结构可能已变更`,
        this.name,
      );
    }

    // Counts come from the parsed rows (exact); the header tally is decoration and
    // is only compared to surface a layout change in the logs.
    const counts = countTiers(page.achievements);
    if (page.headerCounts && page.headerCounts.total !== counts.total) {
      this.logger.warn(
        `psnine header tally (${page.headerCounts.total}) disagrees with parsed rows ` +
          `(${counts.total}) for game ${id}; the rows are authoritative`,
      );
    }

    return {
      source: this.name,
      // `<title>` is the only place the canonical name appears verbatim.
      title: page.gameTitle ?? id,
      url,
      achievements: page.achievements,
      counts,
    };
  }

  /**
   * GET a page as text, mapping every failure to a user-facing error.
   *
   * `what` names the operation in Chinese (it ends up in the message shown on the
   * detail page), and the HTTP status is kept as the error's third argument so
   * callers can distinguish "blocked/rate limited" from "game missing".
   */
  private async getHtml(
    url: string,
    params: Record<string, string>,
    what: string,
  ): Promise<string> {
    let data: unknown;
    try {
      const res = await this.http.get<string>(url, {
        params,
        responseType: 'text',
        // psnine serves UTF-8; pinning the decoding keeps a proxy that strips the
        // charset header from mangling every Chinese title into mojibake.
        responseEncoding: 'utf8',
        headers: this.requestHeaders,
      });
      data = res.data;
    } catch (err) {
      const status = errorStatus(err);
      const reason = err instanceof Error ? err.message : String(err);
      throw new TrophySourceError(
        `PSNINE ${what}失败：${status ? `HTTP ${status}，` : ''}${reason}`,
        this.name,
        status,
      );
    }

    const html = typeof data === 'string' ? data : '';
    if (html.trim() === '') {
      // A 200 with no body is typical of an anti-bot/proxy interstitial, and
      // parsing it would only produce a misleading “no trophies” error.
      throw new TrophySourceError(
        `PSNINE ${what}失败：服务器返回了空页面，可能被拦截或需要代理`,
        this.name,
      );
    }
    return html;
  }

  private get requestHeaders(): Record<string, string> {
    // HttpService already sends the configured UA; only step in when it is empty.
    const configured = (this.config.get('crawlerUserAgent', { infer: true }) || '').trim();
    return configured ? {} : { 'User-Agent': FALLBACK_USER_AGENT };
  }
}

/** True for the usual “off” spellings; anything else (or undefined) is “on”. */
function isTruthy(value: string | undefined): boolean {
  return TRUTHY.has((value ?? '').trim().toLowerCase());
}


/** HTTP status from an axios-shaped error, without importing axios here. */
function errorStatus(err: unknown): number | undefined {
  const status = (err as { response?: { status?: unknown } } | null)?.response?.status;
  return typeof status === 'number' ? status : undefined;
}