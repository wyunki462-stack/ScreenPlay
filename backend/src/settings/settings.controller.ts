import { BadRequestException, Body, Controller, Get, Put, Query } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { HttpService } from '../common/http/http.service';
import { RemoteImageService } from '../common/http/remote-image.service';
import {
  COMMON_PROXY_PORTS,
  createIpv4Agents,
  detectHostGateway,
  normalizeProxyUrl,
  parseProxyConfig,
  probeHttpProxy,
  probeHttpsProxy,
  validateProxyUrl,
} from '../common/http/proxy-config';
import { ApiKeySettings, SettingsService } from './settings.service';

/** Matches the ECONNREFUSED / connection-refused wording of several clients. */
const ECONNREFUSED_RE = /ECONNREFUSED|connection refused/i;

@Controller('api/settings')
export class SettingsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly http: HttpService,
    private readonly remoteImage: RemoteImageService,
    private readonly configService: ConfigService<AppConfig, true>,
  ) {}

  @Get()
  get(): ApiKeySettings & {
    scrapers: string[];
    runtimeProxy: { url: string; source: string; noProxy: string };
  } {
    // Report where the effective runtime proxy came from, so "is the runtime
    // proxy actually applied?" is answerable without reading the container.
    const config = this.configService;
    const fromEnv = config.get('rawgProxy', { infer: true });
    const stored = this.settings.getApiKeys().rawgProxy;
    const source = stored
      ? 'settings/ui'
      : process.env.RAWG_PROXY
        ? 'env:RAWG_PROXY'
        : process.env.HTTPS_PROXY || process.env.HTTP_PROXY
          ? 'env:HTTPS_PROXY/HTTP_PROXY'
          : 'none';
    return {
      ...this.settings.getApiKeys(),
      // Scrapers (HLTB / Metacritic) need no key and are always on.
      scrapers: ['hltb', 'metacritic'],
      runtimeProxy: {
        url: stored || fromEnv,
        source,
        noProxy: config.get('noProxy', { infer: true }),
      },
    };
  }

  @Put()
  save(@Body() body: Partial<ApiKeySettings>): ApiKeySettings {
    const dto = { ...(body ?? {}) };
    // Normalise + reject impossible proxies at the door, so a mistyped port
    // cannot silently break every image later.
    if (dto.rawgProxy !== undefined) {
      const check = validateProxyUrl(dto.rawgProxy);
      if (!check.ok) {
        throw new BadRequestException(`${check.error}${check.hint ?? ''}`);
      }
      dto.rawgProxy = check.url;
    }
    return this.settings.saveApiKeys(dto);
  }

  /**
   * Live test of the saved RAWG key (+ proxy) so the user can see why
   * scraping is empty. Goes through the same IPv4/proxy path as the provider.
   */
  /**
   * UI preferences (language). Stored in the same SQLite settings table as the
   * API keys, so the choice survives a container restart and is shared by every
   * browser pointed at this instance — not just the one that changed it.
   */
  @Get('preferences')
  preferences() {
    return { language: this.settings.getValue('ui.language') || 'zh-CN' };
  }

  @Put('preferences')
  updatePreferences(@Body() body: { language?: string }) {
    const lang = body?.language;
    if (lang !== 'zh-CN' && lang !== 'en') {
      throw new BadRequestException('language 必须是 zh-CN 或 en');
    }
    this.settings.setValue('ui.language', lang);
    return { language: lang };
  }

  @Get('test-rawg')
  async testRawg(): Promise<{ ok: boolean; message: string }> {
    const keys = this.settings.getApiKeys();
    const key = keys.rawgApiKey;
    if (!key) return { ok: false, message: '未填写 RAW API Key，请先填写并保存' };

    const check = validateProxyUrl(keys.rawgProxy);
    if (!check.ok) return { ok: false, message: `${check.error}${check.hint ?? ''}` };

    try {
      const res = await this.http.getOnce<{ results?: { name: string }[] }>(
        'https://api.rawg.io/api/games',
        {
          params: { key, search: 'Portal', page_size: 1 },
          proxy: parseProxyConfig(check.url),
          ...createIpv4Agents(),
          timeout: 15000,
        },
      );
      const first = res.data.results?.[0];
      if (!first) return { ok: false, message: 'Key 可能无效（返回空结果）' };
      return {
        ok: true,
        message: `连接正常 · 示例结果：${first.name}${check.hint ? `（提示：${check.hint}）` : ''}`,
      };
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      const raw = (err as Error)?.message ?? String(err);
      let msg: string;
      if (status === 401) {
        msg = '401：API Key 无效，请检查是否填错';
      } else if (ECONNREFUSED_RE.test(raw) || /socket disconnected|ECONNRESET/i.test(raw)) {
        msg = `${raw}（代理地址可能填错，请用「诊断代理」按钮确认）`;
      } else {
        msg = raw;
      }
      return { ok: false, message: `请求失败：${msg}` };
    }
  }

  /**
   * Live test of Steam *achievement* scraping.
   *
   * Answers the question the UI could not: "my key looks right, so why is the
   * achievements tab empty?". `store.steampowered.com` (covers, prices) and
   * `api.steampowered.com` (achievements) are different hosts with different
   * reachability, and the achievement fetch used to swallow every error — so a bad
   * key or a blocked API host was indistinguishable from a game having no
   * achievements. This reports the real HTTP status and body on failure.
   */
  @Get('test-steam-achievements')
  async testSteamAchievements(
    @Query('appid') appidQuery?: string,
  ): Promise<{ ok: boolean; message: string; detail?: Record<string, unknown> }> {
    const key = this.settings.getApiKeys().steamApiKey;
    // Portal 2 — every copy has achievements, so an empty result here is a real
    // failure rather than a game that happens to have none.
    const appid = (appidQuery || '620').replace(/[^0-9]/g, '') || '620';

    if (!key) {
      return {
        ok: false,
        message:
          '未填写 Steam API Key，成就无法刮取。请到 https://steamcommunity.com/dev/apikey 申请后填入上方输入框并保存。',
      };
    }

    const detail: Record<string, unknown> = { appid, keyLength: key.length };

    // 1) The achievement schema (needs the key).
    let schemaNames: string[] = [];
    try {
      const res = await this.http.get<{
        game?: { gameName?: string; availableGameStats?: { achievements?: { name: string; displayName?: string }[] } };
      }>('https://api.steampowered.com/ISteamUserStats/GetSchemaForGame/v2/', {
        params: { key, appid, l: 'schinese' },
      });
      const game = res?.data?.game;
      const list = game?.availableGameStats?.achievements ?? [];
      detail.httpStatus = res?.status ?? 200;
      detail.gameName = game?.gameName ?? null;
      detail.achievementCount = list.length;
      schemaNames = list.slice(0, 3).map((a) => a.displayName || a.name);
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      const raw = (err as Error)?.message ?? String(err);
      detail.httpStatus = status ?? null;
      let msg: string;
      if (status === 400 || status === 401 || status === 403) {
        msg =
          `HTTP ${status}：Steam 拒绝了该 API Key。请确认 Key 复制完整、未被空格截断` +
          `（当前长度 ${key.length}），并确认它属于本账号。`;
      } else if (status === 429) {
        msg = 'HTTP 429：请求过于频繁，请稍后重试。';
      } else {
        msg =
          `无法连接 api.steampowered.com：${raw}。` +
          '注意成就接口与该商店接口（封面/价格）是不同的域名，大陆网络常常只有后者可直连；请在「设置 → 数据源」配置代理后重试。';
      }
      return { ok: false, message: msg, detail };
    }

    if (schemaNames.length === 0) {
      return {
        ok: false,
        message: `已连通 Steam 接口，但 appid ${appid} 没有返回任何成就定义。若这是你自己的游戏，请确认它确实有成就。`,
        detail,
      };
    }

    // 2) Global unlock rates (no key needed) — a partial failure is worth knowing.
    let pctOk = false;
    try {
      const pct = await this.http.get<{
        achievementpercentages?: { achievements?: { name: string }[] };
      }>('https://api.steampowered.com/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/', {
        params: { gameid: appid },
      });
      pctOk = (pct?.data?.achievementpercentages?.achievements ?? []).length > 0;
    } catch {
      pctOk = false;
    }
    detail.globalPercentOk = pctOk;

    return {
      ok: true,
      message:
        `Steam 成就接口正常 · appid ${appid} 共 ${schemaNames.length ? detail.achievementCount : 0} 个成就` +
        `（示例：${schemaNames.join('、')}）` +
        (pctOk
          ? ' · 全球解锁率可用'
          : ' · 全球解锁率接口暂时不可用（不影响成就列表：名称/描述/图标照常刮取，' +
            '只是「全球解锁率」显示为空。该接口偶发被重置，稍后重试或换个网络出口可能就通了）'),
      detail,
    };
  }

  /**
   * Live test of *image* fetching (poster/screenshot CDNs) using the same
   * RemoteImageService path the UI uses. This is the check that catches the
   * "metadata works but no covers" case, where the API is proxied but the CDN
   * was not.
   */
  @Get('test-image')
  async testImage(): Promise<{
    ok: boolean;
    message: string;
    proxy?: string;
    attempts?: { strategy: string; ok: boolean; error?: string }[];
  }> {
    const keys = this.settings.getApiKeys();
    // A stable, public RAWG CDN image.
    const probe =
      'https://media.rawg.io/media/screenshots/063/063cb0836668fdbfaa7f9bb8b5357f97.jpg';
    try {
      const { buf, diagnostics } = await this.remoteImage.fetchDetailed(probe);
      if (!buf) {
        const check = validateProxyUrl(keys.rawgProxy);
        const detail = check.ok ? '' : `${check.error}${check.hint ?? ''} `;
        const tail = diagnostics.attempts
          .filter((a) => !a.ok)
          .map((a) => `${a.strategy}: ${a.error ?? '失败'}`)
          .join('；');
        return {
          ok: false,
          proxy: keys.rawgProxy,
          attempts: diagnostics.attempts,
          message: keys.rawgProxy
            ? `${detail}图片抓取失败：代理 ${keys.rawgProxy} 无法访问 media.rawg.io${tail ? `（${tail}）` : ''}`
            : '图片抓取失败：未配置代理，且无法直连 media.rawg.io',
        };
      }
      const via = diagnostics.attempts.find((a) => a.ok)?.strategy ?? 'direct';
      return {
        ok: true,
        proxy: keys.rawgProxy,
        attempts: diagnostics.attempts,
        message: `图片抓取正常 · ${diagnostics.mime} · ${diagnostics.bytes} 字节 · 方式 ${via}`,
      };
    } catch (err) {
      return { ok: false, message: `图片抓取失败：${(err as Error)?.message ?? String(err)}` };
    }
  }

  /**
   * Diagnose the proxy setting itself: validate the address, then probe it from
   * inside this container and report which alternative addresses actually work.
   * This is what turns "URL 可能写错" into a concrete "请改成 …".
   */
  @Get('test-proxy')
  async testProxy(
    @Query('url') urlOverride?: string,
  ): Promise<{
    ok: boolean;
    message: string;
    configured: string;
    validated: string;
    hostGateway: string | null;
    candidates: { url: string; http: boolean; https: boolean }[];
  }> {
    // Diagnose what the user typed even if it is not saved yet (an invalid
    // address is rejected by PUT /api/settings, so it never reaches the DB).
    const configured =
      urlOverride !== undefined
        ? urlOverride.trim()
        : this.settings.getApiKeys().rawgProxy;
    const check = validateProxyUrl(configured);
    const hostGateway = detectHostGateway();
    const probeResult = await this.remoteImage.probeProxy(configured);
    const candidates = await Promise.all(
      probeCandidates(configured).map(async (url) => ({
        url,
        http: await probeHttpProxy(url, 2500),
        https: await probeHttpsProxy(url, 2500),
      })),
    );
    return {
      ok: probeResult.ok,
      configured,
      validated: check.url,
      hostGateway,
      candidates,
      message: probeResult.ok
        ? `${probeResult.usedUrl || configured} 可用（${probeResult.message}）`
        : probeResult.message,
    };
  }
}

/** A short, curated list of addresses to probe for the diagnosis table. */
function probeCandidates(current: string): string[] {
  const out: string[] = [];
  const add = (u: string) => {
    const n = normalizeProxyUrl(u);
    if (n && !out.includes(n) && out.length < 8) out.push(n);
  };
  const norm = normalizeProxyUrl(current);
  add(norm);
  const gw = detectHostGateway();
  for (const host of ['host.docker.internal', gw ?? '']) {
    if (!host) continue;
    for (const port of COMMON_PROXY_PORTS) add(`http://${host}:${port}`);
  }
  return out;
}