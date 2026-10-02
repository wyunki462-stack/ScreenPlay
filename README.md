# ScreenPlay

[![Version](https://img.shields.io/badge/version-1.0.0-blue)](CHANGELOG.md)
[![Status](https://img.shields.io/badge/status-release-brightgreen)](#版本说明)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

个人游戏媒体相册管理系统 —— 自动扫描本地游戏截图/视频文件夹，识别对应游戏，聚合
第三方平台元数据，计算真实通关时长，并以相册形式展示与播放。

> 架构：**后端统一服务 + 多端前端展示**。核心业务全部沉淀在后端，Web / Flutter
> 客户端通过同一套 REST API 复用。

> ✅ **当前版本 `1.0.0` —— 首个正式版**。功能完整可用，核心路径有自动化验证覆盖
> （10 个离线套件 / 382 条断言，见 [`docs/VERIFY.md`](docs/VERIFY.md)）；接口与数据表结构
> 自本版起按语义化版本保持兼容。从 `0.x` 升级上来仍建议先备份 `data/` 目录。
> 详见下方 [版本说明](#版本说明)。

---

## 版本说明

### 当前版本：`1.0.0`（首个正式版）

`1.0.0` 表示接口（`/api/*`）与数据表结构进入稳定状态：此后只按语义化版本递增，不再做
破坏性调整。此前 9 轮功能迭代与全部修补版的内容，都已经包含在这一个镜像里。

| 版号段 | 含义 |
| --- | --- |
| `1.<功能号>.<修补号>` | 正式版。功能号递增 = 新增能力；修补号 = 兼容的缺陷修复 |
| `0.<迭代轮次>.<修补号>` | 1.0 之前的迭代轮次（历史，例如第 6 轮的 `0.6.0` ～ `0.6.4`） |
| `-beta.<序号>` / `-rc.<序号>` | 测试版 / 发布候选（历史，1.0 之前使用） |

`1.0.0` 本身**没有新增功能**：它把仓库与镜像瘦身（依赖 / 构建配置 / 文件），并按用户要求
合并 6 组重复实现、修掉一处「用户自选海报被元数据覆盖」的缺陷。因此界面、接口与抓取行为
都与 `0.6.4` **一致** —— 唯一的数据行为变化就是那处缺陷修复，明细见
[`docs/SLIMMING.md`](docs/SLIMMING.md)。

### 迭代历史

项目按「一轮一主题」的方式迭代，每轮都留下独立的验证脚本与验证记录：

| 轮次 | 主题 | 验证脚本 |
| --- | --- | --- |
| 1 | 基础骨架：媒体扫描、游戏识别、相册展示 | — |
| 2 | 界面语言（简体中文 / English）、封面与默认封面标识 | `scripts/verify-round-*.sh` |
| 3 | NAS 本地系统账户登录（PAM 体系账户） | 同上 |
| 4 | 海报自选与幻灯片轮播、Steam 成就全量刮削 | 同上 |
| 5 | PlayStation 奖杯刮削、卡片 16:9 统一比例 | 同上 |
| 6 | 大图区海报轮播修到全量游戏可用、**Metacritic 媒体评价**、Docker 化构建与启动期存量数据修复 | `scripts/verify-round-{d,e,f,g,k,l}.sh` |
| 7 | `0.6.2`：媒体评价「落地页没有分页器」补探 + 平台筛选 | 离线套件（`backend/scripts/verify/*.mjs`） |
| 8 | `0.6.3`：媒体评价改走站点官方 JSON 接口、卡片箭头跟随展现模式 | 同上 |
| 9 | `0.6.4`：详情页评分区去掉「用户评分」、评价面板搜索 / 排序 / 点页码跳页 | 同上 |
| — | **`1.0.0`**：瘦身（依赖 / 构建 / 文件）+ 6 组重复实现合并 + 海报归属缺陷修复，无新功能 | 10 个离线套件 / 382 条断言 |

累计约 **21 项编号需求**的落地与回归，外加第 7～9 轮的修复项。每轮的完整验收记录
（含实测输出）保留在 [`docs/VERIFY.md`](docs/VERIFY.md)。

> 上表里的一次性轮次脚本（`scripts/verify-round-*.sh`、`scripts/verify-*.mjs` 等 37 个文件）
> 已在 **`1.0.0` 瘦身**中删除，它们原先断言的覆盖改由保留下来的离线套件承担 —— 一一对照
> 关系写在 [`docs/VERIFY.md`](docs/VERIFY.md) 顶部。

### 已知限制

- **升级前请备份**：`1.0.0` 起接口与表结构按语义化版本保持兼容，但从 `0.x` 升上来
  （或跨大版本升级）仍建议先备份 `data/screenplay.db`。
- **代理依赖**：Metacritic 媒体评价与部分元数据源需要能出境访问。功能本身在
  无代理环境下会明确报「抓取失败」而不是静默返回空数据，但届时无法取到评价。
- **验证脚本需要密钥**：仓库中**不包含任何真实 API 密钥**。缺少 `RAWG_API_KEY`
  等凭据时，依赖联网的检查组会**明确跳过并说明原因**，不会假装通过。
- **FLAC/平台覆盖**：Flutter 客户端（`flutter/`）为早期版本，功能落后于 Web 端。

---

## 目录结构

```
ScreenPlay/
├── backend/            # NestJS 核心服务（TypeScript）
│   └── src/
│       ├── config/     # 环境变量配置（无硬编码密钥）
│       ├── database/   # better-sqlite3 持久化 + 迁移
│       ├── library/    # 扫描、游戏名识别(fuse.js)、通关时长计算
│       ├── media/      # 缩略图/JXR转码/视频封面/HTTP Range 流服务
│       ├── games/      # 游戏列表/详情/筛选/手动修正 + 成就/统计 API
│       ├── metadata/   # 元数据聚合 + IGDB/HLTB/Steam/Metacritic 四个数据源
│       ├── plugins/    # 插件化扩展点（自定义解析器 / 数据源）
│       └── common/     # HTTP 限流/重试客户端、元数据缓存
├── web/                # React 18 + TS + Tailwind + TanStack Query Web 前端
├── flutter/            # Flutter 客户端（Phase 2，Windows + Android）
├── windows/            # Windows 桌面端（Tauri v2 壳 + 内置后端，见 windows/README.md）
├── docs/API.md         # 完整 API 接口文档
├── scripts/            # docker-build.sh 代理注入/源切换构建脚本 + apk/npm 构建期辅助脚本
├── Dockerfile          # Linux 镜像（node:22-alpine，多阶段）
├── Dockerfile.windows  # Windows 镜像（node:22-windowsservercore）
└── docker-compose.yml  # 一键启动
```

---

## 快速开始

### 方式一：Docker（推荐）

#### 国内网络：代理注入 + 源容器内校验 + 故障切换（推荐）

国内直连 Docker Hub 与 Alpine 官方源经常超时。更棘手的是：**宿主机预检源是通的，
容器内构建却照样超时**。根因是构建容器有独立网络命名空间，不继承宿主机代理；而
`docker.service` 里的代理常被写成 `127.0.0.1:7890` —— 在容器内那是容器自己。
`scripts/docker-build.sh` 会处理这一切：

```bash
./scripts/docker-build.sh              # 探测代理 → 注入 → 容器内校验源 → 构建
./scripts/docker-build.sh --dry-run    # 只探测并打印将要执行的命令
./scripts/docker-build.sh --probe-proxy # 只探测代理可达性并给出建议
docker compose up -d                   # 使用刚构建好的镜像启动
```

脚本行为：

1. **构建期代理注入**：自动探测「容器可达」的宿主机代理地址（`docker0` 网关 →
   `host.docker.internal` → NAS 内网 IP），并用 `--build-arg` 注入
   `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`。可用 `SCREENPLAY_BUILD_PROXY`
   显式覆盖；`--no-proxy` 或 `SKIP_PROXY_INJECT=1` 则完全不注入。
   注意**不要填 `127.0.0.1`**——容器内那指容器自己。
2. **诊断 daemon 配置**：启动时读取 `docker.service.d/*.conf` 与 `daemon.json`，
   若发现代理被写成回环地址、或 `NO_PROXY` 把公网镜像站列为直连，直接打印根因
   与修法（这两条正是「宿主 200 / 容器超时」的典型成因）。
3. **源在构建容器内真实校验 + 自动切换**：换源由 `scripts/build/apk-setup.sh` 在容器内
   用 `apk` 真实下载 APKINDEX 并试装，失败自动切下一个「源 × 代理」组合。
   宿主机预检结果**不再作为可用依据**，彻底消除假阳性。候选源：
   - Alpine 软件源：`mirrors.aliyun.com` → `mirrors.tuna.tsinghua.edu.cn` →
     `mirrors.ustc.edu.cn` → `mirrors.huaweicloud.com`（`mirrors.163.com` 已停止
     提供 `/alpine` 路径，故移除）
   - Docker 镜像：`docker.fnnas.com` → `hub-mirror.daocloud.io` → `docker.1ms.run`
4. **npm 依赖安装：代理前置校验 + 国内源兜底**：由 `scripts/build/npm-run.sh` 执行，
   代理**只通过环境变量注入**（绝不作为 npm 命令行参数，避免出现
   `Unknown command: "http://..."`）。四个阶段依次尝试，任一成功即通过：
   - 阶段1：容器内真实探测代理连通性（`scripts/build/proxy-probe.js` 做一次真实 HTTPS
     请求），**探不通的直接跳过，不做无效重试**；可用则经代理走官方源
   - 阶段2：经代理走国内镜像源 `registry.npmmirror.com`
   - 阶段3：**国内镜像源直连兜底**（不依赖代理，默认启用）
   - 阶段4：官方源直连（最后再试一次）

   未配置代理时（`SCREENPLAY_BUILD_PROXY` 为空）直接跳到阶段3，用国内源安装。
   镜像源地址可用 `NPM_MIRROR_REGISTRY` 覆盖。
5. **默认启用 BuildKit**（旧版 Docker 会自动降级为经典构建器；BuildKit 若因环境
   问题失败也会自动降级重试一次）。
6. 失败时打印错误片段与根因；代理全部不可用则给出明确排查命令。

> **代理只作用于构建期**：Dockerfile 中代理与 registry 仅以 `ARG` + 行内环境变量
> 前缀传递，**不写进镜像、不改动运行容器的 npm 配置**，因此最终容器的启动与入站
> 访问（LAN IP + 端口、公网域名）不受影响。

> **DNS 一次性准备（重要）**：BuildKit 会把容器内 `/etc/resolv.conf` 只读挂载，
> 无法在构建时改 DNS。若 NAS 的解析器很慢/不可用（典型是路由器网关地址解析
> 一个域名要 ~5s），会让容器内 `apk`/`npm` 触发网络超时（`temporary error`）。
> **构建前先把快 DNS 配到 docker daemon 层**：
>
> ```bash
> sudo mkdir -p /etc/docker
> # 已有 /etc/docker/daemon.json 时请把 "dns" 键合并进去，不要整文件覆盖：
> sudo tee /etc/docker/daemon.json >/dev/null <<'EOF'
> {
>   "dns": ["223.5.5.5", "223.6.6.6"]
> }
> EOF
> sudo systemctl restart docker     # 或：sudo service docker restart
> ```
>
> 之后 `docker build`（BuildKit）与 `docker compose build` 都会用阿里快 DNS。

#### 直接 compose 构建

```bash
cp .env.example .env          # 填写 API 密钥、媒体目录
# 编辑 docker-compose.yml 里的 /media 卷挂载路径，指向你的截图/视频根目录
docker compose up -d --build
```

> 若容器内构建时 `apk` 超时（本机容器通常没有直连出口），请给 compose 指定
> 构建期代理后再构建：
>
> ```bash
> # 用 NAS 内网 IP，不要用 127.0.0.1（容器内那是容器自己）
> SCREENPLAY_BUILD_PROXY=http://<你的代理主机>:7890 docker compose build
> docker compose up -d
> ```
>
> 更省事的方式是直接用 `scripts/docker-build.sh`：它会自动探测可用代理地址、
> 逐个验证源并注入全部 `--build-arg`，无需手工填。
> `APK_MIRROR` / `APK_MIRRORS` / `REGISTRY` 均可按需覆盖。

打开 `http://localhost:3000`。首次启动会自动扫描媒体库。

### 方式二：本地开发

```bash
# 后端（需要 Node.js 18+，以及系统安装 ffmpeg 用于视频抽帧）
npm install
npm run dev:backend    # http://localhost:3000  （首次启动自动扫描）

# Web 前端（另一个终端）
npm run dev:web        # http://localhost:5173  （已配置 /api 代理到 3000）
```

生产构建：`npm run build`（输出 `backend/dist` + `web/dist`），然后
`npm start` 启动后端并静态托管 Web 前端。

> **本地开发的 Node 版本建议**：`better-sqlite3`/`sharp` 为原生模块，需匹配
> 预编译二进制或本地编译环境。推荐使用 **Node 18 LTS**（与 Docker 镜像一致，
> 原生模块有官方预编译产物）。若使用 Node 24 等过新版本且系统缺少 C/C++
> 编译工具链（`gcc`/`make`/`python3`），安装会回退到源码编译并失败——改用
> Node 18/20 即可，或安装编译工具后 `npm install`。

---

## 配置项（环境变量）

所有敏感信息通过环境变量注入，详见 `.env.example`。常用项：

| 变量 | 默认 | 说明 |
|------|------|------|
| `PORT` | `3000` | 服务端口 |
| `MEDIA_DIRS` | `/media` | 媒体库根目录（逗号分隔，每个根目录下的子目录 = 一款游戏） |
| `DATA_DIR` | `./data` | SQLite + 缩略图缓存目录（挂载卷持久化） |
| `IGDB_CLIENT_ID` / `IGDB_CLIENT_SECRET` | 空 | IGDB(Twitch) v4 凭证，空则禁用 |
| `STEAM_API_KEY` | 空 | Steam Web API Key（成就/价格），空则成就价格不可用 |
| `STEAMDB_KEY` | 空 | 可选，SteamDB 历史最低价 |
| `CRAWLER_MIN_INTERVAL_MS` | `1200` | 同主机最小请求间隔（遵守 robots 精神，>= 1s） |
| `THUMBNAIL_WIDTH` / `THUMBNAIL_QUALITY` | `480` / `80` | 缩略图尺寸与 WebP 质量 |
| `FFMPEG_PATH` | 空 | ffmpeg 可执行文件覆盖路径（空则用 PATH） |

缓存策略：游戏基础信息 30 天、评分/价格 7 天、成就 15 天；支持手动触发单款游戏刷新。

---

## 登录认证（使用 NAS 本地系统账户）

ScreenPlay 支持登录后使用，认证**完全在本机完成**，不依赖任何云端身份服务。

- **账户来源**：默认 `AUTH_MODE=system`，直接校验 NAS 的 Linux 系统账户（即 PAM 体系里的同一批用户）。
  容器无法调用 PAM，改为只读挂载宿主的 `/etc/passwd` + `/etc/shadow`，
  在内存中用纯 JS 实现 `crypt(3)` 校验 —— 本机为 Debian 系，密码算法是 `SHA512`（`$6$`），
  该实现已用 libc 的 `crypt()` 做了 147 组对照测试（含空密码、130 字符长密码、`rounds=` 自定义轮数、中文密码、`$1$` 旧格式），全部一致。
- **密码处理**：只用于比对哈希，**不存储、不记录日志、不经由任何接口返回**。
- **本地兜底账户**：首次启动会自动创建 `admin` 本地账户（scrypt 哈希，非明文）。
  未设 `AUTH_ADMIN_PASSWORD` 时随机生成并打印在容器日志里；即便宿主 `/etc` 未挂载也不会被锁在门外。
- **会话**：httpOnly Cookie + 服务端会话表，存在数据卷里，**容器重启仍保持登录**；默认有效期 30 天。
- **应急开关**：忘记密码时设 `AUTH_DISABLED=1` 可临时关闭校验。

### 挂载宿主账户库

`docker-compose.yml` 已包含以下内容（不需要可整段注释掉，程序会自动回退到本地账户）：

```yaml
    group_add:
      - "${SHADOW_GID:-42}"          # 宿主机 shadow 组 GID，getent group shadow 可确认
    volumes:
      - "/etc/passwd:/host-etc/passwd:ro"
      - "/etc/shadow:/host-etc/shadow:ro"
      - "/etc/group:/host-etc/group:ro"
```

`AUTH_ALLOWED_USERS` 可限定只有某些账户能登录，例如 `AUTH_ALLOWED_USERS=nasuser`。

> 安全提示：挂载 `/etc/shadow` 意味着容器（以非 root 的 `screenplay` 用户运行，仅通过 `shadow` 组获得读权限）
> 能读到本机账户的密码哈希。这是"用系统账户登录"的必然代价，且仅在本机发生。
> 若不希望如此，注释掉这三行挂载，改用应用内本地账户即可。

## 界面语言（简体中文 / English）

- 默认 **简体中文**，首次打开无需任何设置。
- 入口：**设置页 → 界面语言**；顶部导航栏也有一个快捷切换按钮（`中` / `EN`）。
- 切换**立即生效**，不需要刷新页面（纯 React 状态更新）。
- 持久化两层：`localStorage`（下次打开无闪烁）+ 后端 `ui.language` 设置（存在数据卷里，
  换浏览器或重启容器都保持）。
- 支持占位符插值，例如 `format.duration.daysHours` → `{days}天{hours}小时`。
- 切换语言只影响显示文案，**不触碰任何业务数据**。

词典位于 `web/src/i18n/zh/` 与 `web/src/i18n/en/`，按功能域拆成 `common / home / detail / settings / dialogs / media`
六个命名空间；`zh` 是源语言（键必须齐全），`en` 缺失时会自动回退到中文而不是显示空白。

## 核心功能

- **媒体库扫描**：`fast-glob` 递归扫描，自动识别 JPG/PNG/WebP/GIF/JXR + MP4/WebM/MKV；
  默认一个文件夹对应一款游戏。
- **游戏名识别**：`fuse.js` 模糊匹配 + 文件名清洗（去版本号/破解组/分辨率/版本后缀），
  支持手动修正匹配（`PATCH /api/games/:id`）。
- **媒体处理**：`sharp` 生成 WebP 缩略图；`jpegxr`(WASM) 后端解码 JXR→WebP；视频封面优先
  使用同目录同名图片，否则 `ffmpeg` 抽取首帧；HTTP Range 流服务支持视频拖动/倍速。
- **通关时长**：取文件夹内最早/最晚文件创建时间差；支持 `主线` / `全收集`（`100%` 等）
  子目录手动标记区分。
- **四大数据源**：IGDB（高清海报/截图/开发商/发行商/简介）、HLTB（主线/主线+支线/100%
  时长）、Steam（完整成就+全球解锁率+售价）、Metacritic（媒体均分/用户评分）。内置限流、
  失败重试、429 退避、自动缓存。
- **媒体评价**：详情页「媒体评价」标签页逐家展示 媒体名称 / 媒体打分 / 媒体评价原文；
  支持一键批量补全（同步返回逐游戏结果）与单游戏重新抓取。空结果与失败**都不会清空**
  已有评价，空状态区分「从未抓取 / 数据源没有 / 抓取失败」三种原因。见下文「媒体评价」。
- **成就 / 奖杯**：Steam 成就（本体 + DLC，含名称/描述/图标/解锁条件/全球解锁率）与
  PlayStation 主机奖杯（白金/金/银/铜 + 稀有度 + 分等级统计）。详情页「成就」标签页展示，
  全部落本地 SQLite，增量更新、可单独重刮。**抓不到时一定给出可读原因，不会静默空白。**
- **插件化扩展**：`plugins/` 提供 `MediaParser` 与数据源 SPI，见下文。

---

## 成就与奖杯

| 平台 | 来源 | 需要账号绑定 |
|---|---|---|
| Steam | `api.steampowered.com`（需 API Key） | 否（用 Key 读公开数据） |
| PlayStation | PSNINE（psnine.com）等公开中文奖杯站，失败自动降级 | **否**（纯公开数据） |

> ⚠️ **成就用的域名和封面不同**：封面/价格走 `store.steampowered.com`，
> 成就走 `api.steampowered.com`。大陆网络下常见"元数据正常、成就永远为空"，
> 就是因为后者被拦。请到「设置 → 数据源」保存 Key 后点**「测试成就接口」**确认；
> 若提示不可达，在该页配置代理即可。

详情页 →「成就」标签页可看到总数与分等级统计；点「重新抓取成就 / 奖杯」单独重刮。

### 匹配错了？手动选

自动匹配只能靠**文件夹名**推断，缩写、多版本、重名都会选错 ——
文件夹叫 `007` 时没法区分「007 First Light」和「GoldenEye 007」。
这时在「成就」标签页点**「手动选择游戏」**，输入关键词搜索（会同时搜 Steam 和奖杯站，
结果里带来源与 `appid` 便于区分），选中正确的那条后点「确认并重新抓取」即可。

这个选择会**持久化**：之后点「立即刮削全部游戏」或单游戏「刷新元数据」都会沿用它，
不会被自动匹配重置。想回到自动匹配，重新打开弹窗点左下角「恢复自动匹配」。

### 抓不到时

界面只给一句统一提示：「加载成就失败 / 当前游戏成就数据暂不可用，请尝试手动选择游戏或稍后重试」，
**不会显示具体是哪个站点出的问题**（那些信息只写进后端日志，排查时看
`docker logs screenplay`）。

### 奖杯站被墙了怎么办

奖杯默认抓 `psnine.com`。哪个站能不能通取决于容器所处的网络，所以站点根地址可以改：

```bash
# docker-compose.yml 的 environment 里加上（指向镜像或你自己的反向代理）
TROPHY_PSNINE_BASE_URL=https://your-mirror.example.com
```

配套的失败处理：5xx（含 psnine 高发的 504）会自动重试并指数退避；持续失败时
**抛出明确错误而不是返回空列表**；200 空页面会单独识别为「可能被拦截或需要代理」，
不会伪装成「这个游戏没有奖杯」。`TROPHY_PSNINE_DISABLED=1` 可整个关掉该数据源。

### 匹配错了、或者刮不到数据

- **换一个游戏条目**：详情页「手动匹配」可以搜索并手动选定条目。
  每个数据源现在会给出**多条候选**（而不是只有一条最佳猜测），
  RAWG 与 Metacritic 的候选可以互补 —— 前者补封面/简介/截图，后者补 Metascore。
- **换绑会全量替换**：旧游戏的海报、背景图、截图、评分、成就都会被清空后再写入新数据，
  不会出现「新封面 + 旧截图」。你自己上传的海报、选定的封面、本地相册和手动平台选择会保留。
- **任天堂等主机游戏搜不到时**：先试其它数据源的候选，换绑失败时会提示具体原因
  和可以再试的关键词方向。

### 评分不对、或者时长不对

- **M站评分可以手动选平台**：详情页评分标识旁的「手动选择评分」。同一款游戏在
  PC / PS5 / Xbox / Switch 上是**各自独立的 Metacritic 条目**，分数不同；自动匹配
  只能挑一个，挑错平台时可以自己指定。选定后卡片与详情页会同步，并且**后续全量刮削
  与单游戏刷新都不会重置**；想回到系统自动匹配就点「恢复自动匹配」。
- **评分不会因为一次抓取失败而消失**：抓取的更新只在确实拿到分数时才覆盖已有值，
  每次更新前后还会做完整性校验。已丢失的评分用「刷新元数据」可以补回。
- **通关时长来自多个库**：HowLongToBeat（真实主线通关时长）优先，取不到时退到
  RAWG 的平均游玩时长，界面上一并显示主线 / 主线+支线 / 完美通关三个维度。
  **中文目录名也能取到时长**：时长库只索引英文标题，所以会自动用英文别名去查，
  必要时还会在刮削拿到英文名后再补查一次。没有数据的游戏显示「未知」。

### 快速翻看相邻的游戏

详情页标题上方有「上一个 / 下一个」，顺序跟你当前在图库看到的完全一致 —— 搜索、
平台筛选、自定义排序都算数，首尾还会自动绕回去，不用回图库也不用重开页面。

### 时长还是显示「未知」

时长库偶发不可达时会留空（这是网络问题，不是没找到）。点一次补全，它会只针对缺时长
的游戏重试，通常跑一轮就能补齐；这个操作不会清空任何已有数据。

```bash
curl -X POST http://<主机>:3001/api/games/backfill-durations
```

### 想要自己的排列顺序

图库右上角的排序下拉里选「**自定义排序**」，卡片就能按住拖动（拖动时会有占位符和
插入指示条），松手即保存。顺序存在数据库里，重启容器、重新扫描媒体库都不会丢；
想回到默认顺序点横幅上的「恢复默认顺序」。其他排序模式（按名称、评分、时长等）
不受影响，仍然按各自规则排列。

验证步骤见 [`docs/VERIFY.md`](docs/VERIFY.md) 的「需求 4 ~ 需求 21」；
在已部署的环境上复验（重建镜像 + 重启容器 + 体检）：

```bash
bash scripts/rebuild-and-verify.sh
```

---

## API 接口文档

完整接口见 [`docs/API.md`](docs/API.md)，涵盖：
- `POST /api/library/scan`、`GET /api/library/status`
- `GET /api/games`（搜索/平台/年份/评分筛选排序）、`GET /api/games/:id`、`PATCH`、`POST :id/refresh`
- `GET /api/games/:id/media`、`GET /api/achievements/:gameId`、`GET /api/stats`
- 媒体流：`/api/media/:id/stream|thumbnail|cover|original`（Range 支持）

---

## 插件化扩展（P3）

**新增媒体格式**：实现 `MediaParser`（`backend/src/plugins/plugin.interface.ts`），
实现 `supports()` / `parse()`，并在启动时注册到 `PluginsService`。

**新增元数据源**：实现 `MetadataProvider`
（`backend/src/metadata/provider.interface.ts`）的两个方法
`search(name, platform)` 与 `fetch(match)`，并在 `metadata.module.ts` 的
`METADATA_PROVIDERS` 工厂数组中加入实例。聚合器自动接手限流、重试、缓存与持久化。

---

## Windows 桌面端（Tauri v2，内置后端）

`windows/` 是 Windows 桌面端源码，目标是把 Web 端**原样**装进一个原生窗口，且**默认离线可用**：

- **壳**：Tauri v2（Rust），单实例；启动时在本地随机端口拉起**随包发布的** NestJS 后端
  （`backend/dist` + `node.exe` + `better-sqlite3`/`sharp` 的 Windows 预编译产物 + `ffmpeg.exe`/`ffprobe.exe`），
  健康检查通过后再把主窗口指向 `http://127.0.0.1:<port>`，因此**前端零改动**、接口与数据行为与 Web 端一致。
- **数据目录**：默认 `%APPDATA%\ScreenPlay`（可用 `config.json` 改到任意目录），数据库、海报、
  缩略图、缓存都在其中；程序目录保持只读，可整体拷贝成免安装包。
- **精简**：不打包任何开发依赖与 Web 端专属运行时依赖（`react*`/`@tanstack`/`plyr` 等已由
  后端静态托管产物替代），去掉了 viewport meta 与一条移动端媒体查询，图标本地化（不再依赖 CDN）。
- **构建**：在 Windows 上运行 `windows\build-windows.ps1`（或 `build-windows.cmd`）。仓库
  **自带全部离线依赖**（Node 运行时、原生模块、ffmpeg），构建机不需要联网拉取这些资源；
  具体步骤、产物说明与「功能对齐对照表」见 [`windows/docs/BUILD-WINDOWS.md`](windows/docs/BUILD-WINDOWS.md)、
  [`windows/docs/ARTIFACTS.md`](windows/docs/ARTIFACTS.md)、[`windows/docs/PARITY.md`](windows/docs/PARITY.md)。

> 产物形态：NSIS 安装包（`bundles/nsis/*.exe`）与免安装 zip（`portable/*.zip`，解压即用）。
> 桌面端不重复实现任何后端逻辑，所有数据都来自同一个 REST API。

---

## Flutter 客户端（Phase 2）

`flutter/` 为纯客户端：所有数据通过 HTTP 调用后端 API，无本地业务逻辑。
技术栈：Riverpod + dio + cached_network_image + video_player/chewie +
flutter_staggered_grid_view。构建说明见 [`flutter/README.md`](flutter/README.md)。

---

## 构建代理 vs 运行代理（重要）

这两者**完全独立**，只配一个是不够的：

| | 构建代理 | 运行代理 |
|---|---|---|
| 作用范围 | 仅 `docker build` 期间（apk / npm 下载） | 容器**运行时**的所有出站业务请求 |
| 配置位置 | `SCREENPLAY_BUILD_PROXY`（或 `scripts/docker-build.sh` 自动探测） | `RAWG_PROXY`，或 `RUNTIME_HTTP_PROXY` / `RUNTIME_HTTPS_PROXY` |
| 是否随容器启动生效 | ❌ 不生效（构建期变量不会写入镜像） | ✅ 启动即生效 |
| 影响刮削 / 图片下载 | ❌ | ✅ |

**为什么必须分开**：构建阶段的代理只作用于构建容器；镜像里**不写入任何代理变量**（否则会污染入站访问）。所以
「构建成功」并不代表「运行时联网正常」。若只配了构建代理，容器启动后依然走直连，境外图片与刮削会全部失败。

### 运行时代理配置

在 `.env` 中设置（`RAWG_PROXY` 优先级最高）：

```bash
RAWG_PROXY=http://host.docker.internal:7890
# 也可用标准变量名（仅当 RAWG_PROXY 为空时生效）：
# RUNTIME_HTTP_PROXY=http://host.docker.internal:7890
# RUNTIME_HTTPS_PROXY=http://host.docker.internal:7890
```

要点：

- 地址请用 `host.docker.internal`（已由 compose 的 `extra_hosts` 指向 NAS 宿主机）。
  **不要用 `127.0.0.1`**（那是容器自己），也**不建议用 NAS 的局域网 IP**（本机回环场景下不通）。
- 未配置任何代理时自动走直连，不影响纯内网使用。
- `NO_PROXY` / 私有网段（`127.0.0.0/8`、`192.168.0.0/16`、`10.0.0.0/8`、`172.16.0.0/12`）
  始终直连，**入站访问与局域网互访不受代理影响**。
- 图片抓取遇到代理瞬时断连（`socket hang up` 等）会自动重试，不再出现 20 秒级卡顿。

### 端口与健康检查

- 宿主端口由 `PORT` 控制（默认 `3001` → 容器内 `3000`）。
- 镜像与 compose 均内置 `HEALTHCHECK`，探测容器内 `http://127.0.0.1:3000/api/health`，
  可据此区分「进程存活」与「服务真正就绪」：

```bash
docker compose ps                 # STATUS 列显示 (healthy)
docker inspect -f '{{.State.Health.Status}}' screenplay
```

### 本机访问局域网 IP 的说明

从 NAS 主机**自己**访问自己的局域网 IP（形如 `http://<你的局域网IP>:3001`）属于 hairpin 场景。
Docker 发布的端口在此场景下不通（所有容器端口一致，非 ScreenPlay 缺陷），而局域网内其它设备
访问正常。快速自检：

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3001/api/health   # 200
curl -s -o /dev/null -w '%{http_code}\n' http://<NAS局域网IP>:3001/api/health # 本机可能 000
```

### 逐项验证（三项新功能）

三项功能的自动化 + 手工验证步骤见 **[docs/VERIFY.md](docs/VERIFY.md)**：
每项都给出了对应的脚本检查组、预期输出、浏览器侧的手工检查清单，以及边界情况（无官方海报、账户过滤、跨浏览器语言等）。

### 在另一台设备上部署

仓库根那份 `docker-compose.yml` 面向「同机开发」，带 NAS 专属假设（挂载宿主
`/etc/{passwd,shadow,group}` 做系统账户登录）。**换一台设备用这份专门的部署文件**：

```bash
# 1) 复制仓库到目标设备（或只复制这两个文件 + 源码目录）
# 2) 生成配置
cp .env.deploy.example .env

# 3) 必填：把 MEDIA_HOST_DIR 改成本机真实的游戏截图目录
#    Linux/NAS: /volume1/photos/games    Windows: D:/Games/Shots
vi .env

# 4) 起容器
docker compose -f docker-compose.deploy.yml up -d

# 5) 首次启动的 admin 密码（随机生成）
docker compose -f docker-compose.deploy.yml logs screenplay | grep -i admin
```

| 文件 | 用途 |
| --- | --- |
| `docker-compose.deploy.yml` | 干净设备上的部署定义（`AUTH_MODE=local`，不依赖宿主账户库） |
| `.env.deploy.example` | 配置模板，带 ★ 标注必填项 |

> **没设置 `MEDIA_HOST_DIR` 会直接报错停下**，这是刻意的：若给个默认值而目录
> 不存在，Docker 会默默创建空目录挂进去 —— 容器照常启动、健康检查也过，只是
> 游戏库永远是空的，排查毫无线索。

**方式一：先从 GitHub 拉源码，再在目标设备上构建**（要求目标设备能访问 GitHub）

Compose 的 `build.context` 只能指向本地路径，**没法在 build 时自动 git clone**，
所以「从 GitHub 拉」这件事必须由一个前置步骤来完成：

```bash
# 把 fetch-and-build.sh 与 screenplay.yml 拷到目标设备
cp .env.deploy.example .env      # 然后改 MEDIA_HOST_DIR
bash fetch-and-build.sh          # 从 GitHub clone 源码 + 构建镜像
docker compose -f screenplay.yml up -d --no-build
```

`fetch-and-build.sh` 做两件事：`git clone --depth 1` 到 `./screenplay-src`，然后
用**这个 clone 出来的仓库**当构建上下文执行 `docker build`（Dockerfile、
package-lock.json、backend/、web/、scripts/ 都在仓库里，不需要再同步任何文件）。
再次运行它会 `fetch` 并更新到最新提交 —— 以后升级只需重跑这个脚本。

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `SRC_DIR` | `./screenplay-src` | 源码目录 |
| `GIT_REPO` | 官方仓库 | 仓库地址 |
| `GIT_BRANCH` | `main` | 分支 |
| `IMAGE_TAG` | `screenplay:latest` | 镜像名（须与 `screenplay.yml` 一致） |

> 变量名是 `SRC_DIR` 而**不是** `GIT_DIR`：后者是 git 自己保留的环境变量，
> git 会把它的值当作 `.git` 元数据目录本身，于是所有 git 命令都去找
> `$GIT_DIR/HEAD`，报出毫无指向性的 `fatal: not a git repository`。

**方式二：给另一台设备传镜像（不依赖 GitHub，也不依赖任何镜像仓库）**：在本机构建好，导出成 tar 传过去。

```bash
# ── 在构建机（本 NAS）上 ─────────────────────────────────────────────
docker build -t screenplay:latest .

# 导出成一个文件（约 600 MB ~ 1 GB，取决于 ffmpeg 等依赖）
docker save screenplay:latest | gzip > screenplay-image.tar.gz

# ── 传到目标设备（U 盘 / scp / 共享盘都行）────────────────────────────
scp screenplay-image.tar.gz user@另一台设备:/tmp/

# ── 在目标设备上 ────────────────────────────────────────────────────
gunzip -c /tmp/screenplay-image.tar.gz | docker load
# 看到 Loaded image: screenplay:latest 就成了

cp .env.deploy.example .env      # 然后改 MEDIA_HOST_DIR
docker compose -f docker-compose.deploy.yml up -d
```

> 目标设备**不需要源码、不需要构建、不需要联网拉镜像** —— 只要 Docker、
> 这个 tar 文件、和真实的媒体目录。
>
> 注意 `docker-compose.deploy.yml` 里默认带着 `build:` 段。用 tar 方式时，
> 因为本地已经有 `screenplay:latest` 这个镜像，compose 会**直接复用**它
> （compose 看到同名镜像就不再构建）。若想强制不构建，加 `--no-build`：
> `docker compose -f docker-compose.deploy.yml up -d --no-build`

**关于 CI**：本仓库**不启用** GitHub Actions 自动构建（原先的
`.github/workflows/docker-build-push.yml` 已移除）。理由：CI 的价值是「自动出镜像
供远程拉取」，而实际部署路径一直是本机 Docker 构建 —— 构建机就在你身边时，
CI 只是多一条会失败、且报错信息残缺的链路（build-push-action 只打印 BuildKit
摘要，真实的 npm/TS 报错全被吞掉，排查成本远高于收益）。

以后想恢复也可以：把 workflow 加回来即可，用 `docker/setup-buildx-action` +
`docker/build-push-action`，并**显式传 `NPM_MIRROR_REGISTRY`**（国内默认是
registry.npmmirror.com，会让海外 runner 跨太平洋取包）。

### 本轮（`1.0.0`：瘦身 + 去重 + 海报归属修复，界面同 `0.6.4`）的部署与验收

**这一版不改界面、不改接口**：把仓库与镜像瘦身、合并 6 组重复实现，并修掉「用户自选海报
被元数据覆盖」。数据侧要做的仍是 `0.6.3` 那件事（媒体评价改走站点自己的 JSON 接口）。
**如果你还没部署过 `0.6.3`，直接部署 `1.0.0` 就行** —— 四轮内容都在这一个镜像里。

```bash
bash scripts/rebuild-and-verify.sh        # 重建镜像 + 重启容器 + 体检（需 docker 组权限）
bash scripts/package-image.sh             # 可选：导出可搬运的镜像包（拷去 Windows 再推送）
```

`1.0.0` 的 features 列表与 `0.6.4` **完全相同**（这一版没有新增页面能力），所以判据是
`version`：

```bash
curl -s http://127.0.0.1:3001/api/health | tr ',' '\n' | grep -E '"version"|ratings-no-user-score|reviews-ui-search-sort|reviews-page-jump'
# 期望：version 1.0.0，且 `0.6.4` 的三个界面标记都在
```

> **与 `0.6.4` 的差别**：界面、接口完全一致（多了 6 组去重与海报归属修复），区别主要在
> 镜像体积 —— `node_modules` 层 282.2 MiB → 112.6 MiB，整镜像 **571.9 MiB → 401.6 MiB（−29.8%）**
> （发布后从 GHCR / Docker Hub 两个 registry 拉 manifest 实测，两处同 digest）。
> 明细、核算方法与无回归证明见 [`docs/SLIMMING.md`](docs/SLIMMING.md)。

浏览器里三处肉眼验收（都在某个游戏的详情页）：

1. **评分区**：Metascore 右边**不再有**「用户评分 / —」那一列，只剩 Metascore、评论数、
   分级。
2. **页码**：「媒体评价」标签页底部是**可点的页码按钮**（不再是纯文本「第 N / M 页」）。
   点「2」直接跳到第 2 页，被点中的那一页高亮。
3. **搜索 / 排序**：面板左上多了搜索框和「排序方式」下拉。输入 `IGN` 只剩 IGN 的评价；
   排序切到「评分从低到高」，第一条变成全场最低分的那家；搜一个不存在的词，出现
   「没有名称含…的媒体」而不是「该平台暂无评价」。

> 前三处都只影响显示，**不需要重新抓取**评价数据；不存在存量数据的问题。

4. **海报归属**（`1.0.0` 修的那处缺陷，改的是数据行为）：在详情页给某个游戏手动填一个
   **外部**海报链接，然后点一次「重新抓取元数据」—— 海报**不应**再被官方图覆盖。
   反之，由本机下载的海报（`/api/media/…`、`/api/posters/…`）仍会被新抓到的官方图替换，
   原本空白的位置也仍由官方图填充：这是预期行为，也是这次修复的边界。

### 上一轮（0.6.3：媒体评价改走官方接口 + 卡片箭头跟随展现模式）的部署与验收

**为什么又出一版**：0.6.2 上线后，`007 初露锋芒` 的媒体评价**仍然只有 1 条**，而
Metascore 上写着 99 条。排查结论是**站点改版**：游戏页与 `critic-reviews` 列表页的
HTML 里已经没有评价列表了（现在由 Nuxt 客户端调接口渲染），而且 `?page=` / `?offset=`
在 HTML 路由上不再生效（`?page=2` 返回的还是那 10 张卡）。前两轮「跟着分页器翻页」的
前提已经不存在，所以本版**改为直接调用站点自己在用的那个 JSON 接口**（公开、无需
key），HTML 解析退为兜底。

```bash
bash scripts/rebuild-and-verify.sh
```

本轮新增两个 feature 标记，部署后一条命令就能确认跑的是这一版：

```bash
curl -s http://127.0.0.1:3001/api/health | tr ',' '\n' | grep -E 'reviews-api-source|card-arrows-need-slideshow|"version"'
# 期望：version 0.6.3，两个标记都在
```

浏览器里两处肉眼验收：

1. **媒体评价抓全**：打开 `007 初露锋芒` → 「媒体评价」标签 → 点「重新抓取媒体评价」，
   等它跑完，总数应从 1 条变成接近 Metascore 的 99 条（面板一页 5 条，可翻页）。
2. **卡片箭头**：该游戏未设轮播时，首页卡片上**不再有**上一张/下一张；在「编辑海报」
   里选「轮播（自动切换）」后，卡片上出现箭头。

> 存量数据不会自动重抓：`last_meta_refresh` 已经写上的游戏要显式点一次「重新抓取媒体
> 评价」（或设置页的批量补全）。启动期维护只补轮播与通关时长，不碰评价。

### 上一轮（0.6.2：Metacritic 媒体评价）的部署与验收 —— 全程只需 Docker

**宿主机不需要 node / npm / 任何构建工具**：前后端的编译全部发生在镜像构建过程
里（Dockerfile 的 `build` 阶段跑 `npm run build`，产出 `backend/dist` 与
`web/dist`），你只需要执行 docker 命令。

```bash
# 一条命令：构建 → 起容器 → 等健康检查 → 确认存量数据已修复
bash scripts/docker-deploy.sh
```

就这一条。它会依次做：

| 阶段 | 做什么 | 失败时会怎样 |
| --- | --- | --- |
| 1 构建 | 复用 `scripts/docker-build.sh`（代理探测 + 容器内换源 + npm 源兜底） | 打印根因与修法，不动现有容器 |
| 2 指纹 | 读出镜像里的源码指纹，与仓库的 `.source-hash` 比对 | 只警告（指纹过期不是错误） |
| 3 起容器 | `docker compose up -d --no-build --force-recreate` | 打印错误并退出 |
| 4 校验 | 轮询 `/api/health`，并从日志确认启动期数据修复已执行 | 打印最近 40 行日志 |

常用变体：

```bash
bash scripts/docker-deploy.sh --no-build       # 只用现有镜像重建容器（跳过构建）
bash scripts/docker-deploy.sh --no-cache       # 怀疑镜像里是旧代码时，无缓存重建
bash scripts/docker-deploy.sh --tag v0.6       # 同时打一个版本标签
bash scripts/docker-verify.sh                  # 部署后自检（全部在容器内跑）
```

#### 为什么会有「产物自查」这一步

「镜像里还是旧代码」是这类项目最难排查的问题：容器起得来、健康检查也过、页面也
打得开，**只是少一个标签页**。常见成因是构建缓存命中了旧的 `COPY` 层，或某个
workspace 的 build 静默失败了。

所以构建阶段末尾加了一道门（`scripts/verify-build-artifacts.sh`）：直接检查
`backend/dist` 与 `web/dist` 里有没有本轮功能必须存在的符号（路由名、表名、前端
`data-testid`、中文文案），**缺一个就让构建失败**。宁可构建失败，也不要部署完再
发现。

同时镜像里会写入 `/app/build-info.json`（源码内容哈希 + 构建时间），你可以随时
问镜像「你是哪份源码构建的」：

```bash
docker run --rm --entrypoint sh screenplay:latest -c 'cat /app/build-info.json'
```

#### 部署后自检（同样只用 Docker）

```bash
bash scripts/docker-verify.sh
```

它会在容器里跑离线解析器测试（用镜像内的 HTML 夹具，**不访问真实站点**）、
检查前端产物里的媒体评价界面、并对着运行中的部署验证接口是否通。部署开了登录时，
接口那几项会显示为「跳过（401，属预期）」而不是失败。

#### 存量数据自动回填（容器启动即生效）

修复 provider **不会**自动修复已有的库：一个 `last_meta_refresh` 已经写上的游戏
不会再被扫描重刮。所以以下两件事在**容器每次启动**时自动执行，你不需要手动点任何
按钮（`backend/src/maintenance/maintenance.service.ts`）：

| 修复 | 时机 | 做什么 |
| --- | --- | --- |
| 封面轮播修复 | 每次启动，等首轮媒体扫描结束后 | 只在**封面没进轮播**时把它补进去。同时把旧规则自动加进轮播的相册截图清理出去（只清「机器替你决定」的，用户亲手勾选过的一律保留） |
| 通关时长补全 | 首次启动执行一次（记在 `settings` 表里） | 给仍无时长的游戏重新问一次数据源（会访问网络，串行限速） |

日志里会有一行明确结论：

```bash
docker compose logs screenplay | grep 'Boot maintenance'
# 例：Boot maintenance finished in 13.8s — poster rotation topped up for 20 game(s)
#     (+60 frame(s)); completion-time backfill started for 20 game(s).
```

看到 `nothing to repair` 也是正常结果（说明库里已经没什么可修的）。用
`MAINTENANCE_ON_BOOT=0` 可整体关闭；细节见 `.env.example`。

> 轮播下限是**每次启动都检查**、而不是「只跑一次」：它是纯数据库操作（不联网），
> 且只增不删（不会动你手动排除出轮播的行、也不会抢你选中的封面），所以重复执行
> 是幂等的。时长补全要联网、数据源限速，因此只跑一次，之后新加的游戏用设置页的
> 「一键批量补全」。

### 上一轮（大图区海报轮播修到全量游戏可用）的部署与验收

改动同时落在**后端 `dist/`** 与**前端 `public/`**（即 `web/dist`）两侧，所以必须
**重新构建镜像**再起容器 —— 只 `restart` 旧容器不会带上任何前端改动。

```bash
# 1) 构建（脚本会自动探测代理、注入构建期代理、必要时切换 apk/npm 源）
./scripts/docker-build.sh

# 2) 重启部署
docker compose up -d

# 3) 确认跑的是新镜像（关键：features 列表跟着镜像走）
curl -s http://127.0.0.1:3001/api/health | python3 -m json.tool | grep -E 'buildTime|poster-rotation-cover-only|poster-rotation-user-decided|card-carousel-vs-hero-carousel|review-pagination'

# 4) 容器健康状态
docker compose ps
```

期望在 `features` 里看到 `poster-rotation-cover-only` / `poster-rotation-user-decided` /
`card-carousel-vs-hero-carousel` / `review-pagination` 三项；看不到就说明镜像还是旧的 —— 也就是「只有个别游戏
能翻海报」的那一版。

> **升级后不需要重新刮削**：扫描时会把旧库里「用户从未手动动过」的海报行回填为
> 参与轮播，所以打开详情页就能看到多张。如果想让每个游戏的官方海报都补齐，再点一次
> 「全量重新刮削」即可。

> 这一步**已经自动化**：见上文「存量数据自动回填」——容器启动后会自己把低于轮播
> 下限的游戏补足，不再需要手动点「全量重新刮削」。

上面这套手工步骤仍可用，但现在已经有一条命令的版本（构建 + 部署 + 校验）：

```bash
bash scripts/docker-deploy.sh
```

如果不用脚本、直接走 compose 构建：

```bash
docker compose build && docker compose up -d
```

### 一键验证

```bash
bash scripts/verify-image-fix.sh
```

覆盖：后端健康与容器健康检查、运行时代理来源、容器内候选代理实测、
`test-image` 自检（含耗时体检）、`/api/media/proxy` 端到端、JXR 转码链路、入站与局域网可达性。

---

## JXR（JPEG XR）图片显示

浏览器原生不支持 JPEG XR，因此**全部在服务端转码为 WebP**（前端零解码器、零改动），
原始 `.jxr/.wdp/.hdp` 文件**永不修改**。

| 场景 | 处理 | 接口 |
|---|---|---|
| 缩略图列表 | 转码为 WebP 缓存 | `GET /api/media/:id/thumbnail` |
| 大图预览 / 查看原图 | 转码为 WebP（宽 2560） | `GET /api/media/:id/preview`、`/original` |
| 上传 JXR 作为自定义海报 | jpegxr 解码后再转 WebP | `POST /api/games/:id/posters/upload` |
| 远程 JXR 经图片代理 | 按内容识别后转 WebP | `GET /api/media/proxy?url=…` |

- 转码结果按 `mediaId@宽度v2.webp` 落盘缓存，同一张图只转一次（首次约 4s，二次约 5ms）。
  文件名里的 `v2` 是**色调映射版本号**（`JXR_PIPELINE_VERSION`）：算法一改就自动作废旧缓存，
  避免继续提供旧的、已经过曝的 WebP。改动色调映射逻辑时必须递增它。
- 解码链：`jpegxr`(WASM) → 8bit RGB 原始像素 → `sharp` → WebP。
- **支持 32 位浮点 HDR**：Xbox / Windows 游戏栏截图实测为 `bitDepth=32Float`、128bpp、
  3840×2160，亮度最大值可达 5.96（约 19% 像素 >1.0）。这类文件此前被位深检查直接拒绝，
  导致缩略图回退成 30MB 原始字节、大图返回 415。现在按像素采样自动确定白点，
  经 extended Reinhard 色调映射 + sRGB 编码后输出。
- **第 4 通道必须整体忽略**（这是「过曝」的真正原因）：`jpegxr` 的 32Float 输出里
  第 4 通道根本没被写入，它只是 WASM 堆上的一块残留内存——首次解码恰好是全 0，
  之后就是上一张图的像素。实测同一文件「落在 (0,1) 的像素占比」随解码顺序变化：
  单独解码时为 0%，在别的图之后解码时为 95.7%。而独立参考解码器
  （Python `imagecodecs.jpegxr_decode`）对同一批文件给出 alpha 恒等于 1.0。
  此前代码把它当成预乘 alpha 并对 RGB 做除法，导致 **30%–41% 的像素被提亮**，
  这正是用户看到的过曝与色彩失真；现在一律丢弃该通道并按不透明输出，
  且验证过同一文件在任何解码顺序下输出**字节完全一致**。
- **扫描阶段预生成**：扫描时用**一次解码**同时产出缩略图、预览图（宽 2560）与全尺寸三种
  WebP（`warmJxrRenditions`），因此首次点击即为缓存命中（实测 3.7–9.6ms，此前约 4s）。
  三个尺寸共用同一份色调映射结果，亮度实测最大差仅 0.4，不会出现某一档过曝或偏色。
  注意：`/original` 不传宽度，走 `@full` 键；三档都在扫描时一并预热。
- 真正无法解码的变体返回 **415** 并给出明确提示，而不是回传浏览器打不开的原始字节。
- 原有 `.jxr` 文件**字节与 mtime 均不变**（已在验证脚本中校验 md5）。

```bash
# 验证：三个接口都应返回 image/webp，魔数 52494646 (RIFF)
MID=<media-id>
for ep in thumbnail preview original; do
  curl -s -o /tmp/o -w "$ep %{http_code} %{content_type}\n" \
    "http://127.0.0.1:3001/api/media/$MID/$ep"
  head -c4 /tmp/o | xxd -p
done
```

---

## 手动匹配（绑定到正确游戏）

手动匹配会**整体替换**该游戏的身份数据，而不是只刷新所选的单个数据源：

1. 先向所选数据源确认该 id 的真实标题，并据此改名
2. 清空全部旧绑定（旧绑定指向的是另一个游戏）
3. 清空旧的身份字段（简介/海报/开发商/评分/截图等），避免残留旧游戏数据
4. 清空旧海报状态：删除旧的**自动刮削**海报、清除「已选中」标记并置空 `poster_url`
   （用户上传/相册海报文件保留但降级为非封面，避免误删用户素材）；
   否则卡片会继续显示上一个游戏的封面
5. 对所有已启用数据源做一次完整刷新

匹配完成后返回 `{matched, name, providers, failed, missing, reason}`：

- `missing` 列出**没取到的字段**（海报/简介/开发商/评分/截图），界面会明说是哪几项缺失；
- 无法解析该 id 时**直接返回 400 并说明原因**，不会再把旧游戏的数据当作成功结果。
  此前 id 填错会静默沿用上一个游戏的名字却报告成功，这正是「匹配失败但没有提示」的成因。

### 中文名 / 数字开头 / 带副标题的匹配

`RAWG` 与 `Steam` 都是按**拉丁标题的文本相似度**排序的，直接拿中文名去搜会返回
**完全无关的游戏**——实测 `命运2` 在 RAWG 上被解析成 `Fateline(命运线)`、
在 Steam 上解析成某个无关视觉小说；而 `Destiny 2` 在两边都能正确命中。

`metacritic-aliases.ts` 里的中文→英文别名表原本**只有 Metacritic 在用**。
现在通过 `titleQueryVariants()` 把同一套解析开放给所有数据源，按「别名 → 标题内的拉丁片段
（≥4 字符）→ 原始标题」依次尝试，因此中文名库也能正确匹配。

实测（生产库中的全部 13 个中文名）均已能解析出英文标题，含数字开头
（`007 初露锋芒` → `007 First Light`）、带副标题（`機戰傭兵™VI 境界天火™`
→ `Armored Core VI: Fires of Rubicon`）与纯中文名。

```bash
curl -s "http://127.0.0.1:3001/api/games/match/search?q=Hades"
# 中文名同样可直接搜索：三个数据源应都返回同一个英文标题
curl -s "http://127.0.0.1:3001/api/games/match/search?q=%E5%91%BD%E8%BF%902"
# → rawg/steam/metacritic 均为 "Destiny 2"

curl -s -X POST "http://127.0.0.1:3001/api/games/<gameId>/match" \
  -H 'Content-Type: application/json' \
  -d '{"provider":"rawg","externalId":"274755"}'
# → {"matched":true,"name":"Hades","providers":[...],"failed":[],"missing":[],"reason":""}

# 无效 id 应返回 400 且带中文原因，且不改动任何数据
curl -s -X POST "http://127.0.0.1:3001/api/games/<gameId>/match" \
  -H 'Content-Type: application/json' -d '{"provider":"rawg","externalId":"999999999"}'
```

---

## 海报自选与幻灯片轮播

- 详情页海报区域点击「编辑海报」进入管理：上传自定义海报、从相册选图、设为封面、勾选是否参与轮播。
- **相册加载做了专门优化**（游戏动辄 100–250 张截图）：
  - 网格只加载 **~6 KB 的缩略图**，不再拉取 2.5–9.8 MB 的 4K 预览图（实测相差 11375×）；
  - 图片**进入视口才请求**（`IntersectionObserver` 门控，而非只依赖 `loading="lazy"` 提示），
    120 张的相册在首屏只发起约 6–12 个请求；
  - 列表**分页挂载**（首屏 60 格，「再加载」按钮按需追加），避免一次性挂载几百个节点；
  - 提供**文件名筛选框**，可直接定位到某张图；
  - 全部图片都有**骨架屏占位**，不会出现空白无反馈的等待。
  - 效果：一个 120 张 4K 截图的相册，弹窗首屏负载从 **607 MB 降到约 5 KB**。
- 展现模式二选一，**卡片与详情页同时生效**：
  - `static` 静态：只显示选中的那张封面
  - `slideshow` 轮播：多张海报每 3.5 秒淡入淡出切换（超过 1 张时才轮播，并显示指示点）
- **官方海报统一纳入管理**：自动刮削得到的所有官方海报都会注册为海报记录（按来源分组显示
  「官方海报（自动抓取）/ 我上传的 / 游戏截图」），可设为封面、可加入轮播，权限与用户上传一致。
- **所有官方海报默认全部参与大图区轮播**，不只是封面。详情页大图区左右箭头常驻可见、
  `x/y` 计数常驻显示、首尾**循环**（不会点到底就卡住）。
  - 历史缺陷：一次刮削会写入多个数据源分片，而带封面的分片彼此不一致（RAWG 封面 vs
    Steam header），旧的「封面变了就清理旧海报」逻辑于是把前一个分片刚登记的官方截图
    整批删掉 —— 结果 20 个游戏里有 20 个最终只剩 1 张在轮播，用户看到的就是
    「只有个别游戏能翻页」。现在登记**从不删除**，身份变更（换绑游戏）由重新匹配流程统一清理。
  - 旧库**升级后无需重新刮削**：扫描时会把用户从未手动动过、但没进轮播的旧海报行回填进来。
- **相册截图默认不进轮播**：轮播里只放封面 + 用户亲手勾选的图。相册截图不再被自动补进
  轮播 —— 旧规则用「补到 `2 + 相册图数`」的方式把大量相册截图塞进轮播，本轮已移除，
  并且启动时会做一次清理把旧规则写进库的那些帧摘出来（只摘机器决定加进去的）。
- **代价（已知并接受）**：如果某个游戏的官方源只给出一张图、用户又没勾选任何图，详情页
  大图区就只有一帧。首页卡片不受影响 —— 它用的是全部已登记海报，官方截图仍会逐张轮播。
- **想让它更丰富**：在「编辑海报」里勾选要参与详情页大图轮播的图即可；勾选是即时的，
  且重新刮削不会把取消掉的勾选加回来。
- **优先级**：用户手动设置的封面优先于自动刮削——重新刮削不会覆盖用户已选的封面，
  也不会重复累积海报记录。「编辑海报」里手动取消勾选的轮播项，重新刮削后**不会被自动加回**。
- **取消封面 / 恢复默认**：用户设过的封面（上传的 / 相册截取的）按钮会变成「取消封面」。
  点击后清除封面标记并**自动恢复为该游戏的官方默认海报**，成功后对话框顶部给出绿色提示，
  图库卡片与详情页封面**立即更新，无需手动刷新**。取消**只清标记、不删文件**，
  所有海报记录都保留（实测取消前后均为 3 张）。
- 接口额外返回 `isCover`：只有「被选中 **且** 不是官方海报」时才为 `true`。
  界面据此决定是否显示「取消封面」——官方海报本身就是默认封面，对它显示取消入口是无效操作
  （取消的结果就是恢复它自己），这正是上一版「点了没反应」的观感来源；
  这种情况下界面显示「默认封面」。
- **封面状态自愈**：早期数据存在「`games.poster_url` 已设置、但 `game_posters` 里没有任何
  `is_selected=1` 的行」的状态（生产库 39 个游戏里有 34 个如此）。界面靠 `isSelected` 判断
  要不要显示取消入口，于是这些游戏看不到任何取消方式。现在读取海报列表时自动修复这个标记
  （只把 URL 与当前封面一致的那一行提升为选中，不会改变显示效果），
  也可手动触发：`POST /api/games/:id/posters/reconcile`。
- 自动刮削海报与用户上传海报均参与轮播；选中项会镜像写入 `games.poster_url`，因此图库卡片同步更新。
- 配置存于 `game_posters` / `games.poster_mode`，位于 `screenplay-data` 卷内，**容器重启不丢失**。

```bash
GID=<game-id>
curl -s "http://127.0.0.1:3001/api/games/$GID/posters"

# 取消封面（恢复官方默认；只清标记，不删任何图片）
curl -s -X POST "http://127.0.0.1:3001/api/games/$GID/posters/clear-selection"

curl -s -X PATCH "http://127.0.0.1:3001/api/games/$GID" \
  -H 'Content-Type: application/json' -d '{"posterMode":"slideshow"}'
```

---

## Metacritic（M 站）评分

### 为什么以前几乎没有评分

M 站搜索接口用的是 **slug 而非查询串**（`/search/<slug>/`），且只索引英文标题。
中文名因此生成空 slug 或残缺 slug，实测结果：

| 请求 | 返回 |
|---|---|
| `/search/宇宙机器人/` | 2 个无关游戏（`-2025`、`-5`） |
| `/search/女神异闻录5皇家版/` → `5` | 一堆无关游戏 |
| `/search/astro-bot/` | 23 个相关结果 ✅ |

所以中文名游戏**不可能**靠解析拿到评分，必须提供英文名。此前全库 39 个游戏只有 1 个有评分。

### 已修复

1. **中文名 → 英文名解析**：`backend/src/metadata/providers/metacritic-aliases.ts` 内置常见中/繁/日文
   游戏与英文标题对照（含最长前缀匹配，故 `機戰傭兵™VI 境界天火™` 也能命中）。中文名保持不变，
   仅用于检索。
2. **版本后缀剥离**：`EDITION_TAGS` 补上裸词 `edition` 与中文版次词（`完全版`/`豪华版`…），
   并把 `\b` 换成可匹配中文的边界判断（`\b` 对汉字无效，原写法会让中文标签失效）。
   `Bloodborne™ The Old Hunters Edition` 因此从「被误杀（0.52）」变为正常命中 87。
3. **拒绝错误匹配**：置信度下限现在同样作用于无模糊结果的兜底分支——此前
   `赛博朋克 2077` 会因 slug 退化为 `2077` 而绑定到无关的 `CONTROL Resonant`。
4. **限流器并发穿透修复**：`throttle()` 原先「先读后写」存在竞态，且 `getOnce()` 完全没走限流，
   导致批量刮削时并发请求同时打出，M 站返回空页 → 评分静默丢失。现已改为同步预留时间片。
5. **评分补全接口 + 失败自动重试**：批量刮削后会自动对仍未取到评分的游戏再补跑一轮。

### 使用

```bash
# 补全聚合评分（只处理缺评分的，比重刮全部快得多，可重复执行）
curl -X POST http://127.0.0.1:3001/api/games/backfill-scores
```

图库顶部「Metacritic 最低分」可正常过滤；卡片与详情页均显示 M 站标识、分数与媒体数。
实测：全库 39 个游戏 **38 个取到评分（97%）**，唯一未取到的 `Amber Alert` 在 M 站
确无评分（页面显示 “Critic reviews are not available”）。

未收录的中文名可在游戏详情页用「匹配数据源」手动绑定，绑定会持久化，无需再依赖别名表。

---

## 媒体评价（媒体名称 / 媒体打分 / 媒体评价原文）

详情页的「媒体评价」标签页展示**逐家媒体**的评价：媒体名称、该媒体的打分、以及
评价原文。面板底部有「数据来源」链接和「重新抓取媒体评价」按钮。

**分页展示**：默认显示 5 条，点「展开显示 10 条」加到 10 条，**一页最多 10 条**，
可前后翻页；面板上标注媒体评价总数。

**按平台查看**：面板提供平台下拉框，切换后只显示该平台的评价。选项只列**评价里真实
出现过的平台**（并带条数），不是游戏自身的平台列表 —— Metacritic 对同一款游戏在不同
平台下收录的媒体不同，按游戏平台列会让用户切过去只看到空列表。`platform` 为空的评价
不单列成「未知平台」，它们始终留在「全部平台」里。筛选在**前端**完成，后端契约与该
总数不变。

### 与聚合 Metascore 的区别

上面那节讲的是**聚合分数**（一个 0–100 的 Metascore + 媒体数）。这一节是**每一家
媒体的具体评价**：IGN 给了 90 分并写了这么一句，GameSpot 给了 80 分写了那么一句。
两者从同一个页面解析出来，但**存储、生命周期、失败处理完全不同**，所以分成两块做。

### 数据从哪来

`metacritic-reviews.ts` 是纯解析模块（无 I/O），按三种策略依次尝试并**合并**结果：

| 策略 | 说明 |
| --- | --- |
| `__NEXT_DATA__` | Next.js 内嵌 JSON，字段最结构化，通常能拿到媒体名 + 分数 |
| JSON-LD | `application/ld+json` 里的 `review` 数组，能补上作者与日期 |
| DOM | 渲染后的 HTML，是**唯一**能稳定拿到评价原文的入口 |

三种都要跑，因为**没有哪一种单独就够**：内嵌 JSON 往往有分数没有原文，DOM 往往
有原文丢字段。合并（`dedupeReviews`）之后才是一张完整卡片。

解析器对噪声做了两类防御，都是实测踩出来的：

- **`clampScore` 拒绝 >100**：Next.js 的 RSC 索引会产出
  `{publicationName:"…", score:3056}` 这种**列下标**而不是分数，不加这道闸门就会
  出现「IGN 3056 分」；
- **`isPlausibleOutlet` 拒绝句子**：选择器放宽之后，容器文字
  （`No critic reviews have been published yet.`）会被当成媒体名，于是面板上出现
  一条「媒体叫『该游戏暂无媒体评价』」的评价。现在要求媒体名必须短、且不含句读。

### 空状态为什么分四种

「面板是空的」有四种完全不同的原因，界面必须说清是哪一种——合并成一句
「暂无数据」会让只是**没配代理**的用户以为功能坏了：

| 状态 | 界面 |
| --- | --- |
| 从未抓取 | 「暂无媒体评价」+ 提示去点补全 |
| 抓到了、确实没有评价 | 「暂无媒体评价」+ 说明数据源没有收录 |
| 抓取失败 | 「抓取失败：<原因>」+ 提示重试是安全的 |
| 没找到对应条目 | 「未找到该游戏的对应条目」+ 提示去「手动匹配」 |

`unsupported` 也和成就/奖杯一样会落进 `reviews_status`，这样设置页卡片上的
「待补全」数字才按得掉。无对应条目的游戏会被补全重新列入候选，但**不发网络请求**
（绑定判断在抓取之前短路），所以不会为它们白等限速间隔。

### 失败了不会丢数据

这是这一块最重要的行为：**空结果和失败都不会清空已经抓到的评价**。评价抓取要逐
游戏访问一次页面，代价远高于聚合分数，而一次限流就抹掉用户正在看的列表是不可接
受的。只有「手动重新匹配游戏」会清空——因为那时评价确实已经属于另一款游戏了。

### 使用

```bash
# 批量补全媒体评价（只处理数据源还没回答过的：从未抓取 + 上次失败 + 无对应条目；
# 同步返回逐游戏结果，remaining 与设置页卡片上的「待补全」是同一个数字）
curl -X POST http://127.0.0.1:3001/api/games/backfill-ratings \
     -H 'content-type: application/json' -d '{"scope":"missing"}'

# 解析器修好之后全量重抓（修复「抓过但没解析出评价」的存量数据）
curl -X POST http://127.0.0.1:3001/api/games/backfill-ratings \
     -H 'content-type: application/json' -d '{"scope":"all","limit":20}'

# 覆盖率：awaiting 与上面 missing 批次的候选条件是逐字一致的表达式
curl http://127.0.0.1:3001/api/games/media-reviews/coverage
```

设置页有对应的「媒体评价补全」卡片（覆盖率 + 两个按钮），详情页面板上也有单游戏
的「重新抓取媒体评价」。

⚠️ **媒体评价源通常需要代理才能访问**（与 RAWG 共用设置页里的代理配置，
`METACRITIC_BASE_URL` 也可覆盖站点地址）。批量补全全部失败时，先检查代理。

### 独立爬虫脚本

`backend/scripts/crawlers/metacritic-media-reviews.mjs` 可以脱离服务单独抓取，
用来调选择器、导出 JSON 或直接补库：

```bash
# 用一个 URL 定位「是页面变了还是网络挂了」（最常用）
node backend/scripts/crawlers/metacritic-media-reviews.mjs --url <游戏页> --dry-run

# 用本地保存的 HTML 调解析器（完全不联网）
node backend/scripts/crawlers/metacritic-media-reviews.mjs --html page.html --dry-run

# 全库补全，写到数据库
node backend/scripts/crawlers/metacritic-media-reviews.mjs --db data/screenplay.db --write
```

脚本默认**串行 + 1.5s 间隔（带抖动）+ 条件请求（304 短路）+ 遵守 robots.txt + 重试**，
并且复用后端编译出的同一份解析器 —— 不复制一份出来，避免两边选择器漂移。
`--help` 有全部参数。

---

## 媒体库管理与其他新功能

以下功能均可在 Web 界面直接配置，**保存在数据库与数据卷中，重建容器后依然保留**。

### 1. 媒体库管理（设置页）

在「设置」页新增 **媒体库管理** 模块，可直接在网页上添加/编辑/删除媒体库路径：

- **添加媒体库**：填写容器内路径 → 选择媒体类型（图片+视频 / 仅图片 / 仅视频）
  → 设置是否扫描子目录、是否启用 → 保存后**立即触发扫描，无需重建容器**。
- **路径实时校验**：输入路径后会检查是否存在、是否可读，并列出识别到的子文件夹；
  路径不存在时会提示需要在 `docker-compose.yml` 中挂载，并列出容器内已挂载的候选目录。
- **编辑 / 删除**：用户添加的媒体库可随时修改或删除（删除仅移除配置，不动磁盘文件）。
- 来自环境变量 `MEDIA_DIRS` 的媒体库不能删除，只能停用。

### 2. Metacritic 评分

`metacritic.provider.ts` 已适配 Metacritic 现行的 `/game/<slug>/` 链接结构
（旧版 `/game/<platform>/<slug>/` 会自动 301 跳转），并修复了两处解析错误：

- 评测数读取 `reviewCount`（原先误读 `ratingCount`，导致始终为空）；
- 用户评分不再误匹配 Next.js 内部数组下标（曾在 0–10 量纲上产出 3056 这类错值）。

详情页显示完整 M 站评分与评测数，图库顶部「Metacritic 最低分」筛选与「按评分」排序均可用。

### 3. JXR（JPEG XR）图片

浏览器无法解码 JXR，因此**统一由后端解码为 WebP**：

- 缩略图、原图预览、相册大图三类场景全部输出 WebP；
- 新增 `GET /api/media/:id/preview` 接口返回浏览器安全的完整尺寸图片；
- 相册灯箱与「查看原图」改用该接口，不再直接请求原始 JXR 字节；
- 遇到无法解码的高位深变体时返回 `415` 并给出明确提示，而不是返回坏图。

### 4. 自定义海报

详情页海报区域悬停显示 **「编辑海报」** 入口，支持两种方式：

- **本地上传**：支持 JPG/PNG/WebP/GIF，上传后统一转为 WebP 存于数据卷；
- **从相册选择**：直接复用该游戏已有的相册图片。

选定后立即生效，图库卡片与详情页封面同步更新。

### 5. 多海报与展示模式

一个游戏可拥有多张海报（来源标记为 上传 / 相册 / 抓取），并支持：

- 指定任意一张为**图库封面**；
- 选择卡片封面显示模式：**静态**（单张）或**轮播**（自动切换，可逐张勾选是否参与）；
- 该模式同时作用于图库卡片与详情页海报区。

### 6. 自定义游玩平台

详情页新增 **「平台设置」** 入口，可多选实际游玩平台
（PC / PlayStation 5 / PlayStation 4 / Xbox Series X|S / Xbox One / Nintendo Switch 等）。

- 设置后**替代自动识别的平台**，卡片与详情页显示为用户设置的多平台标签；
- 图库平台筛选下拉会包含手动设置的平台，例如自动识别为 PC 但手动改为 PS5 后，
  按 PS5（或简写 `ps5`）筛选即可找到该游戏；
- 清空选择即恢复自动识别结果。

---

## 合规说明

- 所有爬取仅用于**个人非商用**场景，请求间隔不低于 1 秒（默认 1200ms），遵守目标站点
  robots.txt 精神并内置失败退避重试，请勿滥用。

## 路线图（按优先级）

1. **P0（已交付）**：文件夹扫描、游戏识别、通关时长、媒体浏览播放、Docker 部署。
2. **P1（已交付）**：IGDB/HLTB/Steam/Metacritic 四数据源、成就与价格展示。
3. **P2（已交付脚手架）**：Flutter Windows / Android 客户端。
4. **P3（预留）**：插件化扩展、高级筛选、多用户支持。