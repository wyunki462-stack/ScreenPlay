#!/usr/bin/env node
/*
 * =============================================================================
 * ScreenPlay — 构建期「代理/源 连通性」前置校验
 *
 * 为什么需要它：
 *   node:22-alpine 里没有 wget/curl，但有 node。构建容器能否真正连通某个代理，
 *   只能从容器视角实测，宿主机检测结果不作数（netns 不同）。
 *   本脚本做一次真实的 HTTPS 请求（经代理时先发 CONNECT 建隧道，再过 TLS），
 *   只有拿到 HTTP 响应才判为可用，避免把无效代理交给 npm 反复重试。
 *
 * 用法：
 *   node proxy-probe.js --proxy http://172.17.0.1:7890 --host registry.npmmirror.com
 *   node proxy-probe.js --direct --host registry.npmmirror.com
 *   node proxy-probe.js --proxy http://172.17.0.1:7890 --url https://registry.npmmirror.com/ --json
 *
 * 退出码：0 = 可用；1 = 不可用；2 = 参数错误
 * 说明：只读探测，不修改任何配置，也不写入镜像。
 * =============================================================================
 */

'use strict';

const http = require('http');
const https = require('https');
const tls = require('tls');

const DEFAULTS = {
  host: 'registry.npmmirror.com',
  port: 443,
  path: '/',
  timeout: 8000,
  json: false,
  proxy: null,
  direct: false,
};

function usage(code) {
  process.stderr.write(
    '用法: proxy-probe.js (--proxy <url> | --direct) [--url <https url> | --host <h> [--port <p>] [--path <p>]] [--timeout ms] [--json]\n',
  );
  process.exit(code);
}

function parseArgs(argv) {
  const o = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) usage(2);
      return argv[++i];
    };
    switch (a) {
      case '--proxy': o.proxy = next(); break;
      case '--direct': o.direct = true; break;
      case '--host': o.host = next(); break;
      case '--port': o.port = Number(next()); break;
      case '--path': o.path = next(); break;
      case '--timeout': o.timeout = Number(next()); break;
      case '--json': o.json = true; break;
      case '--url': {
        const u = new URL(next());
        o.host = u.hostname;
        o.port = u.port ? Number(u.port) : (u.protocol === 'http:' ? 80 : 443);
        o.path = (u.pathname || '/') + (u.search || '');
        o.scheme = u.protocol.replace(':', '');
        break;
      }
      case '-h':
      case '--help': usage(0); break;
      default: usage(2);
    }
  }
  if (!o.proxy && !o.direct) usage(2);
  if (!o.scheme) o.scheme = o.port === 80 ? 'http' : 'https';
  return o;
}

/** 发送一个最小 HTTP/1.1 GET，返回 {status} 或抛错。 */
function httpGetOverSocket(socket, host, port, path, timeout) {
  return new Promise((resolve, reject) => {
    let buf = '';
    let done = false;
    const finish = (err, val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      try { socket.destroy(); } catch (_) { /* ignore */ }
      err ? reject(err) : resolve(val);
    };
    const timer = setTimeout(() => finish(new Error('读取响应超时')), timeout);

    socket.setTimeout(timeout, () => finish(new Error('连接超时')));
    socket.on('error', (e) => finish(e));
    socket.on('data', (chunk) => {
      buf += chunk.toString('latin1');
      if (buf.length > 65536) buf = buf.slice(0, 65536);
      const m = /^HTTP\/\d\.\d\s+(\d{3})/.exec(buf);
      if (m) {
        // 拿到状态行即可判定连通性，无需读完 body
        finish(null, { status: Number(m[1]) });
      } else if (buf.includes('\r\n\r\n')) {
        finish(new Error('响应格式异常'));
      }
    });
    socket.on('close', () => {
      if (!done && buf) {
        const m = /^HTTP\/\d\.\d\s+(\d{3})/.exec(buf);
        finish(m ? null : new Error('连接被提前关闭'), m ? { status: Number(m[1]) } : undefined);
      }
    });

    socket.write(
      `GET ${path || '/'} HTTP/1.1\r\n` +
        `Host: ${host}:${port}\r\n` +
        'User-Agent: screenplay-build-probe/1.0\r\n' +
        'Accept: */*\r\n' +
        'Connection: close\r\n\r\n',
    );
  });
}

/** 直连：直接对该 host:port 发起请求。 */
function probeDirect(o) {
  return new Promise((resolve) => {
    const mod = o.scheme === 'http' ? http : https;
    const req = mod.request(
      { host: o.host, port: o.port, path: o.path || '/', method: 'GET', servername: o.host, timeout: o.timeout },
      (res) => {
        resolve({ ok: true, status: res.statusCode, mode: 'direct' });
        res.destroy();
      },
    );
    req.on('timeout', () => { req.destroy(new Error('连接超时')); });
    req.on('error', (e) => resolve({ ok: false, mode: 'direct', reason: e.message }));
    req.end();
  });
}

/** 经代理：CONNECT 建隧道 → 过 TLS → 发请求。任何一步失败都判不可用。 */
function probeViaProxy(o) {
  return new Promise((resolve) => {
    let purl;
    try {
      purl = new URL(o.proxy);
    } catch (_) {
      return resolve({ ok: false, mode: 'proxy', reason: `代理地址无法解析: ${o.proxy}` });
    }
    if (purl.protocol !== 'http:' && purl.protocol !== 'https:') {
      return resolve({ ok: false, mode: 'proxy', reason: `不支持的代理协议: ${purl.protocol}` });
    }

    const pmod = purl.protocol === 'https:' ? https : http;
    const pport = purl.port ? Number(purl.port) : (purl.protocol === 'https:' ? 443 : 80);
    const target = `${o.host}:${o.port}`;

    const headers = { Host: target };
    if (purl.username) {
      const cred = Buffer.from(
        `${decodeURIComponent(purl.username)}:${decodeURIComponent(purl.password)}`,
      ).toString('base64');
      headers['Proxy-Authorization'] = `Basic ${cred}`;
    }

    const req = pmod.request({
      host: purl.hostname,
      port: pport,
      method: 'CONNECT',
      path: target,
      headers,
      timeout: o.timeout,
      servername: purl.hostname,
    });

    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      resolve(v);
    };
    const hardTimer = setTimeout(
      () => { try { req.destroy(); } catch (_) {} done({ ok: false, mode: 'proxy', reason: '代理连接超时' }); },
      o.timeout + 2000,
    );

    req.on('timeout', () => { req.destroy(new Error('代理连接超时')); });
    req.on('error', (e) => done({ ok: false, mode: 'proxy', reason: `无法连接代理: ${e.message}` }));

    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return done({ ok: false, mode: 'proxy', reason: `代理拒绝 CONNECT（HTTP ${res.statusCode}）` });
      }

      if (o.scheme === 'http') {
        return httpGetOverSocket(socket, o.host, o.port, o.path, o.timeout).then(
          (r) => done({ ok: true, status: r.status, mode: 'proxy' }),
          (e) => done({ ok: false, mode: 'proxy', reason: `经隧道请求失败: ${e.message}` }),
        );
      }

      const tlsSock = tls.connect(
        { socket, servername: o.host, rejectUnauthorized: false },
        () => {
          httpGetOverSocket(tlsSock, o.host, o.port, o.path, o.timeout).then(
            (r) => done({ ok: true, status: r.status, mode: 'proxy' }),
            (e) => done({ ok: false, mode: 'proxy', reason: `TLS/请求失败: ${e.message}` }),
          );
        },
      );
      tlsSock.on('error', (e) => done({ ok: false, mode: 'proxy', reason: `TLS 握手失败: ${e.message}` }));
      tlsSock.setTimeout(o.timeout, () => {
        try { tlsSock.destroy(); } catch (_) {}
        done({ ok: false, mode: 'proxy', reason: 'TLS 握手超时' });
      });
    });

    req.end();
  });
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const t0 = Date.now();
  const r = o.direct ? await probeDirect(o) : await probeViaProxy(o);
  r.ms = Date.now() - t0;
  r.target = `${o.host}:${o.port}`;
  if (o.proxy) r.proxy = o.proxy;

  if (o.json) {
    process.stdout.write(`${JSON.stringify(r)}\n`);
  } else if (r.ok) {
    process.stdout.write(
      `  ✅ ${o.proxy ? `经代理 ${o.proxy}` : '直连'} → ${r.target} HTTP ${r.status}（${r.ms}ms）\n`,
    );
  } else {
    process.stdout.write(
      `  ❌ ${o.proxy ? `经代理 ${o.proxy}` : '直连'} → ${r.target} 不可用：${r.reason}（${r.ms}ms）\n`,
    );
  }
  process.exit(r.ok ? 0 : 1);
}

main().catch((e) => {
  process.stderr.write(`  ❌ 探测异常: ${e.message}\n`);
  process.exit(1);
});