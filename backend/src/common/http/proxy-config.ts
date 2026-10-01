/**
 * Proxy + IPv4 request-config helpers for the RAWG API and the image CDN.
 *
 * RAWG is hard to reach over a bare IPv6 / direct connection in some networks,
 * so every RAWG request forces IPv4 via `family: 4` agents and, when the user
 * has configured a proxy address, tunnels through that HTTP(S) proxy.
 *
 * This module also owns *proxy address validation*: a mistyped port (e.g. `:78`
 * instead of `:7890`) or a scheme that does not match the proxy's real protocol
 * used to surface as an opaque `ECONNREFUSED` / TLS error deep inside axios.
 * `validateProxyUrl()` turns those into an actionable Chinese message, and the
 * `probe*` helpers let the UI verify a candidate from inside the container.
 */

import type { AxiosProxyConfig } from 'axios';
import fs from 'fs';
import http from 'http';
import https from 'https';
import net from 'net';
import tls from 'tls';

export interface Ipv4Agents {
  httpAgent: http.Agent;
  httpsAgent: https.Agent;
}

/** Build keep-alive agents pinned to IPv4 (avoids ENETUNREACH on IPv6). */
export function createIpv4Agents(): Ipv4Agents {
  return {
    httpAgent: new http.Agent({ family: 4, keepAlive: true }),
    httpsAgent: new https.Agent({ family: 4, keepAlive: true }),
  };
}

/**
 * True for hosts that must NEVER be sent through the proxy: loopback, LAN and
 * other private ranges, plus Docker-internal names. Keeps "分流" honest — NAS
 * and 局域网 traffic stays direct and loses no latency to the tunnel.
 */
export function isPrivateOrLocalHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  // Docker / compose service names and the host gateway alias.
  if (h === 'host.docker.internal' || h === 'gateway.docker.internal') return true;
  // IPv6 loopback / link-local / unique-local.
  if (h === '::1' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;
  // IPv4 private / loopback / link-local / CGNAT.
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  return false;
}

/** Hostname of a URL, or null when unparseable. */
export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * Ports a proxy essentially never listens on, mapped to the value a fat-finger
 * typo of 7890 usually meant. Used only to produce a helpful hint.
 */
const TYPO_PORTS: Record<number, number> = { 78: 7890, 789: 7890, 78900: 7890 };

/** Well-known proxy ports offered as suggestions when a probe fails. */
export const COMMON_PROXY_PORTS = [7890, 7897, 1080, 8080, 20171];

const DEFAULT_SCHEME = 'http://';

/**
 * Normalise sloppy input into a URL string:
 *  - `host:7890` and `nas:7890` gain an `http://` scheme,
 *  - trailing slashes are dropped,
 *  - empty input stays empty (meaning "connect directly").
 * Unparseable input is returned trimmed so validation can report on it.
 */
export function normalizeProxyUrl(raw: string | null | undefined): string {
  const s = (raw ?? '').trim();
  if (!s) return '';
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s);
  if (!hasScheme) {
    // Bare `host:port` (or `nas:7890`) — assume the usual plaintext HTTP proxy.
    try {
      return new URL(`${DEFAULT_SCHEME}${s.replace(/^\/+/, '')}`)
        .toString()
        .replace(/\/+$/, '');
    } catch {
      return s;
    }
  }
  try {
    // Keep an explicitly given scheme verbatim so validation can reject it
    // (e.g. socks5://, ftp://) instead of silently rewriting it to http.
    return new URL(s).toString().replace(/\/+$/, '');
  } catch {
    return s;
  }
}

export interface ProxyCheck {
  /** false only for values that cannot work at all. */
  ok: boolean;
  /** Normalised URL ('' when the setting is empty => direct connection). */
  url: string;
  /** User-facing Chinese reason when `ok` is false. */
  error?: string;
  /** User-facing Chinese corrective hint (also set for suspicious values). */
  hint?: string;
}

/**
 * Validate a proxy address and explain, in Chinese, what is wrong with it.
 *
 * Catches the three failure modes that used to be invisible:
 *  1. wrong port (typo such as `:78`, or a port nothing listens on),
 *  2. protocol mismatch (`https://` pointing at a plaintext HTTP proxy and
 *     vice versa, or a `socks://` URL that axios cannot tunnel through),
 *  3. addresses unreachable *from inside the container* (`127.0.0.1` is the
 *     container itself; an arbitrary LAN IP usually cannot hairpin
 *     back to the host).
 */
export function validateProxyUrl(raw: string | null | undefined): ProxyCheck {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return { ok: true, url: '' };

  // A bare number is a port, not an address. `new URL('http://7890')` would
  // happily read it as the integer IP 0.0.30.210, which is never what's meant.
  if (/^\d+$/.test(trimmed)) {
    return {
      ok: false,
      url: trimmed,
      error: '只填了端口号，缺少代理地址。',
      hint: `请填写完整地址，例如 http://host.docker.internal:${trimmed}`,
    };
  }

  const url = normalizeProxyUrl(trimmed);
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return {
      ok: false,
      url,
      error: '代理地址格式不正确，无法解析。',
      hint: '正确格式示例：http://host.docker.internal:7890',
    };
  }

  const scheme = u.protocol;

  if (scheme === 'socks:' || scheme === 'socks4:' || scheme === 'socks5:') {
    return {
      ok: false,
      url,
      error: '暂不支持 socks 代理。',
      hint: 'mihomo/Clash 的混合端口同时提供 HTTP 代理，请改填 http://<地址>:7890',
    };
  }
  if (scheme !== 'http:' && scheme !== 'https:') {
    return {
      ok: false,
      url,
      error: `不支持的协议 ${scheme.replace(':', '')}。`,
      hint: '只支持 http:// 或 https:// 前缀，例如 http://host.docker.internal:7890',
    };
  }

  const portText = u.port || (scheme === 'https:' ? '443' : '80');
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return {
      ok: false,
      url,
      error: `端口 ${portText} 不在 1-65535 范围内。`,
      hint: 'mihomo 的默认混合端口是 7890。',
    };
  }

  // A bare `:78` style typo — the single most common mistake here.
  const typo = TYPO_PORTS[port];
  if (typo) {
    return {
      ok: false,
      url,
      error: `端口 ${port} 上没有代理服务（无法从容器内连通）。`,
      hint: `看起来是 ${typo} 的笔误，请改成 ${scheme}//${u.hostname}:${typo}`,
    };
  }

  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();

  if (host === '127.0.0.1' || host === 'localhost' || host === '::1') {
    return {
      ok: true,
      url,
      error: undefined,
      hint:
        'Docker 部署时 127.0.0.1 指的是容器自己，不是飞牛主机；' +
        '请改用 http://host.docker.internal:' + port,
    };
  }

  if (/^192\.168\./.test(host) || /^10\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
    return {
      ok: true,
      url,
      hint:
        `容器访问局域网地址 ${host} 常常无法回环到飞牛主机本身；` +
        '如果测试失败，请改用 http://host.docker.internal:' + port,
    };
  }

  return { ok: true, url };
}

/**
 * Parse a `http://host:port` / `https://host:port` proxy URL into axios's
 * `proxy` config. Returns undefined (=> direct connection) when empty or
 * malformed. Bare `host:port` input is accepted and gains an `http://` scheme.
 */
export function parseProxyConfig(
  proxyUrl: string | null | undefined,
): AxiosProxyConfig | undefined {
  const raw = normalizeProxyUrl(proxyUrl);
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    const cfg: AxiosProxyConfig = {
      protocol: u.protocol.replace(':', ''),
      host: u.hostname,
      port: Number(u.port || (u.protocol === 'https:' ? 443 : 80)),
    };
    if (u.username || u.password) {
      cfg.auth = {
        username: decodeURIComponent(u.username),
        password: decodeURIComponent(u.password),
      };
    }
    return cfg;
  } catch {
    return undefined;
  }
}

/** Port of a proxy URL, or null. */
export function portOf(url: string): number | null {
  try {
    const u = new URL(normalizeProxyUrl(url));
    const p = u.port || (u.protocol === 'https:' ? '443' : '80');
    return Number(p);
  } catch {
    return null;
  }
}

/**
 * The container's default gateway — i.e. the 飞牛 host itself for a compose
 * bridge network. Read from /proc/net/route so the setting works without
 * relying on `host.docker.internal` being present in /etc/hosts.
 */
export function detectHostGateway(): string | null {
  try {
    const content = fs.readFileSync('/proc/net/route', 'utf8');
    for (const line of content.split('\n').slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length < 3 || f[1] !== '00000000') continue;
      const hex = f[2];
      if (!/^[0-9a-fA-F]{8}$/.test(hex)) continue;
      // Little-endian hex, e.g. 0100A8C0 => 192.168.0.1
      const ip = [hex.slice(6, 8), hex.slice(4, 6), hex.slice(2, 4), hex.slice(0, 2)]
        .map((h) => parseInt(h, 16))
        .join('.');
      if (ip !== '0.0.0.0') return ip;
    }
  } catch {
    /* not Linux / no permission */
  }
  return null;
}

/** Plain TCP connect probe. */
export function probeTcp(host: string, port: number, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
  });
}

interface ConnectProbeOptions {
  host: string;
  port: number;
  useTls: boolean;
  timeoutMs: number;
  /** `host:port` the proxy should tunnel to. */
  target: string;
}

/**
 * Speak the HTTP proxy protocol at `host:port` and check the proxy answers a
 * CONNECT with `200`. This distinguishes "something is listening" from "a
 * working HTTP proxy is listening", and detects a TLS/plaintext mismatch.
 */
function connectProbe(opts: ConnectProbeOptions): Promise<boolean> {
  const { host, port, useTls, timeoutMs, target } = opts;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      resolve(ok);
    };

    const sock = useTls
      ? tls.connect({ host, port, servername: host, rejectUnauthorized: false })
      : net.connect({ host, port });

    sock.setTimeout(timeoutMs);
    sock.once(useTls ? 'secureConnect' : 'connect', () => {
      sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });
    let buf = '';
    sock.on('data', (chunk: Buffer) => {
      buf += chunk.toString('latin1');
      if (!buf.includes('\r\n\r\n')) return;
      const status = /^HTTP\/1\.[01] (\d{3})/.exec(buf);
      finish(Boolean(status && status[1] === '200'));
    });
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
  });
}

/**
 * Verify a proxy by tunnelling to a public host.
 *
 * `useTls` is the only difference between the two schemes a user can paste
 * (`http://` plaintext proxy vs `https://` TLS-wrapped proxy), so the probe
 * body lives here once.
 */
function probeProxy(
  url: string,
  useTls: boolean,
  timeoutMs = 4000,
  target = 'api.rawg.io:443',
): Promise<boolean> {
  const u = safeParse(url);
  if (!u) return Promise.resolve(false);
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  return connectProbe({ host: u.hostname, port, useTls, timeoutMs, target });
}

/** Verify a plaintext HTTP proxy by tunnelling to a public host. */
export function probeHttpProxy(
  url: string,
  timeoutMs = 4000,
  target = 'api.rawg.io:443',
): Promise<boolean> {
  return probeProxy(url, false, timeoutMs, target);
}

/** Verify a TLS-wrapped HTTP proxy (https:// scheme). */
export function probeHttpsProxy(
  url: string,
  timeoutMs = 4000,
  target = 'api.rawg.io:443',
): Promise<boolean> {
  return probeProxy(url, true, timeoutMs, target);
}

function safeParse(url: string): URL | null {
  try {
    return new URL(normalizeProxyUrl(url));
  } catch {
    return null;
  }
}

/**
 * Candidate proxy addresses to probe from inside the container, most likely
 * first: the configured value, then the same address with a corrected port and
 * the well-known mihomo/Clash ports, then `host.docker.internal`, the detected
 * host gateway, and 127.0.0.1 (which is the container itself — included so a
 * diagnosis can prove it fails).
 */
export function buildProxyCandidates(current: string): string[] {
  const out: string[] = [];
  const push = (u: string) => {
    const n = normalizeProxyUrl(u);
    if (n && !out.includes(n)) out.push(n);
  };

  const norm = normalizeProxyUrl(current);
  push(norm);

  let host = 'host.docker.internal';
  let port = portOf(current) ?? 7890;
  const scheme = safeParse(current)?.protocol.replace(':', '') ?? 'http';
  const parsed = safeParse(current);
  if (parsed) host = parsed.hostname;

  // The port as typed may itself be the typo, so try the likely corrections and
  // the common proxy ports on the same host before moving to other hosts.
  const ports = [port, TYPO_PORTS[port] ?? 0, ...COMMON_PROXY_PORTS].filter(
    (p, i, a) => p > 0 && p <= 65535 && a.indexOf(p) === i,
  );

  const hosts: string[] = [host];
  const gw = detectHostGateway();
  if (gw) hosts.push(gw);
  if (host !== 'host.docker.internal') hosts.push('host.docker.internal');
  hosts.push('127.0.0.1');

  for (const h of hosts) {
    for (const p of ports) {
      push(`${scheme}://${h}:${p}`);
      // mihomo's mixed port is plaintext HTTP; also try that scheme for a
      // `https://` typo and vice versa.
      if (scheme === 'https') push(`http://${h}:${p}`);
    }
  }
  return out.slice(0, 24);
}

/**
 * True for tunnel/proxy failures that are worth retrying on a fresh connection.
 *
 * These are the exact messages observed from mihomo under load — the proxy
 * accepts the CONNECT but drops the socket during the TLS handshake, which
 * almost always succeeds on the next attempt:
 *   "socket hang up"
 *   "Client network socket disconnected before secure TLS connection was established"
 *   "ECONNRESET" / "EPIPE" / "ECONNREFUSED"
 *
 * A request timeout is deliberately NOT retried (that would just multiply the
 * wait); it falls through to the next strategy instead.
 */
export function isTransientNetworkError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes('socket hang up') ||
    m.includes('socket disconnected before secure tls') ||
    m.includes('econnreset') ||
    m.includes('epipe') ||
    m.includes('econnrefused') ||
    m.includes('other side closed') ||
    m.includes('eai_again')
  );
}
