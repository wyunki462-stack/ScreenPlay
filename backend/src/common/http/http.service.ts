/**
 * HTTP client with built-in per-host rate limiting and retry/backoff.
 *
 * - Enforces a minimum interval between requests to the same origin
 *   (crawler hygiene: bot-like politeness, default >= 1s).
 * - Retries transient failures (network errors, 5xx, 429) with exponential
 *   backoff and honours the `Retry-After` header on 429 responses.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, {
  AxiosInstance,
  AxiosProxyConfig,
  AxiosRequestConfig,
  AxiosResponse,
} from 'axios';
import { AppConfig } from '../../config/configuration';
import { hostOf, isPrivateOrLocalHost, parseProxyConfig } from './proxy-config';

const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

@Injectable()
export class HttpService {
  private readonly logger = new Logger(HttpService.name);
  private readonly client: AxiosInstance;
  private readonly minIntervalMs: number;
  private readonly maxRetries: number;
  private readonly lastAccess = new Map<string, number>();
  /** Runtime proxy (from RAWG_PROXY or HTTP(S)_PROXY); '' means direct. */
  private readonly proxyUrl: string;

  constructor(config: ConfigService<AppConfig, true>) {
    this.minIntervalMs = config.get('crawlerMinIntervalMs', { infer: true });
    this.maxRetries = config.get('crawlerMaxRetries', { infer: true });
    // Apply the configured runtime proxy explicitly, for the same reason as the
    // image fetcher: we must not depend on ambient HTTP_PROXY/HTTPS_PROXY env
    // vars, which would also proxy loopback/self requests if NO_PROXY were
    // missing or misconfigured. Private/LAN hosts are never proxied.
    this.proxyUrl = (config.get('rawgProxy', { infer: true }) || '').trim();
    this.client = axios.create({
      timeout: 20_000,
      maxRedirects: 5,
      headers: {
        'User-Agent': config.get('crawlerUserAgent', { infer: true }),
        Accept: 'application/json, text/html, */*',
      },
    });
  }

  /** Proxy to use for one request, or undefined to go direct. */
  private proxyFor(url: string): AxiosProxyConfig | undefined {
    if (!this.proxyUrl) return undefined;
    const host = hostOf(url);
    if (host === null || isPrivateOrLocalHost(host)) return undefined;
    return parseProxyConfig(this.proxyUrl);
  }

  /**
   * Perform a GET with rate limiting + retries. Returns the response for the
   * caller to parse (text via `responseType` default json is the axios default;
   * pass `responseType: 'text'` for HTML scraping).
   */
  async get<T = unknown>(
    url: string,
    options: AxiosRequestConfig = {},
  ): Promise<AxiosResponse<T>> {
    return this.request<T>(
      () => this.client.get<T>(url, this.withProxy(url, options)),
      url,
    );
  }

  /**
   * POST with the same rate limiting + retry behaviour (used by IGDB's
   * Apicalypse query endpoint and Twitch OAuth).
   */
  async post<T = unknown>(
    url: string,
    data: unknown,
    options: AxiosRequestConfig = {},
  ): Promise<AxiosResponse<T>> {
    return this.request<T>(
      () => this.client.post<T>(url, data, this.withProxy(url, options)),
      url,
    );
  }

  /**
   * One-shot GET for best-effort fetches (e.g. proxying poster images): no
   * retry/backoff and a short timeout, so a blocked CDN fails fast instead of
   * hanging the client for minutes. Callers treat a rejection as "try a
   * fallback".
   */
  async getOnce<T = unknown>(
    url: string,
    options: AxiosRequestConfig = {},
  ): Promise<AxiosResponse<T>> {
    // getOnce skipped the throttle entirely, so a bulk scrape could fire every
    // concurrent request at the same origin at once. Metacritic answers such
    // bursts by returning an empty/blocked page, which surfaced as "no score"
    // rather than as an error.
    await this.throttle(url);
    return this.client.get<T>(url, {
      ...this.withProxy(url, options),
      timeout: options.timeout ?? 15_000,
    });
  }

  /**
   * One-shot POST with the same spirit as `getOnce`: throttled, short timeout,
   * no retry/backoff.
   *
   * Callers that manage their own retry loop need this — HLTB rejects a stale
   * search token with 403 and the only correct response is to fetch a NEW token
   * and retry, which the generic backoff in `post()` cannot do. Passing
   * `validateStatus` lets such a caller inspect the status instead of catching.
   */
  async postOnce<T = unknown>(
    url: string,
    data: unknown,
    options: AxiosRequestConfig = {},
  ): Promise<AxiosResponse<T>> {
    await this.throttle(url);
    return this.client.post<T>(url, data, {
      ...this.withProxy(url, options),
      timeout: options.timeout ?? 15_000,
    });
  }

  /**
   * Attach the proxy (or an explicit `proxy: false`) to a request config.
   * An explicit value always wins, so callers with special needs keep control.
   */
  private withProxy<T extends AxiosRequestConfig>(url: string, options: T): T {
    if (options.proxy !== undefined) return options;
    return { ...options, proxy: this.proxyFor(url) ?? false };
  }

  private async request<T>(
    fn: () => Promise<AxiosResponse<T>>,
    url: string,
  ): Promise<AxiosResponse<T>> {
    await this.throttle(url);
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        return await fn();
      } catch (err) {
        const status = axios.isAxiosError(err) ? err.response?.status : undefined;
        const retryable =
          axios.isAxiosError(err) &&
          (!err.response || (status && TRANSIENT_STATUS.has(status)));
        if (!retryable || attempt >= this.maxRetries) throw err;

        const retryAfter = this.parseRetryAfter(
          axios.isAxiosError(err) ? err.response : undefined,
        );
        const backoff = retryAfter ?? Math.min(60_000, 1000 * 2 ** attempt);
        this.logger.warn(
          `Request to ${url} failed (status=${
            status ?? 'network'
          }), retrying in ${backoff}ms (attempt ${attempt + 1}/${this.maxRetries})`,
        );
        await sleep(backoff);
        attempt += 1;
      }
    }
  }

  /**
   * Enforce the per-origin minimum interval.
   *
   * The timestamp must be claimed SYNCHRONOUSLY, before any await, otherwise
   * concurrent callers all read the same stale value, all decide no wait is
   * needed, and all fire at once — defeating the rate limit entirely. That
   * burst is what made Metacritic start dropping requests (a scrape then
   * silently returns nothing) whenever a bulk refresh ran with concurrency > 1.
   *
   * Reserving the next free instant per origin up-front serializes N concurrent
   * calls `minIntervalMs` apart, which is the intent of the limiter.
   */
  private async throttle(url: string): Promise<void> {
    const origin = originOf(url);
    const now = Date.now();
    const last = this.lastAccess.get(origin) ?? 0;
    const slot = Math.max(now, last + this.minIntervalMs);
    // Reserve immediately (no await in between) so parallel callers queue up
    // instead of all observing the same "last access" value.
    this.lastAccess.set(origin, slot);
    const wait = slot - now;
    if (wait > 0) await sleep(wait);
  }

  private parseRetryAfter(resp?: AxiosResponse): number | null {
    const header = resp?.headers?.['retry-after'];
    if (!header) return null;
    const seconds = Number.parseInt(String(header), 10);
    if (!Number.isNaN(seconds)) return seconds * 1000;
    const date = Date.parse(String(header));
    return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
  }
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}