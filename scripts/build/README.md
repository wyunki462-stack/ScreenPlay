# scripts/build

构建期脚本 —— 只在**镜像构建过程中**执行，不进运行时镜像（用完全部 `rm` 掉）。

放进单独目录是为了 Docker 缓存：`Dockerfile` 用 `COPY scripts/build/ /tmp/` 一次性
COPY 整个目录，目录校验和覆盖目录内**全部文件内容**，所以改动这里任何一个脚本都会
让 apk 与 npm install 这两层缓存失效、重新执行。

## 为什么不能逐文件 COPY

`COPY scripts/xxx.sh /tmp/` 这种写法在实践中出现过「脚本改了却从未生效」：给
`apk-setup.sh` 加了实时进度输出后，构建日志里仍是旧行为（`索引OK →` 后面什么都没有），
排查一轮才发现容器里跑的是旧脚本 —— 不是脚本写错。改用目录 COPY 后这类问题不会再出现。

同时注意：`scripts/` 下**其它**脚本（部署、验证用的）不在这个目录里，它们的变化
不会连带打穿 apk / npm install 这类昂贵缓存。加新文件进本目录前请确认它确实是
构建期需要的。

## 内容

| 文件 | 用途 |
| --- | --- |
| `apk-setup.sh` | 容器内真实探测可用的 apk 源与代理，装 `python3 make g++ git`（build 阶段）与 `ffmpeg`（run 阶段） |
| `npm-run.sh` | npm 安装/构建，代理只走环境变量（绝不作为 npm 参数），探测不通则回落国内镜像源直连 |
| `proxy-probe.js` | 构建容器视角的代理可达性探测，供 `docker-build.sh --probe-proxy` 使用 |

三个脚本都被 `Dockerfile` 复制到 `/tmp/`，`apk-setup.sh` 与 `npm-run.sh` 在各自 RUN
步骤结束时删除。