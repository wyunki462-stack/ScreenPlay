# 容器侧 before/after 采集 —— 宿主机上的四步

这份是给**你自己在 NAS 宿主机上执行**的操作卡。原因：容器级测量（镜像体积、容器 RSS、
cgroup 峰值、容器内 `/data` 与 SQLite）必须由具备 docker 权限的账户来做，我这边（uid 973）
连不上 `/var/run/docker.sock`。

前提：能跑 `docker` 的账户（在 docker 组里），工作目录是仓库根（`/vol2/1000/ScreenPlay`）。

---

## 0. 先取「优化前」基线（必须在重建之前 —— 只有这一次机会）

```bash
AUTH_USER=你的登录账号 AUTH_PASSWORD=你的登录密码 \
  bash scripts/perf-baseline.sh --load OUT=docs/perf/before-docker.txt
```

* 这一步跑在**当前未重建的 1.2.0 容器**上，采到的就是「优化前」。**务必第一次就带凭据**：
  重建（`docker compose up -d` 换掉容器）之后，这台机器上就再也取不到「优化前」了
  （容器即使 tag 仍是 `screenplay:latest`，旧镜像层也还活着，但容器一旦被替换就没了）。
* 脚本是**只读**的：容器内只跑 `grep /proc/1/status`、`du`、`ls`，SQLite 探针用
  `readonly: true` 打开；万一 WAL 打不开只读句柄，它会先复制一份到容器 `/tmp` 再读，
  绝不动原始数据库。
* **强烈建议带 `AUTH_USER`/`AUTH_PASSWORD`**：不带也能跑，但第 ⑤ 节会退化成只测公开接口——
  `/api/games/:id`、`/api/games/:id/media`、`/api/media/:id/thumbnail|cover|preview` 全部 404
  （登录后才拿得到 media id），而**图片渲染件正是最热的路径**，这一节就白测了。
  before/after 两次必须用同一套凭据，否则这节不可比。
* `OUT=` 既可以写在前面的环境变量位置，也可以当参数跟在后面，两种等价：
  `bash scripts/perf-baseline.sh --load OUT=docs/perf/before-docker.txt`。
* 结尾会打印 `# KEY=VALUE` 摘要，并**同时写进** `OUT` 指定的文件；脚本还挂了退出兜底，
  万一中途某一步出错，已采集到的键值也会落盘（不会白跑一趟）。
* 六节：①镜像 ②容器运行时内存 ③磁盘占用 ④SQLite 结构与碎片 ⑤热接口延迟
  ⑥`--load` 前后对比（第一次跑没有 before 可比，属正常）；摘要约 54 个键。

## 1. 重建镜像 + 重启容器 + 体检

```bash
bash scripts/rebuild-and-verify.sh
```

* 5 步：环境预检 → `docker-build.sh` → `docker-deploy.sh` → 体检（15 个 feature 标记 +
  `version = 1.3.0` + 启动期维护日志）→ 前端投递（`Content-Encoding` / `immutable` /
  `index.html` 的 `no-cache`）。
* 全量日志同时写进 `logs/rebuild-<时间戳>.log`；哪一步红了把日志最后一段贴出来即可。
* 「工作区有未提交改动」的提醒是**预期的** —— 本轮按你的要求没有提交，构建会包含这些改动。
* 体检如果报某个 feature 标记缺失：`NO_CACHE=1 bash scripts/rebuild-and-verify.sh`。
* 本轮运行阶段换成了**最小基础镜像**（优化项 16）：`FROM alpine:3.24` + 只 `COPY` 一个 node 二进制 +
  `libstdc++`，不再带 npm / corepack / node 头文件。构建日志里那条 `RUN node -v` 通过 = 二进制与
  `libstdc++` 都对；`docker images` 的体积应明显小于上一版（确切数字看第 3 步的 `image_size_bytes`）。
  alpine 版本**故意与构建阶段 `node:22-alpine` 同版（3.24）**，这样容器里的 `ffmpeg` / `libstdc++`
  与你现在跑的 1.2.0 完全同包版本（写 3.22 会从另一套仓库装 ffmpeg 6.1.2-r2，见报告优化项 16）。

## 2. 打包（只有需要拷到另一台机器时才做）

```bash
SKIP_BUILD=1 bash scripts/package-image.sh
```

* 包名形如 `dist-image/screenplay-1.3.0-<HEAD 短 sha>.tar.gz`（工作区还脏着时带 `-dirty` 后缀，
  例如 `dist-image/screenplay-1.3.0-bc206a3-dirty.tar.gz`），同时生成 `.sha256`。
  这样既不会和「同样是 HEAD 的上一版包」重名，也如实说明它包含未提交内容。
* 脚本会**先**验证输出目录可写，再开始 `docker save`，不会白等一次导出。

## 3. 再取「优化后」基线（重建之后）

```bash
AUTH_USER=你的登录账号 AUTH_PASSWORD=你的登录密码 \
  bash scripts/perf-baseline.sh --load OUT=docs/perf/after-docker.txt
```

* 这一次测的是新镜像的容器，`--load` 那节会同时打印相对「优化前」的差值。

## 3.5 可选：把数据库文件收缩一次（默认关，与上面四步无关）

新镜像里多了一个**默认关闭**的开关（优化项 15）：`MAINTENANCE_VACUUM=1` 时，后端在启动、
开始监听之前对 SQLite 做一次 `VACUUM`，把删行留下的空闲页真正还给文件系统。

```bash
# 做法：在 docker-compose.yml（或 docker-compose.deploy.yml）的 screenplay 服务下
# 临时加一行环境变量，然后重启：
#   environment:
#     - MAINTENANCE_VACUUM=1
docker compose up -d          # 容器重启时执行一次 VACUUM，日志里出现 VACUUM finished 行
docker compose logs --since 5m screenplay | grep VACUUM
# 看过日志后把那一行删掉，再 docker compose up -d 恢复正常（之后就完全不涉及了）
```

* 默认**不设**这个变量 = 完全不变（不 `VACUUM`）。想临时收缩就加一次、看过日志之后再删掉：
  第一次通常回收最多（历史删除都堆在空闲页链表里），之后再开会变成每次启动都白等一遍。
* 代价要知道：`VACUUM` 要重写整库、瞬时需要约等于库大小的空闲空间，better-sqlite3 是同步的，
  大库上会**阻塞启动**数十秒到数分钟（日志会打印耗时与前后体积）。
* 不想动环境变量也行 —— 手工一条命令等价（**注意：运行镜像里没有 `sqlite3` CLI**，
  它只装了 `ffmpeg`；所以用镜像自带的 `better-sqlite3` 直接执行）：
  ```
  docker compose stop screenplay
  docker compose run --rm --entrypoint node screenplay \
    -e "new (require('/app/node_modules/better-sqlite3'))('/data/screenplay.db').exec('VACUUM')"
  docker compose start screenplay
  ```
  （先停再跑是因为 `VACUUM` 需要独占访问。同一条命令也适用于任何 `PRAGMA` 检查。）
* 上面第 0 / 3 步的基线采集**不需要**这个开关，两者互不影响。

## 4. 交接

> **状态：这四步已经在 2026-10-03 跑过一遍了。** 结果落在 `docs/perf/before-docker.txt`（11:50，未重建的 1.2.0）
> 与 `docs/perf/after-docker.txt`（11:57，重建后），对比表 `docs/perf/compare.md` 已生成（镜像 386.8 → 322.1 MiB，
> −16.72%；同口径 60 请求内存增量 RSS −65.7% / cgroup −58.8%；`/data` −2.4%；空闲态 WAL 4.1 MiB → 156.9 KiB）。
> 本节的四步现在只用于**将来复采**（例如换机器、或想补一行「容器跑稳后的空闲态快照」——
> 那次不需要重建，只要在容器启动 30 分钟以上、没有扫描在跑时重跑第 3 步，再重跑下面的 compare 即可）。

两个文件留在仓库里就行，**不用回贴全文**：`docs/perf/before-docker.txt`、
`docs/perf/after-docker.txt`。对比表由一条命令生成（只读这两个 txt，不碰 docker）：

```bash
bash scripts/perf-compare.sh docs/perf/before-docker.txt docs/perf/after-docker.txt docs/perf/compare.md
```

产出「运行内存峰值 / 镜像体积 / 磁盘占用」三项的 before/after 对比表（外加 SQLite PRAGMA 与 12 条热接口耗时附录）。
想确认采集是否成功，`grep '^# ' docs/perf/*-docker.txt` 看两行时间戳就够了。

这个脚本我已经**用一份合成的 before/after 干跑过一遍**（全键齐全 + 缺键 + 文件不存在三条路径）：
表头、差值换算、百分比、`✅ 缩小 / ⚠️ 增大` 标记都正确，缺键显示 `—`，读不到文件则退出码 2 并打印用法。
中性行（层数、`page_size`/`cache_size`/`mmap_size`/`journal_mode` 这些 PRAGMA 原值）**只报差值，不加方向标记、
不给百分比** —— 换基础镜像会多一层，「层数 −1」说成「缩小」或「−7.7%」都没有意义；相等的行写「持平」。
附录里的接口键名沿用采集端写法（`perf-baseline.sh` 把 URL 里的非字母数字字符换成 `_`），
所以看到 `api__api_games_limit_60_ms` 就是 `GET /api/games?limit=60`，输出末尾有一行同样的说明。
它只读这两个 txt，不碰 docker。

---

## 4.5 可选：报告里的结论怎么自己复核（全都**不需要 docker 权限**）

| 想复核什么 | 一条命令 | 期望 |
| --- | --- | --- |
| Dockerfile / `.dockerignore` 分层与部署契约（33 项静态自查） | `node scripts/verify-docker-layers.mjs` | `结果：33 项通过 / 0 项失败`，退出码 0 |
| **换 `alpine:3.24` 不会装错包**（包级等价性，§3.1.2） | 先从容器里取包清单：`docker compose exec screenplay cat /lib/apk/db/installed > /tmp/installed.txt`，再 `python3 scripts/perf-bench/apk-parity.py --before-db /tmp/installed.txt`（会联网下 minirootfs 与 v3.24 的 APKINDEX，缓存到 `/tmp/screenplay-apk-parity`） | `结果：包级等价性核对通过（rootfs 16 / before 123 / 闭包 113）`，退出码 0 |
| **为什么不写 Node 堆参数**（§七） | `N=1200 STEP=400 NODE_OPTIONS='--max-semi-space-size=8' bash scripts/perf-bench/bench-soak.sh`（换 `NODE_OPTIONS` 跑四遍，原始数据见 `docs/perf/heap-flags.txt`） | 默认 vs `--max-old-space-size=256` 几乎一样；`--max-semi-space-size=8` 的 VmRSS **更高** |
| 全量离线回归（16 项 / 434 断言） | `bash scripts/verify-suites.sh docs/perf/suites-mine.txt` | 末尾 `# 汇总：… 16 项通过 / 0 项失败`，日志落在你给的文件名里 |
| **缩略图为什么不「无损再压一遍」**（优化项 9 末条） | `node scripts/perf-bench/thumb-compress.js`（可传任意图片路径，默认用仓库里的 1024×1024 图标） | gzip −0.8% / brotli −1.2% / 无损 WebP 重编码 **+308.5%**；能变小的只有降质量（=−12%，会改画面） |
| 日志上限 + 轮转确实生效（方向②） | `docker compose -f docker-compose.yml config -q; echo $?` 与 deploy 那份同样跑一遍（**只解析文件，不需要守护进程权限**） | 两份都 `exit=0`；`config` 输出里 `max-size: 10m` + `max-file: "3"` ⇒ 30 MiB/容器（留档 `docs/perf/log-rotation.txt`） |

这些都只读本地文件（`apk-parity.py` 只额外读 dl-cdn 上的公开 APKINDEX），不会碰容器、不会改仓库。

---

## 故障排查

| 症状 | 原因 / 修法 |
| --- | --- |
| `docker info` 失败 / 提示 `/var/run/docker.sock` 权限 | 换到 docker 组里的账户；或 `sudo -E bash scripts/...` |
| 输出目录不可写 | `chmod 755 dist-image`（你是属主时）或 `OUT_DIR=/tmp/dist-image bash scripts/package-image.sh` |
| 第 3 步报「目标文件已存在」 | 删掉旧的 `dist-image/screenplay-*.tar.gz`，或换个 `OUT_DIR` |
| 体检报若干 feature 标记缺失 | 大概率构建缓存：`NO_CACHE=1 bash scripts/rebuild-and-verify.sh` |
| 容器起来就退出，日志里 `node: not found` / 动态库加载失败 | 运行阶段已是 alpine（优化项 16）：缺 `libstdc++`。确认 Dockerfile 里 apk 那步是 `sh /tmp/apk-setup.sh ffmpeg libstdc++`、且 `COPY --from=build /usr/local/bin/node /usr/local/bin/node` 在位；`node scripts/verify-docker-layers.mjs` 可静态核对（9 组 33 项） |
| 基线脚本报「容器 screenplay 未在运行」 | 先 `docker compose up -d`，再重跑基线（容器相关小节靠它才有数据） |
| 第 ⑤ 节里 `/api/media/*` 三条是 404 | 没传 `AUTH_USER`/`AUTH_PASSWORD`（或没登录成功）；带上凭据重采，否则测不到图片热路径 |
| `docs/perf/before-docker.txt` 里 `api_*` 全是 404 / 键很少 | 同上，或容器刚起还没扫描完；等 `/api/health` 稳定后重跑这一份 |
| `version` 不是 1.3.0 | 本轮已把版本号从 `1.2.0` 升到 `1.3.0`；若重建后仍显示 1.2.0，说明跑的还是旧镜像（或构建缓存命中了旧层）。你刻意跑别的版本时忽略这条即可 |