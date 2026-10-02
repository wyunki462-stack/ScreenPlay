# =============================================================================
# ScreenPlay — Linux production image (node:22-alpine)
#
# Multi-stage build:
#   1. build  — installs workspaces (incl. native modules), compiles backend
#               (NestJS → dist) and web (Vite → dist).
#   2. run    — slim runtime with ffmpeg for video frame extraction, the
#               compiled backend + web bundle, and mounted /media + /data.
#
# ── 源与代理（仅构建期）─────────────────────────────────────────────────────
#   构建容器有独立网络命名空间，**不继承宿主机代理**；而且 docker.service 里若
#   写了 HTTP_PROXY=http://127.0.0.1:7890，在容器内 127.0.0.1 指的是容器自己，
#   apk/npm 会连到不存在的服务而超时。这正是「宿主机预检正常、容器内构建超时」
#   的根因。因此代理必须在构建期显式注入（scripts/docker-build.sh 自动探测后
#   以 --build-arg 传入）。
#
#   代理值只作为 ARG 存在，并且**只在各自 RUN 命令的行内以环境变量前缀传递**，
#   不使用 ENV，因此：
#     · 不会写进任何镜像层 → 运行镜像里没有代理变量；
#     · 最终容器的入站访问（LAN IP + 端口、公网域名）完全不受影响。
#
#   apk 换源采用「构建容器内真实可用校验 + 自动故障切换」（scripts/build/apk-setup.sh）：
#   在容器内用 apk 真实下载 APKINDEX 并试装，宿主机预检的 200 不再被当作可用
#   依据，消除「宿主机预检正常、容器内超时」的假阳性；单源失败自动切下一个源。
#   脚本同时清洗 NO_PROXY，确保公网镜像站不会因被列为直连而绕开代理（本机
#   容器通常没有直连出口）。
#
# DNS 注意：
#   BuildKit 会把 /etc/resolv.conf 只读挂载，无法在 RUN 内改 DNS。若 NAS 的
#   解析器（通常是路由器网关）很慢/不可用，会导致容器内 apk/npm 超时。请把快
#   DNS 配到 docker daemon 层（一次性）：/etc/docker/daemon.json 里加
#   {"dns":["223.5.5.5","223.6.6.6"]} 后 systemctl restart docker（见 README）。
# =============================================================================

# 镜像仓库前缀（含末尾 /）。默认官方 docker.io；脚本可按检测结果覆盖为国内镜像站。
ARG REGISTRY=docker.io/library/

# ---------------------------------------------------------------------------
# 构建期参数（全部仅构建期有效，不持久化进镜像）
#   代理由 scripts/docker-build.sh 注入，填容器可达的宿主机代理地址，
#   例如 http://<你的代理主机IP>:7890（docker0 网关 172.17.0.1 也可作为容器可达地址）。
#   留空 = 完全不注入代理（保持原行为）。
# ---------------------------------------------------------------------------
ARG HTTP_PROXY=""
ARG HTTPS_PROXY=""
ARG NO_PROXY=""
ARG HTTP_PROXY_FALLBACK=""
ARG APK_MIRROR=""
ARG APK_MIRRORS=""
ARG APK_PROBE_TIMEOUT=45
# 900s 太长了：一个源 15 分钟装不完 make/g++/git 就该切下一个，而不是让用户干等。
# 240s 足够一个可用源装完（实测可用源都在 1-3 分钟内完成），装不完的源本来也该跳过。
ARG APK_INSTALL_TIMEOUT=240
# 这两个也必须声明在**第一个 FROM 之前**。
# 只在 FROM 之后声明时，docker-compose 里传进来的值会被当成「未使用的构建参数」
# 丢掉（BuildKit 打印 "unused build-arg" 但不报错），于是 npm 国内源兜底与
# 显式代理在 compose 构建路径下静默失效 —— 只有 scripts/docker-build.sh 那条
# 路径是好的。声明在这里两者都生效。
ARG SCREENPLAY_BUILD_PROXY=""
ARG NPM_MIRROR_REGISTRY="https://registry.npmmirror.com/"
# 版本号：由 scripts/docker-build.sh 从根 package.json 读出后传入，
# 最终写进镜像的 ENV，/api/health 直接返回它。
ARG BUILD_VERSION="0.0.0-dev"

FROM ${REGISTRY}node:22-alpine AS build

# FROM 之后 ARG 作用域重置，需重新声明
ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG NO_PROXY
ARG HTTP_PROXY_FALLBACK
ARG APK_MIRROR
ARG APK_MIRRORS
ARG APK_PROBE_TIMEOUT
ARG APK_INSTALL_TIMEOUT
# ── APK_SETUP_VERSION：一道显式的缓存破冰 ───────────────────────────────────
#
# 这是一道**冗余保险**，主机制是上面那条目录 COPY。
#
# 实测观察到的现象：给 apk-setup.sh 加了实时进度输出后，构建日志里仍是旧行为
# （「索引OK →」后面什么都没有），容器里跑的确实是旧脚本。至于为什么内容变了却
# 没失效，我没有查到确证 —— 所以这里不再给出机制解释，只留可观察的事实。
#
# 目录 COPY 已经覆盖了正常路径（目录校验和含全部文件内容，仓库既有实践可证）。
# 这个 ARG 覆盖另外两种情况：
#   · 用 `docker build` 直接构建、绕过 scripts/docker-build.sh；
#   · 将来有人把 COPY 改回逐文件形式。
# scripts/docker-build.sh 会按脚本内容哈希传入它（内容一变，值就变）。
#
# 不传时保持 "dev"，即不影响缓存 —— 不会因为 ARG 默认值而每次都重建。
ARG APK_SETUP_VERSION=dev
ARG SCREENPLAY_BUILD_PROXY
ARG NPM_MIRROR_REGISTRY
ARG BUILD_VERSION="0.0.0-dev"

# 构建期脚本用**目录 COPY**，不用逐文件 COPY。
#
# 原因：逐文件 `COPY scripts/xxx.sh /tmp/` 时，这一层的缓存**是否随文件内容变化**
# 在实践中不可靠 —— 实测给 apk-setup.sh 加了实时进度输出后，构建日志里仍是旧行为
# （「索引OK →」后面什么都没有），排查一轮才发现容器里跑的是旧脚本，而不是脚本写错。
# 目录 COPY 的校验和覆盖目录内**全部文件内容**，这点由仓库既有实践确认
# （`COPY backend backend` / `COPY web web` 一直是这么用的，改源码必然触发重建）。
#
# 目录里只放构建期脚本（见 scripts/build/README.md），所以 scripts/ 下其它脚本
# 的变化不会连带打穿 apk 与 npm install 这两层昂贵缓存。
COPY scripts/build/ /tmp/
RUN echo "[build] apk-setup.sh version=$APK_SETUP_VERSION"

# --- build 阶段：容器内真实校验 + 自动换源，再装原生模块编译工具链 ---
# 关键：用「行内环境变量前缀」把参数交给脚本，而不是 ENV，避免代理写进镜像。
RUN HTTP_PROXY="$HTTP_PROXY" \
    HTTPS_PROXY="$HTTPS_PROXY" \
    NO_PROXY="$NO_PROXY" \
    HTTP_PROXY_FALLBACK="$HTTP_PROXY_FALLBACK" \
    APK_MIRROR="$APK_MIRROR" \
    APK_MIRRORS="$APK_MIRRORS" \
    APK_PROBE_TIMEOUT="$APK_PROBE_TIMEOUT" \
    APK_INSTALL_TIMEOUT="$APK_INSTALL_TIMEOUT" \
    sh /tmp/apk-setup.sh python3 make g++ git

WORKDIR /app

# Layer 1: manifests only (cache-friendly).
COPY package.json ./
# package-lock.json 必须一起 COPY —— 以前漏了它，后果是每次构建都按
# package.json 的 semver 范围**重新解析**依赖，而不是用仓库里锁定的版本。
# 本机因为构建缓存命中，装上的是很久以前解析出来的那套，所以一直没暴露；
# 换到全新环境（CI、或 --no-cache）就会装到不同版本，编译随即失败，
# 而报错完全指向不了根因。锁定版本是「同一份源码构建出同一个结果」的前提。
COPY package-lock.json ./
COPY backend/package.json backend/package.json
COPY web/package.json web/package.json
COPY backend/nest-cli.json backend/nest-cli.json
COPY backend/tsconfig.json backend/tsconfig.json
COPY backend/tsconfig.build.json backend/tsconfig.build.json
COPY web/tsconfig.json web/tsconfig.json
COPY web/tsconfig.node.json web/tsconfig.node.json

# ── 原生依赖 better-sqlite3 的预编译包换源（离线可构建的关键）────────────────
#
# 为什么需要：better-sqlite3 的预编译包**不在 npm registry** 上，而在 GitHub
# Releases。Alpine/musl 下如果 prebuild-install 取不到预编译包，npm 会退化成
# node-gyp 源码编译，再去 unofficial-builds.nodejs.org 下载 node 头文件；而构建
# 容器通常没有出网出口（实测直连 GitHub 与 unofficial-builds 全部超时），于是整条
# 安装链失败，报错停在 `npm error path /app/node_modules/better-sqlite3`。
#
# 怎么解决：把预编译下载源指向 npm 国内镜像 —— npmmirror 完整镜像了 GitHub
# Releases 的资产，含 node:22-alpine 需要的那个组合
# （better-sqlite3-v11.10.0-node-v127-linuxmusl-x64.tar.gz：ABI 127 = Node 22，
# linuxmusl = Alpine）。prebuild-install 用「镜像 + ABI + libc + arch」直接拼 URL
# 取包，既不出网到 GitHub，也不再需要 node 头文件。
#
# 只针对 better-sqlite3 这一个包。不要图省事去设全局的
# npm_config_build_from_source —— 那会把 sharp 也拖进源码编译
# （见 node_modules/sharp/install/check.js），只会让构建更脆。
#
# 留空 = 保持上游默认（GitHub Releases）；镜像里没有对应 ABI 的包时，
# prebuild-install 失败后仍会回退到 node-gyp 源码编译。
# 该 ENV 只存在于 build 阶段（run 阶段是另一个 FROM，不继承），不会写进最终镜像。
ARG NPM_BINARY_MIRROR
ENV npm_config_better_sqlite3_binary_host_mirror="${NPM_BINARY_MIRROR}"

# npm install 复用上面「实测可用」的代理（由 apk-setup.sh 写入 /tmp）。
# npm-run.sh 内部：代理只走环境变量（绝不作为 npm 参数）→ 先在容器内真实探测
# 代理连通性，探不通就跳过 → 全部不通时兜底国内镜像源 registry.npmmirror.com 直连。
# SCREENPLAY_BUILD_PROXY 为显式指定的容器可达代理（留空 = 不注入代理逻辑）。
RUN HTTP_PROXY="$HTTP_PROXY" \
    HTTPS_PROXY="$HTTPS_PROXY" \
    NO_PROXY="$NO_PROXY" \
    HTTP_PROXY_FALLBACK="$HTTP_PROXY_FALLBACK" \
    SCREENPLAY_BUILD_PROXY="$SCREENPLAY_BUILD_PROXY" \
    NPM_MIRROR_REGISTRY="$NPM_MIRROR_REGISTRY" \
    sh /tmp/npm-run.sh install --no-audit --no-fund

# Layer 2: sources.
COPY backend backend
COPY web web

# 构建上下文自检。
#
# 存在的意义：用 Git 上下文构建（compose 里写 context: <git地址>#分支）时，
# **整个仓库**会被当作上下文。若此时 COPY 只拿到一部分文件（或什么都没拿到），
# 后面的 npm run build 会报一堆「找不到模块」—— 那些报错完全指不到「上下文
# 不完整」这个真正的原因。这里在安装依赖前就把关键文件的存在性打出来，
# 一眼就能判断上下文对不对。
RUN set -eu; \
    echo "== [ctx-check] 构建上下文自检 =="; \
    for f in package.json package-lock.json backend/package.json backend/src/main.ts \
             web/package.json web/src/main.tsx web/vite.config.ts \
             backend/tsconfig.build.json web/tsconfig.json; do \
      if [ -f "$f" ]; then printf '  ✓ %s\n' "$f"; \
      else printf '  ✗ %s 缺失\n' "$f"; fi; \
    done; \
    echo "  backend/src 文件数: $(find backend/src -type f 2>/dev/null | wc -l)"; \
    echo "  web/src 文件数:     $(find web/src -type f 2>/dev/null | wc -l)"

RUN HTTP_PROXY="$HTTP_PROXY" \
    HTTPS_PROXY="$HTTPS_PROXY" \
    NO_PROXY="$NO_PROXY" \
    HTTP_PROXY_FALLBACK="$HTTP_PROXY_FALLBACK" \
    SCREENPLAY_BUILD_PROXY="$SCREENPLAY_BUILD_PROXY" \
    NPM_MIRROR_REGISTRY="$NPM_MIRROR_REGISTRY" \
    sh /tmp/npm-run.sh run build

# --- 瘦身：只把运行时真的会用到的依赖带进运行镜像 -----------------------------
#
# 运行阶段直接 COPY /app/node_modules（见下面的 run 阶段）。而这条线以上的
# npm install 装的是**全量**依赖：仅开发用的包（@nestjs/cli、typescript、vite、
# playwright…）在运行镜像里一次也不会被 require，实测占了镜像最大的一层。
#
# 两步清理：
#   1. npm prune --omit=dev：按 package-lock 剔掉 devDependencies。
#      用 prune 而不是「重新 install 一次 --omit=dev」，是为了不重新解析依赖树 ——
#      运行的 node_modules 与构建时被验证过的那棵树完全同源，只有「多了谁」变了。
#   2. 删掉 web 的运行时依赖（react / lucide-react / @tanstack / plyr…）：
#      web/dist 是 Vite 打好的自包含产物，后端只做静态托管，运行时不会 require 它们。
#      依据：backend/dist 里没有任何 require("react"|"lucide-react"|"@tanstack"|"plyr")。
#      代价：在镜像里改前端本来就要重跑 npm install + build，没有额外损失。
#
# 保留 declaration（.d.ts）：产物自查脚本虽然只 grep *.js，但这些类型文件没有运行时
# 开销；真正该砍的是 sourceMap —— 见 backend/tsconfig.build.json（生产构建不再产出
# 73 个 .map，既省体积也不把源码带进镜像）。
#
#   3. 清完之后**自检原生依赖**：better-sqlite3 的编译产物（build/Release/
#      better_sqlite3.node）如果不在，容器起来时才会炸，而且报错是「数据库打不开」，
#      与瘦身动作看不出关联。所以这里就地重建 + 真跑一次 SQL，失败就让构建挂掉。
#      注意**不能**给 prune 加 --ignore-scripts：prune 会 reify 整棵树，一旦它决定重装
#      某个含原生代码的包，--ignore-scripts 会让它装完却没有编译产物（这个坑在本地
#      复现过），而脚本开着时 npm 才会去取/编译出 binding。
#
# 只影响运行镜像：build 阶段自己的 node_modules 保持全量，后续步骤不受影响。
RUN HTTP_PROXY="$HTTP_PROXY" \
    HTTPS_PROXY="$HTTPS_PROXY" \
    NO_PROXY="$NO_PROXY" \
    npm prune --omit=dev --no-audit --no-fund \
 && rm -rf node_modules/lucide-react node_modules/react node_modules/react-dom \
           node_modules/react-router-dom node_modules/@tanstack node_modules/plyr \
           node_modules/plyr-react node_modules/react-photo-view \
 && printf '[slim] node_modules: %s\n' "$(du -sh node_modules | cut -f1)" \
 && if [ ! -f node_modules/better-sqlite3/build/Release/better_sqlite3.node ]; then \
      echo '[slim] better-sqlite3 编译产物缺失，就地重建'; \
      npm rebuild better-sqlite3 --no-audit --no-fund; \
    fi \
 && node -e "const D=require('better-sqlite3');const db=new D(':memory:');db.exec('create table t(a)');db.prepare('insert into t values (?)').run(1);if(db.prepare('select count(*) c from t').get().c!==1)process.exit(3);db.close();require('sharp');console.log('[slim] 原生依赖自检通过（better-sqlite3 可读写 + sharp 可加载）')"

# --- 产物自查：构建失败比部署失败便宜得多 -----------------------------------
# 「镜像里还是旧代码」是最难排查的一类问题：容器起得来、健康检查也过、页面也
# 打得开，只是少一个标签页。常见成因是构建缓存命中了旧的 COPY 层，或某个
# workspace 的 build 静默失败。这里直接检查 backend/dist 与 web/dist 里有没有
# 本轮功能必须存在的符号，缺一个就让构建在这里失败。
#   COPY 放在**使用点之前**，而不是和构建期脚本（scripts/build/）一起。
#
#   这个脚本是「每轮都改」的文件：每加一条本轮功能的产物检查（比如 17 项 → 23 项）
#   它就变一次。曾经放在 apk-setup.sh 旁边，于是它一变就打穿下面这几层的缓存：
#
#     COPY scripts/verify-build-artifacts.sh   ← 改这里
#       ↓
#     RUN sh /tmp/apk-setup.sh python3 make g++ git   ← 缓存失效，重装 150MB+
#       ↓
#     RUN npm run build                                ← 跟着重跑
#
#   实测过一次：一次小改动导致构建要经代理重装 make/g++，在 NAS 上表现为
#   「卡在 apk 那一步」且长时间没有任何输出。
#
#   现在它**不在** scripts/build/ 里，所以它怎么改都不会碰到前面任何一层缓存；
#   改成使用点之前只是让「影响面最小」这件事在文件里可读。
#
#   位置正确性：脚本只在下面这一条 RUN 里用，紧接着就被 rm 掉（见构建指纹那一步），
#   所以放在这里除了「更贴近使用点」之外没有副作用。
COPY scripts/verify-build-artifacts.sh /tmp/verify-build-artifacts.sh
RUN sh /tmp/verify-build-artifacts.sh

# --- 构建指纹：回答「这个镜像到底是哪份源码构建的」--------------------------
# 不依赖宿主机的 git（构建上下文里通常没有 .git），改用源码内容哈希：
# 同一份源码 → 同一个指纹。排查时可以拿它和仓库里的值对比。
# 用单行 sh（find -exec cat + sort）而非多行续行：这是 Alpine 的 busybox ash，
# 命令替换里嵌套续行很容易被解析成别的意思。
# 注意 find 的表达式：-o 的优先级低于隐式 -a，不写括号时 '*.tsx' / '*.css' 会
# 绕过 -type f。这里用 -type f -a '(' ... ')' 明确表达，busybox find 同样支持。
RUN SRC_FILES="$(find backend/src web/src -type f -a \
        '(' -name '*.ts' -o -name '*.tsx' -o -name '*.css' ')' \
      | LC_ALL=C sort)" \
 && printf '%s\n' "$SRC_FILES" > /tmp/source-files.txt \
 && HASH="$(printf '%s\n' "$SRC_FILES" | xargs cat | sha256sum | cut -c1-16)" \
 && COUNT="$(printf '%s\n' "$SRC_FILES" | grep -c . || true)" \
 && printf '{\n  "sourceHash": "%s",\n  "builtAt": "%s",\n  "sourceFiles": %s\n}\n' \
      "$HASH" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$COUNT" > /app/build-info.json \
 && rm -f /tmp/verify-build-artifacts.sh /tmp/source-files.txt \
 && cat /app/build-info.json

# --- 与仓库里提交的期望指纹比对 ---------------------------------------------
# 把「镜像里的到底是哪份源码」变成一眼可见的事实。
# 不一致只警告、不让构建失败（指纹过期不是错误，而中止构建会让用户拿不到镜像）；
# 真正的把关是上面那道 verify-build-artifacts.sh。
COPY .source-hash /tmp/expected.source-hash
COPY scripts/expected-source-hash.sh /tmp/expected-source-hash.sh
RUN sh /tmp/expected-source-hash.sh && rm -f /tmp/expected-source-hash.sh /tmp/expected.source-hash

# ---------------------------------------------------------------------------
FROM ${REGISTRY}node:22-alpine AS run

ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG NO_PROXY
ARG HTTP_PROXY_FALLBACK
ARG APK_MIRROR
ARG APK_MIRRORS
ARG APK_PROBE_TIMEOUT
ARG APK_INSTALL_TIMEOUT
# ── APK_SETUP_VERSION：一道显式的缓存破冰 ───────────────────────────────────
#
# 这是一道**冗余保险**，主机制是上面那条目录 COPY。
#
# 实测观察到的现象：给 apk-setup.sh 加了实时进度输出后，构建日志里仍是旧行为
# （「索引OK →」后面什么都没有），容器里跑的确实是旧脚本。至于为什么内容变了却
# 没失效，我没有查到确证 —— 所以这里不再给出机制解释，只留可观察的事实。
#
# 目录 COPY 已经覆盖了正常路径（目录校验和含全部文件内容，仓库既有实践可证）。
# 这个 ARG 覆盖另外两种情况：
#   · 用 `docker build` 直接构建、绕过 scripts/docker-build.sh；
#   · 将来有人把 COPY 改回逐文件形式。
# scripts/docker-build.sh 会按脚本内容哈希传入它（内容一变，值就变）。
#
# 不传时保持 "dev"，即不影响缓存 —— 不会因为 ARG 默认值而每次都重建。
ARG APK_SETUP_VERSION=dev

COPY scripts/build/ /tmp/
RUN echo "[run] apk-setup.sh version=$APK_SETUP_VERSION"

# --- run 阶段：同样用「容器内真实校验」装 ffmpeg 并建用户 ---
# 同样只用行内环境变量前缀，运行镜像里不残留任何代理变量。
RUN HTTP_PROXY="$HTTP_PROXY" \
    HTTPS_PROXY="$HTTPS_PROXY" \
    NO_PROXY="$NO_PROXY" \
    HTTP_PROXY_FALLBACK="$HTTP_PROXY_FALLBACK" \
    APK_MIRROR="$APK_MIRROR" \
    APK_MIRRORS="$APK_MIRRORS" \
    APK_PROBE_TIMEOUT="$APK_PROBE_TIMEOUT" \
    APK_INSTALL_TIMEOUT="$APK_INSTALL_TIMEOUT" \
    sh /tmp/apk-setup.sh ffmpeg \
 && addgroup -S screenplay \
 && adduser -S screenplay -G screenplay \
 && rm -f /tmp/apk-setup.sh /tmp/npm-run.sh /tmp/proxy-probe.js /tmp/README.md /tmp/screenplay-proxy-env /tmp/apk-probe.log /tmp/apk-add.log

WORKDIR /app/backend

COPY --from=build /app/backend/package.json ./package.json
COPY --from=build /app/backend/dist ./dist
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/web/dist /app/public
# 构建指纹（见 build 阶段）：`cat /app/build-info.json` 即可确认镜像对应的源码。
COPY --from=build /app/build-info.json /app/build-info.json

# 版本号落成 ENV（构建期 ARG 不会持久化，必须显式转成 ENV）
ARG BUILD_VERSION="0.0.0-dev"
ENV BUILD_VERSION=$BUILD_VERSION

# 运行期环境变量（不含任何代理设置，入站访问不受影响）
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    MEDIA_DIRS=/media \
    WEB_DIST=/app/public

EXPOSE 3000
VOLUME ["/media", "/data"]

# 健康检查：容器内真实探测后端是否已就绪（而非仅进程存活）。
# 只打本机回环，不经过任何代理，因此不受出站代理/网络影响。
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD wget -q -O /dev/null --tries=1 --timeout=4 http://127.0.0.1:${PORT}/api/health || exit 1

CMD ["node", "dist/main.js"]