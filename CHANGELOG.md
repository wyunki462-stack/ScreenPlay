# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。在 `1.0.0` 之前，版号中的
次版本号对应**功能迭代轮次**，同时以 `-beta.N` 标注测试阶段。

---

## [0.6.0-beta.1] — 2026-09-29

**Beta 测试版。** 第 6 轮迭代：媒体评价（Metacritic 评论原文）、海报轮播全量修复、
Docker 化构建与启动期存量数据修复，并完成面向公开发布的脱敏整理。

### 新增

- **媒体评价模块**（详情页「媒体评价」标签页）
  - 展示**媒体名称 / 媒体打分 / 媒体评价原文**三段式信息，按分数从高到低排列
  - 空状态区分四种来源：`ok`（本次抓到）/ `empty`（源站确无）/ `failed`（抓取失败）/
    `unsupported`（未绑定条目或站点无该条目）
  - **`empty` 与 `failed` 都不会删除已存的评价行** —— 源站抖动不会让历史数据消失，
    只有手动重新匹配才会清理
  - 抓取失败时提示里带具体原因（403 / 限流 / 不可达），而不是笼统的"暂无数据"
- **独立的 Metacritic 评论爬虫**
  `backend/scripts/crawlers/metacritic-media-reviews.mjs`，遵守站点限速
  （`CRAWLER_MIN_INTERVAL_MS`，默认 ≥1s）
- **数据表与接口**
  - 新表 `media_reviews`，新增 `games.reviews_status` / `reviews_error` /
    `reviews_fetched_at` / `reviews_count` 四列
  - `GET  /api/games/media-reviews/coverage` 覆盖率
  - `GET  /api/games/:id/media-reviews` 单个游戏
  - `POST /api/games/:id/media-reviews/refresh` 单个重新抓取
  - `POST /api/games/backfill-ratings` 批量补全
- **启动期存量数据修复**（`backend/src/maintenance/maintenance.service.ts`）
  - **海报轮播下限**：每次启动、等首轮媒体扫描结束后，把轮播帧数低于
    `2 + 相册图数`（上限 8）的游戏用本地相册截图补足。纯数据库操作、只增不删、
    幂等，因此每次启动都检查
  - **通关时长补全**：首次启动执行一次（在 `settings` 表记标记），对仍无时长的
    游戏重新问数据源
  - 解决一个真实缺口：修复后的 provider 只会影响**新刮削**的游戏，
    `last_meta_refresh` 已写上的存量游戏永远不会被重新处理
  - 可用 `MAINTENANCE_ON_BOOT=0` 整体关闭；等待扫描的上限由
    `MAINTENANCE_SCAN_TIMEOUT_MS` 控制
- **Docker 化构建与部署**（宿主机不需要 node / npm）
  - `scripts/docker-deploy.sh`：构建 → 指纹校验 → 重建容器 → 等健康检查 →
    确认启动期修复已执行
  - `scripts/docker-verify.sh`：部署后自检，全部在容器内运行
  - `scripts/verify-build-artifacts.sh`：**构建阶段**产物自查，缺符号即让构建失败

### 修复

- **构建缓存命中旧 `COPY` 层时镜像静默带旧代码**：在 build 阶段末尾增加产物自查，
  直接检查 `backend/dist` 与 `web/dist` 里是否存在本轮功能必须的符号
  （路由名、表名、前端 `data-testid`、中文文案，共 17 项），缺一个就让构建失败。
  宁可构建失败，也不要部署完才发现少一个标签页
- **`docker compose build` 路径下 npm 兜底源与构建代理静默失效**：
  `docker-compose.yml` 传了 `NPM_MIRROR_REGISTRY` / `SCREENPLAY_BUILD_PROXY`，
  但 Dockerfile 只在第一个 `FROM` **之后**声明它们 —— 按 Docker 规则，`FROM` 之后
  声明的 `ARG` 无法由 `build.args` 赋值，传进来的值会被当作"未使用的构建参数"丢弃。
  只有 `scripts/docker-build.sh`（显式 `--build-arg`）那条路径是好的，
  `docker compose build` 则表现为国内网络下构建超时且看不出原因。已把两个 `ARG`
  提到 `FROM` 之前，并补齐超时参数
- **启动期修复在扫描开始前就退出，导致整个功能静默失效**：
  `onApplicationBootstrap` 在 `app.listen()` **期间**执行，而首轮扫描原先在
  `listen()` **之后**才启动。于是修复逻辑看到 `isScanning() === false`，
  误判为"扫描已完成"，在空库上得出"没什么可修的"，0.2 秒退出。
  修了两处：`main.ts` 把 `startScan()` 提到 `listen()` 之前；停止条件改为
  `!isScanning() && hasScanned()`（并给 `LibraryService` 增加 `hasScanned()`，
  因为只看 `isScanning()` 无法区分"还没开始"和"已结束"）
- 统一接口对「无分数但有原文」的评价的处理（不应因缺分数而丢弃整条评论）

### 变更

- 详情页标签文案「评价」→「**媒体评价**」，与聚合 Metascore 明确区分
- `GET /api/health` 增加 `buildTime` 与 `features` 字段：**"部署的镜像是哪一版"
  变成一条 `curl` 就能判断的事**，不必再靠读代码猜
- 版本号可通过 `BUILD_VERSION` 注入镜像（构建脚本从根 `package.json` 读取）

### 安全 / 脱敏（面向公开发布）

- 移除验证脚本中硬编码的真实 API 密钥与内网代理地址，改为从环境变量读取；
  缺少凭据时相关检查组**明确跳过并说明原因**，不假装通过
- 登录页用户名占位符由真实账户名改为通用示例
- 移除与项目无关的个人 NAS 代理配置；`/vol2/...` 等个人绝对路径改为相对推导
  或可覆盖的环境变量
- `docker-compose.yml` 的媒体挂载路径改用 `MEDIA_HOST_DIR` 变量，不再写死个人目录
- 收紧 `.gitignore`：忽略各轮次生成的 `out-*.cjs` 打包产物、`.tmp*` 工作区与本地备份

---

## 历史轮次

以下轮次在建立版本号体系前完成，归档记录见 [`docs/VERIFY.md`](docs/VERIFY.md)。

| 轮次 | 主题 | 主要能力 |
| --- | --- | --- |
| 1 | 基础骨架 | 媒体目录扫描、游戏识别与匹配、相册展示与播放、SQLite 持久化 |
| 2 | 界面语言与封面 | 简体中文 / English 双语（399 键对齐）、取消封面 / 恢复默认 |
| 3 | 登录认证 | NAS 本地系统账户登录（PAM 体系同一批账户）、会话管理 |
| 4 | 海报与成就 | 海报自选、幻灯片轮播、Steam 成就全量刮削、手动选择游戏 |
| 5 | 奖杯与布局 | PlayStation 奖杯刮削（psnine）、游戏卡片统一 16:9 横向比例 |

---

[0.6.0-beta.1]: https://github.com/wyunki462-stack/ScreenPlay/releases/tag/v0.6.0-beta.1