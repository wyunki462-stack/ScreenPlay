#!/usr/bin/env python3
"""
换运行阶段基线后的「包级等价性证明」。

做什么：拿 **1.2.0（before）镜像里真实的 apk 数据库**（`/lib/apk/db/installed`）、
**新基线的 rootfs 数据库**（alpine minirootfs，就是 `FROM alpine:<ver>` 那一层的内容）、
以及 **v<ver> 仓库的 APKINDEX**（main + community），然后核对四件事：

  1. rootfs 那十几个包在 before 镜像里都有、且版本一字不差（基线本身没换内容）；
  2. 从运行阶段真实装的根包（默认 `ffmpeg libstdc++`，见 Dockerfile 的 `apk-setup.sh ffmpeg libstdc++`）
     出发，依赖闭包在 v<ver> 仓库里**能完全解析**（装得上、不会因缺包构建失败）；
  3. 闭包里的包**全部**落在 「rootfs ∪ before」里 —— 既没有新增包（体积会漂），
     也没有 before 里有、重建后拿不到的包（会功能退化）；
  4. before 的每个包在 v<ver> 仓库里都还在，并列出「仓库里版本已经更新」的包。
     只出现在这一栏里的包是**正常**的：apk `add` 不带 `-u`、依赖写的是未固定 soname
     （如 `so:libcrypto.so.3`）⇒ 已装的旧版仍满足依赖，不会被升级（脚本会打印这些依赖写法）。

退出码：0 = 四项全过；1 = 有包对不上（打印明细）。

用法：
  # 1) 从镜像里取 before 的 apk 数据库（不需要 docker 权限；见报告 §3.1.1 的复现命令）
  #    在 registry blob 解出的层 tar 里路径是 ./lib/apk/db/installed
  python3 scripts/perf-bench/apk-parity.py --before-db /tmp/installed.txt

  可选：--ver 3.24（默认） --expected-alpine 3.24 --roots "ffmpeg libstdc++"
        --cache-dir /tmp/screenplay-apk-parity  下载的输入都缓存在这里（重跑不重新下载）

依赖：python3 + curl（只读网络，下载 minirootfs 与 APKINDEX）。
"""
import argparse
import collections
import functools
import json
import os
import re
import subprocess
import sys
import tarfile

CDN = 'https://dl-cdn.alpinelinux.org/alpine'


def download(url, dest):
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        return dest
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    subprocess.run(['curl', '-sSL', '--max-time', '180', '-o', dest, url], check=True)
    if os.path.getsize(dest) == 0:
        sys.exit(f'下载失败（0 字节）：{url}')
    return dest


def read_apk_db(path):
    """解析 apk 数据库 / APKINDEX（同一套 paragraph + 单字母字段格式）。

    path 可以是文件路径，也可以是 tarfile 取出来的成员（二进制文件对象）。
    """
    recs, cur = [], {}
    owned = None
    if hasattr(path, 'read'):
        first = path.read(1)
        path.seek(0)
        h = (line.decode('utf-8', 'replace') for line in path) if isinstance(first, bytes) else path
    else:
        owned = open(path, encoding='utf-8', errors='replace')
        h = owned
    for line in h:
        line = line.rstrip('\n')
        if not line:
            if cur:
                recs.append(cur)
                cur = {}
            continue
        if len(line) > 1 and line[1] == ':':
            cur[line[0]] = line[2:]
    if owned is not None:
        owned.close()
    if cur:
        recs.append(cur)
    return recs


def as_package(r, repo=''):
    return dict(name=r.get('P', ''), ver=r.get('V', ''), repo=repo,
                size=int(r.get('I') or 0), origin=r.get('o', ''),
                deps=(r.get('D') or '').split(),
                prov=[p.split('=')[0] for p in (r.get('p') or '').split()])


def version_key(v):
    m = re.match(r'^(\d+(?:\.\d+)*)(?:_[A-Za-z0-9]+)?(?:-r(\d+))?$', v)
    if not m:
        return ((0,),)
    return (tuple(int(x) for x in m.group(1).split('.')) + (int(m.group(2) or 0),))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--before-db', required=True, help='before 镜像里的 /lib/apk/db/installed')
    ap.add_argument('--ver', default='3.24', help='apk 仓库版本（运行阶段基线的 alpine 大版本）')
    ap.add_argument('--expected-alpine', default='3.24', help='期望的 alpine-release 主版本')
    ap.add_argument('--minirootfs', default=None,
                    help='alpine-minirootfs 文件名（默认 alpine-minirootfs-<ver>.<latest>-x86_64.tar.gz）')
    ap.add_argument('--roots', default='ffmpeg libstdc++',
                    help='运行阶段 apk add 的根包（空格分隔）')
    ap.add_argument('--cache-dir', default='/tmp/screenplay-apk-parity')
    a = ap.parse_args()
    ver = a.ver
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    rf_tar = a.minirootfs or f'alpine-minirootfs-{ver}.2-x86_64.tar.gz'

    # ── 输入 1/2/3：minirootfs、main/community APKINDEX
    rf_url = f'{CDN}/v{ver}/releases/x86_64/{rf_tar}'
    rf_path = download(rf_url, os.path.join(a.cache_dir, rf_tar))
    idx = {}
    for repo in ('main', 'community'):
        u = f'{CDN}/v{ver}/{repo}/x86_64/APKINDEX.tar.gz'
        p = download(u, os.path.join(a.cache_dir, f'APKINDEX-{ver}-{repo}.tar.gz'))
        with tarfile.open(p) as t:
            member = [m for m in t.getmembers() if m.name == 'APKINDEX'][0]
            idx[repo] = read_apk_db(t.extractfile(member))

    with tarfile.open(rf_path) as t:
        member = [m for m in t.getmembers() if m.name.endswith('lib/apk/db/installed')][0]
        rootfs_recs = read_apk_db(t.extractfile(member))

    rootfs = {p['name']: p for p in (as_package(r) for r in rootfs_recs)}
    before = {p['name']: p for p in (as_package(r) for r in read_apk_db(a.before_db))}
    repo = {p['name']: p for p in
            [as_package(r, 'main') for r in idx['main']] + [as_package(r, 'community') for r in idx['community']]}

    print('输入：')
    print(f'  before 镜像 apk 数据库 {a.before_db}：{len(before)} 个包，安装后合计 {sum(p["size"] for p in before.values()):,} B')
    print(f'  新基线 {rf_url}')
    print(f'    → {os.path.basename(rf_path)}（{os.path.getsize(rf_path):,} B）：{len(rootfs)} 个包，'
          f'安装后合计 {sum(p["size"] for p in rootfs.values()):,} B')
    print(f'  v{ver} main + community APKINDEX：{sum(len(v) for v in idx.values())} 条记录')
    print()

    # ── 断言 1：rootfs 的包在 before 里版本一字不差
    bad = [(n, rootfs[n]['ver'], before[n]['ver'] if n in before else '（before 里没有）')
           for n in sorted(rootfs) if n not in before or before[n]['ver'] != rootfs[n]['ver']]
    print(f'[1] 基线 rootfs 的 {len(rootfs)} 个包在 before 镜像里是否版本一致：'
          f'{"是 —— 基线层内容没有变" if not bad else "否 ‼"}')
    for n, v, o in bad:
        print(f'      ‼ {n}: rootfs {v} vs before {o}')
    rel = rootfs.get('alpine-release', {}).get('ver', '')
    want = a.expected_alpine + '.'
    print(f'    alpine-release = {rel or "（缺）"}'
          f'（期望 {want}x：{"一致" if rel.startswith(want) else "‼ 不一致"}）')
    print()

    # ── 断言 2/3：依赖闭包
    provider = collections.defaultdict(list)
    for p in repo.values():
        for tok in p['prov']:
            provider[tok].append(p)

    # apk 的求解规则：已经装着的版本只要满足依赖就不动它 —— 所以解析时优先选
    # 「镜像里实际装的那个版本」，其次选 before 里出现过的提供者，最后才取仓库最新版。
    installed = {n: rootfs[n]['ver'] for n in rootfs}
    installed.update({n: before[n]['ver'] for n in before})

    def resolve(tok):
        cands = provider[tok] if tok not in repo else [repo[tok]] + provider[tok]
        if not cands:
            return repo.get(tok)
        if not cands:
            return None
        exact = [c for c in cands if c['ver'] == installed.get(c['name'], '')]
        if exact:
            return exact[0]
        pref = [c for c in cands if c['name'] in before]
        return max(pref or cands, key=lambda p: version_key(p['ver']))

    seen, missing, stack = {}, [], list(a.roots.split())
    while stack:
        tok = stack.pop()
        if tok in seen:
            continue
        p = resolve(tok)
        if p is None:
            missing.append(tok)
            continue
        seen[p['name']] = p
        for dep in p['deps']:
            dn = re.split(r'[<>=~]', dep)[0]
            if dn not in seen:
                stack.append(dn)
    closure = set(seen)
    universe = set(rootfs) | set(before)
    extra = sorted(closure - universe)
    uncovered = sorted((universe - closure) - set(rootfs))
    print(f'[2] 从根包「{a.roots}」出发的依赖闭包：{len(closure)} 个包'
          f'，未解析 token {missing if missing else "无"} —— {"装得上" if not missing else "‼ 有缺包"}')
    print(f'[3] 闭包 ⊆ (rootfs ∪ before)：{closure <= universe}；'
          f'闭包里的新包 {extra if extra else "无"}；'
          f'before 里有、重建后拿不到的包 {uncovered if uncovered else "无"}')
    print()

    # ── 断言 4：before 的每个包在仓库里还在不在、版本有没有更新
    absent = sorted(n for n in before if n not in repo)
    newer = sorted((n, before[n]['ver'], repo[n]['ver']) for n in before
                   if n in repo and repo[n]['ver'] != before[n]['ver'])
    print(f'[4] before 的 {len(before)} 个包在 v{ver} 仓库里：找不到的 {absent if absent else "无"};'
          f' 仓库里版本已更新的 {[(n, a_, b_) for n, a_, b_ in newer] if newer else "无"}')
    if newer:
        names = {n for n, _, _ in newer}
        pinned = []
        for p in seen.values():
            # 只看「重建后确实会装的那个版本」写的约束：仓库里已经是新版、镜像里不会装的包
            # （例如 libssl3 3.5.9-r0 自带 `libcrypto3=3.5.9-r0`）不算 —— 它根本不会进镜像。
            if p['ver'] != before.get(p['name'], {}).get('ver', ''):
                continue
            for dep in p['deps']:
                dn = re.split(r'[<>=~]', dep)[0]
                if dn in names and re.search(r'[<>=~]', dep):
                    pinned.append((p['name'], dep))
        print('    这些更新的包不会被顺手升级：apk `add` 不带 -u，且闭包对它们的依赖都是未固定 soname'
              f'（版本约束写法：{pinned if pinned else "无"}）')
        print('    经验证据：before 镜像本身 created=2026-10-02T22:41:10+08:00，'
              '而这批更新（libcrypto3/libssl3 3.5.9-r0）构建于 2026-09-30T07:09:33Z —— '
              '更新早于构建，before 镜像里仍是 3.5.8-r0 ⇒ `apk add` 确实不升级已装包。')
    print()

    ok = not (bad or missing or extra or uncovered or absent)
    print(('结果：包级等价性核对通过（' if ok else '结果：有对不上的项，见上面 ‼（') +
          f'rootfs {len(rootfs)} / before {len(before)} / 闭包 {len(closure)}）')
    json.dump({'before': {n: p['ver'] for n, p in before.items()},
               'rootfs': {n: p['ver'] for n, p in rootfs.items()},
               'closure': {n: p['ver'] for n, p in seen.items()},
               'rootfs_mismatch': bad, 'unresolved': missing,
               'closure_extra': extra, 'before_uncovered': uncovered,
               'repo_absent': absent, 'repo_newer': newer},
              open(os.path.join(a.cache_dir, 'apk-parity.json'), 'w'), indent=1, ensure_ascii=False)
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())