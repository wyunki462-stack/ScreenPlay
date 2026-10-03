# =============================================================================
# ScreenPlay — Linux production image (build: node:22-alpine / run: alpine + node binary)
#
# Multi-stage build:
#   1. build  — `node:22-alpine`：装工作区依赖（含原生模块）、编译后端（NestJS → dist）
#               与前端（Vite → dist）。
#   2. run    — `alpine:3.24` + 只从构建阶段 COPY 一个 `node` 二进制：运行期只需
#               `node dist/main.js`，所以 npm / corepack / node 头文件都不进镜像
#               （为什么必须换基础镜像而不是 `rm`，见本阶段 FROM 上方的说明）。
#               另装 ffmpeg（视频抽帧）与 libstdc++（node 二进制的运行时依赖），
#               载入编译产物 + 前端 bundle，并挂载 /media + /data。
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

# --- 预压缩前端产物：首屏 626KB → 104KB(gzip) / 90KB(brotli)，运行期零 CPU -----
#
# 后端是这套应用前面唯一的服务者，运行期现压（或按住一个 gzip 流）正是这次优化
# 要消掉的稳态开销 —— 所以压缩放在构建期做一次，产物写成 `*.js.br` / `*.js.gz`
# 放在原文件旁边，由 `precompressedStatic` 中间件（backend/src/common/http/
# precompressed-static.ts）按 Accept-Encoding 直接发对的那一份。
# 实测：index.js 552,818 B → br 135,064 / gz 159,299；配上前端分包后首屏
# （entry.js + css + html）gzip 共约 104KB。用的是 node:zlib，不新增任何依赖。
#
# 放在这里（npm run build 之后、瘦身之前）：产物生成在 web/dist，随后被 run 阶段
# COPY 进 /app/public。宿主上手工构建不跑这一步也没关系 —— 中间件找不到 .br/.gz
# 就原样返回未压缩文件，是纯增量行为。
#
# 路径注意：构建阶段没有 `COPY . .`，脚本只在 /tmp 下（`COPY scripts/build/ /tmp/`
# 是「拷贝目录内容」，所以是 /tmp/precompress.mjs，不是 /tmp/build/…）。
RUN node /tmp/precompress.mjs web/dist

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
#      这一组要删**整个 web 生产闭包**，不只是直接声明的那个名字。@remix-run/router、
#      loadjs、rangetouch、url-polyfill、react-aptor、scheduler 等是 react-router-dom /
#      plyr / plyr-react / react-dom 带进来的，core-js（15M，全部来自 plyr 的 polyfill）
#      连 web 自己都不需要 —— 它们都不在 backend 的生产闭包内，backend/dist 里也没有
#      任何一处 require 它们，所以我用「backend 闭包 ∩ web 闭包」的差集而不是手写清单。
#      逐个核对过：backend/dist 与 node_modules 生产代码里对这些包名的 require 命中 0。
#
#   3. 删掉包内的非入口目录（index.js/lib/cjs 之外的发布附赠品）：
#      fluent-ffmpeg/coverage 是 nyc 覆盖率产物（12M，最大单项），
#      libphonenumber-js 的 bundle/es6*/、class-validator 与 class-transformer 的
#      bundles/esm*、rxjs/src、lodash/fp 都不在任何包的入口路径上。
#      全部只删「main 之外的分发目录」——不碰任何包的 index/lib/cjs，所以 require 解析
#      结果不变；改完紧跟一条入口冒烟（见下面 node -e），失败就让构建挂掉。
#
#   4. 清完之后**自检原生依赖**：better-sqlite3 的编译产物（build/Release/
#      better_sqlite3.node）如果不在，容器起来时才会炸，而且报错是「数据库打不开」，
#      与瘦身动作看不出关联。所以这里就地重建 + 真跑一次 SQL，失败就让构建挂掉。
#      注意**不能**给 prune 加 --ignore-scripts：prune 会 reify 整棵树，一旦它决定重装
#      某个含原生代码的包，--ignore-scripts 会让它装完却没有编译产物（这个坑在本地
#      复现过），而脚本开着时 npm 才会去取/编译出 binding。
#
#   5. 删掉「非运行期文件类型」：*.map（source map）、*.md（包内文档）、*.d.ts（类型声明）。
#      它们只在开发/构建期有用 —— 运行时不加 --enable-source-maps（全仓 grep 命中 0），
#      运行镜像里也不再跑 tsc（backend/dist 只留 .js，见下面那一步）。按 backend 生产闭包
#      （npm ls --omit=dev）**去重**实测：*.map 1,707 个 / 4.66 MiB、*.md 391 个 / 3.03 MiB、
#      *.d.ts 1,639 个 / 2.15 MiB，合计 3,737 个文件 / 10,320,488 B = 9.84 MiB。
#      统计时必须跳过 node_modules/@screenplay/* 这两个 workspace 软链接（跟进去会算到源码树），
#      并按绝对路径去重 —— 否则会得到偏大的 18.29 MiB 那一版错数。
#      注意**只能在这一步删**：run 阶段是 COPY --from=build 拿到这棵树的，在 COPY 之后再删
#      只会多一个白洞层，字节照样留在镜像里（scripts/verify-docker-layers.mjs 把这条钉住）。
#      *.ts 不删：不少包把 .ts 当发布内容的一部分，入口解析有风险，而收益只有 ~3.6 MiB。
#
# 只影响运行镜像：build 阶段自己的 node_modules 保持全量，后续步骤不受影响。
RUN HTTP_PROXY="$HTTP_PROXY" \
    HTTPS_PROXY="$HTTPS_PROXY" \
    NO_PROXY="$NO_PROXY" \
    npm prune --omit=dev --no-audit --no-fund \
 && rm -rf node_modules/lucide-react node_modules/react node_modules/react-dom \
           node_modules/react-router-dom node_modules/@tanstack node_modules/plyr \
           node_modules/plyr-react node_modules/react-photo-view \
           node_modules/core-js node_modules/@remix-run/router node_modules/loadjs \
           node_modules/react-router node_modules/rangetouch node_modules/scheduler \
           node_modules/prop-types node_modules/url-polyfill node_modules/react-aptor \
           node_modules/react-is node_modules/loose-envify node_modules/js-tokens \
           node_modules/custom-event-polyfill \
 && rm -rf node_modules/fluent-ffmpeg/coverage node_modules/fluent-ffmpeg/doc \
           node_modules/fluent-ffmpeg/OLD node_modules/fluent-ffmpeg/tools \
           node_modules/libphonenumber-js/bundle node_modules/libphonenumber-js/es6 \
           node_modules/libphonenumber-js/es6-modern \
           node_modules/class-validator/bundles node_modules/class-validator/esm2015 \
           node_modules/class-validator/esm5 \
           node_modules/class-transformer/bundles node_modules/class-transformer/esm2015 \
           node_modules/class-transformer/esm5 \
           node_modules/lodash/fp node_modules/rxjs/src \
 && find node_modules -type f -name '*.map' -delete \
 && find node_modules -type f -name '*.md' -delete \
 && find node_modules -type f -name '*.d.ts' -delete \
 && find backend/dist -name '*.d.ts' -delete \
 && printf '[slim] backend/dist: %s\n' "$(du -sh backend/dist | cut -f1)" \
 && printf '[slim] node_modules: %s\n' "$(du -sh node_modules | cut -f1)" \
 && node -e "require('fluent-ffmpeg');require('class-validator');require('class-transformer');require('libphonenumber-js');require('rxjs');require('lodash');console.log('[slim] JS 依赖入口自检通过')" \
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
# ════════════════════════════════════════════════════════════════════════════
# 运行阶段基础镜像：最小 alpine + 只拷 node 二进制
# ════════════════════════════════════════════════════════════════════════════
#
# 原来 run 阶段直接 `FROM node:22-alpine`。那一层在各层合计里是
# **155,819,008 B（148.6 MiB）**（未压缩 tar 层，实测见 docs/SLIMMING.md 第三节），
# 里面除了 node 二进制，还带着运行时**用不到**的东西：
# npm（约 12 MB）、corepack（约 2 MB）、node 头文件 `/usr/local/include/node`（约 8 MB）、
# npm/yarn/pnpm 的 shim、以及 node 自带的文档与 license。
# 而本镜像运行期只用得到一句 `node dist/main.js`（全仓核过：容器内没有任何脚本/文档在跑 npm；
# scripts/docker-verify.sh 明说「全部在容器里完成，宿主机不需要 node / npm」，它只用 node 与 sh）。
#
# **为什么必须换基础镜像，而不是在 node 镜像上 `rm -rf` 这些目录**：镜像是各层之和，
# 删基础层里的文件只会多出一个白洞层，字节照旧被下载与落盘（见
# docs/perf/PERF-REPORT.md 第七节「镜像体积的层语义」）。换成 alpine 后，node 二进制由下面
# `COPY --from=build` 单独搬来 —— COPY 只搬幸存文件，npm / corepack / 头文件根本不产生字节。
#
# alpine 版本必须跟着构建阶段那版 `node:22-alpine`（当前 = **alpine 3.24**）：node 官方镜像就是
# 官方 musl 预编译包叠在 alpine rootfs 上，二进制只额外需要 **libstdc++ + libgcc**
# （见下面 apk 那一步）与 musl 本身。**libstdc++ 必须装**，否则容器起不来，报错形态是
# `node: not found` / 库加载失败，看起来像「二进制坏了」。
#
# ⚠️ 为什么必须与构建阶段同版本（不是「随便挑个小版本就行」）—— 这行字曾经写错，代价是
# **ffmpeg 跨两个大版本降级**：
#   * 构建阶段的 `node:22-alpine` 现在是 alpine **3.24.2**（实测该基础镜像的 rootfs 层就是
#     `alpine-minirootfs-3.24.2-x86_64.tar.gz`，层字节 8,704,000）。
#   * 已经发布的 1.2.0 镜像跑在同一套 3.24 仓库上：从镜像里抽出 `/lib/apk/db/installed`
#     看到的包是 `ffmpeg 8.1.2-r0`、`libstdc++ 15.2.0-r5`、`libgcc 15.2.0-r5`。
#   * 若运行阶段写 `alpine:3.22`，apk 会从 v3.22 仓库装到 **`ffmpeg 6.1.2-r2`**
#     （依赖 libavcodec.so.60，而 8.1.2 用 libavcodec.so.62）—— 抽帧是 fluent-ffmpeg 调 CLI，
#     等于把运行时组件倒退两个大版本，属于「功能退化」。
#   * 版本对照（实测 APKINDEX）：v3.22 → ffmpeg 6.1.2-r2 / libstdc++ 14.2.0-r6；
#     v3.24 → ffmpeg 8.1.2-r0 / libstdc++ 15.2.0-r5（= 现状）。
#   * 同版本的代价只有 +145,408 B（rootfs 8,704,000 vs 8,591,360；libstdc+++libgcc
#     2,978,024 vs 2,945,256），换来 ffmpeg/libstdc++ 与现状**完全同包版本**。
#   * node 镜像哪天再跳 alpine 大版本（3.25…），这里要**跟着改**，否则又会静默漂移；
#     `scripts/verify-docker-layers.mjs` 第 9 组会把版本钉住并在漂移时报错。
#
# 这是构建结构改动：宿主开发环境没有 docker 权限，无法自测 ⇒ 由 `scripts/rebuild-and-verify.sh`
# 在真机构建后验证（断言 `/api/health` = 200、15 个 feature 标记齐全、启动期维护日志措辞、
# 前端投递的 `Content-Encoding` 与缓存头）。
FROM ${REGISTRY}alpine:3.24 AS run

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

# 运行阶段只需要 apk-setup.sh 这一个脚本（它自身不引用同目录的其它文件，见
# scripts/build/README.md）。原来整目录 COPY，意味着 npm-run.sh / proxy-probe.js /
# README.md / precompress.mjs 也进了这一层（这些是 build 阶段的东西），若清理列表漏掉
# 任何一个就会永久留在镜像里。逐文件 COPY 后，镜像层里只有真正要用的那一个。
COPY scripts/build/apk-setup.sh /tmp/apk-setup.sh
RUN echo "[run] apk-setup.sh version=$APK_SETUP_VERSION"

# --- run 阶段：同样用「容器内真实校验」装 ffmpeg 并建用户 ---
# 同样只用行内环境变量前缀，运行镜像里不残留任何代理变量。
#
# **libstdc++ 是 node 二进制的运行时依赖**（alpine 版 node 是动态链接 libstdc++/libgcc 的）：
# 官方 node 镜像自己在 Dockerfile 里也装了它。这里和 ffmpeg 一起装进**同一个 RUN**，
# 不额外增加层；漏装的表现是容器起来就退出（`node: not found`）。
#
# 一层收尾：脚本、apk 日志、代理环境文件与 apk 索引缓存全部在**同一个 RUN** 里删掉 ——
# 跨层删除只是多一个白洞层，字节仍然占着镜像体积（所以这条 rm 不能拆成独立 RUN）。
# 其中 `rm -rf /var/cache/apk/*` 是**冗余保险**：apk-setup.sh 本身就是 `apk add --no-cache`
# 且已在同一 RUN 末尾清过一次缓存，所以它不产生任何字节收益（同一 RUN 内创建又删除的
# 字节本来就不进层），留着只是为了将来有人改脚本时兜底。
# 运行阶段唯一的「跨层先加后删」是上面那条 `COPY scripts/build/apk-setup.sh /tmp/apk-setup.sh`
# —— 它单独占一层（18,471 B，构建期 apk 换源/代理校验必需；不能用 `RUN --mount=type=bind`
# 绕开，因为本仓检测到旧版 Docker 会降级为经典构建器，`--mount` 会直接构建失败）：
# 那 18 KB 会以白洞形式留下，是有意保留的最小代价，其余 /tmp 脚本与日志都随本 RUN 清掉。
# 清理列表里保留 npm-run.sh / proxy-probe.js / README.md / precompress.mjs 这些
# 当前并不拷进来的名字也无害（`rm -f` 不报错），这样将来若把 COPY 改回整目录也不会漏删；
# scripts/verify-docker-layers.mjs 会静态核对「拷进来的东西是否都在同一层被删掉」。
RUN HTTP_PROXY="$HTTP_PROXY" \
    HTTPS_PROXY="$HTTPS_PROXY" \
    NO_PROXY="$NO_PROXY" \
    HTTP_PROXY_FALLBACK="$HTTP_PROXY_FALLBACK" \
    APK_MIRROR="$APK_MIRROR" \
    APK_MIRRORS="$APK_MIRRORS" \
    APK_PROBE_TIMEOUT="$APK_PROBE_TIMEOUT" \
    APK_INSTALL_TIMEOUT="$APK_INSTALL_TIMEOUT" \
    sh /tmp/apk-setup.sh ffmpeg libstdc++ \
 && addgroup -S screenplay \
 && adduser -S screenplay -G screenplay \
 && rm -f /tmp/apk-setup.sh /tmp/npm-run.sh /tmp/proxy-probe.js /tmp/README.md \
           /tmp/precompress.mjs /tmp/screenplay-proxy-env /tmp/apk-probe.log /tmp/apk-add.log \
 && rm -rf /var/cache/apk/*

WORKDIR /app/backend

# node 二进制：唯一需要从构建阶段那个 node 镜像搬过来的东西（npm / corepack / 头文件都不搬）。
# 路径与官方镜像保持一致（/usr/local/bin/node），alpine 的默认 PATH 已含 /usr/local/bin。
COPY --from=build /usr/local/bin/node /usr/local/bin/node

COPY --from=build /app/backend/package.json ./package.json
COPY --from=build /app/backend/dist ./dist
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/web/dist /app/public
# 构建指纹（见 build 阶段）：`cat /app/build-info.json` 即可确认镜像对应的源码。
COPY --from=build /app/build-info.json /app/build-info.json

# 构建期自检：搬过来的 node 二进制必须能被加载并执行 —— 换基础镜像最典型的坑是漏装
# libstdc++，那会让容器运行时才炸；在这里失败比在部署现场失败便宜得多。
RUN node -v

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