/**
 * RemoteImageService — fetch + disk-cache external CDN images.
 *
 * Why this exists: the RAWG *API* already went through the configured proxy,
 * but the poster/screenshot images live on separate CDN hosts
 * (`media.rawg.io`, `*.steamstatic.com`) and were fetched with a plain HTTP
 * client — so on a China-mainland network they timed out and every card fell
 * back to the colored initial placeholder.
 *
 * Behaviour:
 *  - Every outbound image request carries the configured proxy (same one as the
 *    RAWG API) and is pinned to IPv4 (`family: 4`) to avoid ENETUNREACH.
 *  - LAN / private / loopback hosts are NEVER proxied (分流: keep them direct).
 *  - Fetch order is configurable (`IMAGE_FETCH_ORDER`): with a proxy set the
 *    default is `proxy,direct` so a dead proxy can never break local access,
 *    and with no proxy set it is `direct` only.
 *  - Bytes are cached on disk, so each image is downloaded at most once.
 */

import { Injectable, Logger } from '@nestjs/common';
import { isJxrBuffer, jxrToWebp } from '../../media/jxr-decoder';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosRequestConfig } from 'axios';
import fs from 'fs-extra';
import path from 'path';
import { createHash } from 'crypto';
import { AppConfig } from '../../config/configuration';
import { SettingsService } from '../../settings/settings.service';
import {
  buildProxyCandidates,
  createIpv4Agents,
  hostOf,
  isPrivateOrLocalHost,
  normalizeProxyUrl,
  parseProxyConfig,
  probeHttpProxy,
  probeHttpsProxy,
  validateProxyUrl,
  isTransientNetworkError,
} from './proxy-config';

const FETCH_TIMEOUT_MS = 20_000;

/**
 * Timeout for the last-resort `direct` attempt when a proxy is configured.
 * A mainland container cannot reach overseas CDNs directly, so this only wastes
 * time; keep it short so the whole request finishes quickly and the caller still
 * gets a precise error instead of an 8s+ stall.
 */
const DIRECT_FALLBACK_TIMEOUT_MS = 4_000;

/** Transient tunnel failures get a fresh connection rather than a fallback. */
const PROXY_MAX_TRIES = 3;
const PROXY_RETRY_DELAY_MS = 250;
/** How long a discovered fallback proxy stays trusted. */
const RESCUE_TTL_MS = 60_000;
/** Minimum gap between two rescue scans (avoids probing per image). */
const RESCUE_RETRY_MS = 60_000;

export interface CachedImage {
  path: string;
  mime: string;
}

/** Outcome of one fetch attempt, kept so the UI can explain a failure. */
export interface FetchAttempt {
  strategy: string;
  ok: boolean;
  error?: string;
}

export interface FetchDiagnostics {
  ok: boolean;
  bytes: number;
  mime: string;
  proxyConfigured: string;
  proxyApplied: boolean;
  attempts: FetchAttempt[];
}

@Injectable()
export class RemoteImageService {
  private readonly logger = new Logger(RemoteImageService.name);
  private readonly dataDir: string;
  private readonly configuredOrder: string;
  /** Fallback proxy discovered by {@link rescueProxy}, if any. */
  private rescuedProxy: string | null = null;
  private rescuedAt = 0;

  constructor(
    private readonly settings: SettingsService,
    config: ConfigService<AppConfig, true>,
  ) {
    this.dataDir = config.get('dataDir', { infer: true });
    // Read lazily on first use so we never touch the DB during construction
    // (settings seeding is itself lazy and needs the migrated schema).
    this.configuredOrder = config.get('imageFetchOrder', { infer: true });
  }

  private get cacheDir(): string {
    return path.join(this.dataDir, 'proxied');
  }

  /** The configured proxy URL, or '' for a direct connection. */
  proxyUrl(): string {
    // getApiKeys() triggers lazy env seeding, so env-only config also works.
    return (this.settings.getApiKeys().rawgProxy || '').trim();
  }

  /** Resolve an external image to a local cached file, or null on failure. */
  async resolve(url: string): Promise<CachedImage | null> {
    const sn = sniffImage(url);
    const key = createHash('sha1').update(url).digest('hex');
    const cachePath = path.join(this.cacheDir, `${key}${sn.ext}`);

    if (await fs.pathExists(cachePath)) return { path: cachePath, mime: sn.mime };

    const buf = await this.download(url);
    if (!buf) return null;

    // A remote JPEG XR image is undisplayable in every browser. Transcode it to
    // WebP before caching so the proxy endpoint always hands back something the
    // frontend can render. Detection is content-based as well as URL-based,
    // because CDNs frequently serve these from extension-less endpoints.
    const looksJxr = sn.mime === 'image/webp' || isJxrBuffer(buf);
    let out = buf;
    let mime = sn.mime;
    if (looksJxr && isJxrBuffer(buf)) {
      const webp = await jxrToWebp(buf).catch(() => null);
      if (!webp) {
        this.logger.warn(`Remote JXR could not be decoded: ${url}`);
        return null;
      }
      out = webp;
      mime = 'image/webp';
    } else if (sn.mime === 'image/webp' && !isJxrBuffer(buf)) {
      // URL said .jxr but the bytes are something else — trust the bytes.
      mime = sniffContentType(buf) ?? sn.mime;
    }

    await fs.ensureDir(this.cacheDir);
    await fs.writeFile(cachePath, out);
    return { path: cachePath, mime };
  }

  /** Try each configured strategy in order; first success wins. */
  private async download(url: string): Promise<Buffer | null> {
    const result = await this.fetchDetailed(url);
    return result.buf;
  }

  /**
   * Same as {@link download} but also reports which strategies were tried and
   * why each failed, so `/api/settings/test-image` can say something useful.
   */
  async fetchDetailed(
    url: string,
  ): Promise<{ buf: Buffer | null; diagnostics: FetchDiagnostics }> {
    const host = hostOf(url);
    const privateHost = host === null || isPrivateOrLocalHost(host);
    const configured = this.proxyUrl();
    const proxy = privateHost ? undefined : parseProxyConfig(configured);

    // LAN/private targets always go direct — never through the tunnel.
    const order = privateHost
      ? ['direct']
      : parseFetchOrder(this.configuredOrder, proxy ? 'proxy' : '');

    const attempts: FetchAttempt[] = [];
    let buf: Buffer | null = null;

    for (const strategy of order) {
      if (strategy === 'proxy' && !proxy) continue;

      // The "direct" strategy from a China-mainland container normally cannot
      // reach an overseas CDN at all. Waiting the full 20s timeout for a
      // connection that will never succeed is what made /api/settings/test-image
      // intermittently take >20s (and blow past the verify script's 8s limit).
      // A tunnel error is transient, so `proxy` gets a fast retry instead.
      const isLastResort = strategy === 'direct' && order.includes('proxy');
      const perTryTimeout = isLastResort ? DIRECT_FALLBACK_TIMEOUT_MS : undefined;
      const maxTries = strategy === 'proxy' ? PROXY_MAX_TRIES : 1;

      for (let attempt = 1; attempt <= maxTries; attempt++) {
        try {
          const res = await axios.get<ArrayBuffer>(
            url,
            this.requestConfig(strategy, proxy, perTryTimeout),
          );
          buf = Buffer.from(res.data);
          attempts.push({ strategy, ok: true });
          break;
        } catch (err) {
          const message = (err as Error)?.message ?? String(err);
          // A proxy that drops the tunnel mid-handshake ("socket hang up",
          // "Client network socket disconnected before secure TLS connection
          // was established") succeeds on a fresh connection almost every time.
          // Retrying here removed the observed 20s stalls.
          const retryable =
            strategy === 'proxy' && attempt < maxTries && isTransientNetworkError(message);
          attempts.push({
            strategy: attempt > 1 ? `${strategy} (retry ${attempt})` : strategy,
            ok: false,
            error: message,
          });
          this.logger.warn(
            `image fetch failed [${strategy}${attempt > 1 ? ` try ${attempt}` : ''}] ` +
              `${url.slice(0, 120)}: ${message}`,
          );
          if (!retryable) break;
          await sleep(PROXY_RETRY_DELAY_MS * attempt);
        }
      }
      if (buf) break;
    }

    // Rescue: the tunnel failed but a proxy might still exist on another local
    // address (host.docker.internal / the bridge gateway). Verifying it once and
    // caching the winner lets images load even when the saved address is a
    // typo, instead of leaving every cover blank.
    if (!buf && !privateHost && configured) {
      const rescued = await this.rescueProxy();
      if (rescued) {
        try {
          const res = await axios.get<ArrayBuffer>(
            url,
            this.requestConfig('proxy', parseProxyConfig(rescued)),
          );
          buf = Buffer.from(res.data);
          attempts.push({ strategy: `proxy(rescue ${rescued})`, ok: true });
          this.logger.log(`image fetch recovered via ${rescued}`);
        } catch (err) {
          attempts.push({
            strategy: `proxy(rescue ${rescued})`,
            ok: false,
            error: (err as Error)?.message ?? String(err),
          });
        }
      }
    }

    return {
      buf,
      diagnostics: {
        ok: buf !== null,
        bytes: buf?.length ?? 0,
        mime: sniffImage(url).mime,
        proxyConfigured: configured,
        proxyApplied: attempts.some((a) => a.strategy === 'proxy'),
        attempts,
      },
    };
  }

  /**
   * Probe the alternative local addresses for a working HTTP proxy and remember
   * the first one that answers. Re-checked at most once a minute so a broken
   * tunnel costs one probe, not one per image.
   */
  private async rescueProxy(): Promise<string | null> {
    const now = Date.now();
    if (this.rescuedProxy && now - this.rescuedAt < RESCUE_TTL_MS) return this.rescuedProxy;
    if (now - this.rescuedAt < RESCUE_RETRY_MS) return null;

    this.rescuedAt = now;
    this.rescuedProxy = null;
    const current = normalizeProxyUrl(this.proxyUrl());
    for (const candidate of buildProxyCandidates(this.proxyUrl())) {
      if (candidate === current) continue;
      if ((await probeHttpProxy(candidate, 2500)) || (await probeHttpsProxy(candidate, 2500))) {
        this.rescuedProxy = candidate;
        return candidate;
      }
    }
    return null;
  }

  /**
   * Explicitly exercise the proxy against a public image host. Used by the
   * "测试代理" button so the user learns *before* scraping that their proxy
   * address is wrong (bad port, wrong protocol, unreachable IP).
   */
  async probeProxy(override?: string): Promise<{ ok: boolean; usedUrl: string; message: string }> {
    const configured = (override !== undefined ? override : this.proxyUrl()).trim();
    const candidates = buildProxyCandidates(configured);
    const probe =
      'https://media.rawg.io/media/screenshots/063/063cb0836668fdbfaa7f9bb8b5357f97.jpg';

    if (!configured) {
      return {
        ok: false,
        usedUrl: '',
        message: '未配置代理：容器无法直连 media.rawg.io，请填写代理地址后重试。',
      };
    }

    const check = validateProxyUrl(configured);
    if (!check.ok) {
      return { ok: false, usedUrl: check.url, message: `${check.error}${check.hint ?? ''}` };
    }

    // First: does a real HTTP CONNECT succeed through the configured address?
    if (await probeHttpProxy(check.url)) {
      return { ok: true, usedUrl: check.url, message: '代理可用（HTTP CONNECT 成功）' };
    }
    // Maybe it is a TLS-wrapped proxy.
    if (await probeHttpsProxy(check.url)) {
      return { ok: true, usedUrl: check.url, message: '代理可用（HTTPS CONNECT 成功）' };
    }
    // Or the address is merely unreachable as typed — try the alternatives.
    const alt: string[] = [];
    for (const c of candidates) {
      if (c === check.url) continue;
      if ((await probeHttpProxy(c, 3000)) || (await probeHttpsProxy(c, 3000))) alt.push(c);
    }
    if (alt.length) {
      return {
        ok: false,
        usedUrl: check.url,
        message: `当前填写的 ${check.url} 连不上；实测可用地址：${alt[0]}，请改填后保存。`,
      };
    }
    return {
      ok: false,
      usedUrl: check.url,
      message: `无法通过 ${check.url} 访问 ${probe}：端口或协议不匹配，请核对 mihomo 的混合端口（默认 7890）。`,
    };
  }

  private requestConfig(
    strategy: string,
    proxy: AxiosRequestConfig['proxy'],
    timeoutMs = FETCH_TIMEOUT_MS,
  ): AxiosRequestConfig {
    const cfg: AxiosRequestConfig = {
      responseType: 'arraybuffer',
      timeout: timeoutMs,
      maxRedirects: 5,
      headers: {
        Accept: 'image/avif,image/webp,image/*,*/*;q=0.8',
        // Some Steam CDNs serve a friendlier response with a store referer.
        Referer: 'https://store.steampowered.com/',
      },
      ...createIpv4Agents(),
    };
    // `false` explicitly disables axios's env-var proxy pickup for direct mode.
    cfg.proxy = strategy === 'proxy' ? proxy : false;
    return cfg;
  }
}

/** Parse `IMAGE_FETCH_ORDER`, falling back to a proxy-aware default. */
export function parseFetchOrder(raw: string, proxyUrl: string): string[] {
  const valid = (s: string) => s === 'proxy' || s === 'direct';
  const parsed = (raw || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(valid);
  if (parsed.length) return parsed;
  return proxyUrl ? ['proxy', 'direct'] : ['direct'];
}

/**
 * Re-exported from proxy-config so existing importers keep working; the
 * canonical implementation lives there so providers can use it without
 * pulling in the whole image service (which needs SettingsService).
 */
export { isTransientNetworkError } from './proxy-config';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


/**
 * Detect an image MIME type from magic bytes. Used when a URL's extension
 * disagrees with what the server actually returned.
 */
export function sniffContentType(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP')
    return 'image/webp';
  if (buf.subarray(0, 3).toString('ascii') === 'GIF') return 'image/gif';
  if (buf.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = buf.subarray(8, 12).toString('ascii');
    if (brand.startsWith('avif') || brand.startsWith('avis')) return 'image/avif';
    if (brand.startsWith('heic') || brand.startsWith('heix') || brand.startsWith('mif1'))
      return 'image/heic';
  }
  return null;
}

/** Best-effort image extension/MIME sniff from a URL. */
export function sniffImage(url: string): { ext: string; mime: string } {
  const u = url.toLowerCase();
  if (u.includes('.webp')) return { ext: '.webp', mime: 'image/webp' };
  if (u.includes('.png')) return { ext: '.png', mime: 'image/png' };
  if (u.includes('.gif')) return { ext: '.gif', mime: 'image/gif' };
  if (u.includes('.avif')) return { ext: '.avif', mime: 'image/avif' };
  // JPEG XR has no browser support, so it is always transcoded on the way in
  // (see RemoteImageService.resolve) and cached as WebP under a .webp name.
  if (/\.(jxr|wdp|hdp)(\?|#|$)/i.test(u)) return { ext: '.webp', mime: 'image/webp' };
  return { ext: '.jpg', mime: 'image/jpeg' };
}