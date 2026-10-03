# ScreenPlay —— 源码 / 镜像 怎么传出去（照着敲）

本文不绑版本号：先取一次当前版本，后面所有命令都用 `$V`。

```bash
cd /vol2/1000/ScreenPlay
V=$(node -p "require('./package.json').version")   # 例：1.0.0
echo "$V"
git log --oneline -1                              # 确认要推的就是这个提交
```

镜像用 `bash scripts/docker-build.sh` 构建（版号从根 `package.json` 读，自动带进镜像的
`BUILD_VERSION`），下面每一步都给「命令」和「应该看到什么」。

---

## 0. 这台机器的两个已知坑（先看，能省半小时）

| 坑 | 症状 | 解法 |
|---|---|---|
| 直连 GitHub / ghcr.io 时 TLS 被中间盒打断 | `gnutls_handshake() failed: The TLS connection was non-properly terminated`，或 `curl` 直接 `000` 超时 | git 命令统一加 `-c http.sslVersion=tlsv1.2`（强制 TLS 1.2 就能通，实测有效） |
| 当前账号不在 docker 组 | `docker info` → `permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock`（socket 是 `root:docker 660`） | `sudo usermod -aG docker $USER`，然后**重新登录**（或 `newgrp docker`）再跑 `docker info` 应看到 Server 信息 |

如果这台机器上压根没装 docker：`docker --version` 报 not found → 直接跳到 **C 段**，在 Windows 那台上用 Docker Desktop 做（源码部分照 A 段）。

---

## A. 源码 → GitHub（3 步）

### A1. 准备一个 PAT（只需要一次）
浏览器打开 <https://github.com/settings/tokens> → **Generate new token (classic)** →
勾 **repo**（要推镜像到 GHCR 就顺手勾上 **write:packages** + **read:packages**）→ 生成，**复制那串 `ghp_...`**（页面关掉就看不到了）。

### A2. 推

```bash
cd /vol2/1000/ScreenPlay
git -c http.sslVersion=tlsv1.2 push origin main
```

- 提示 `Username for 'https://github.com':` → 填 `wyunki462-stack`
- 提示 `Password for 'https://wyunki462-stack@github.com':` → **粘贴刚才的 PAT**（不是 GitHub 登录密码）
- 应该看到 `Writing objects: ... done.` 与 `... main -> main`

**没有 TTY 的 shell**（提示完用户名就直接退出）就用这一条：
```bash
git -c http.sslVersion=tlsv1.2 -c credential.helper=store push \
  https://wyunki462-stack@github.com/wyunki462-stack/ScreenPlay.git main
```
（`credential.helper=store` 会把 token 明文写进 `~/.git-credentials`，本机自用可接受。）

### A3. 验证
```bash
git -c http.sslVersion=tlsv1.2 ls-remote origin main   # 输出的 sha 应等于本机 git rev-parse HEAD
```
或浏览器开 <https://github.com/wyunki462-stack/ScreenPlay> → 最新提交应与本机 `git log --oneline -1` 一致。

> 可选：给这一版打标签并推上去
> ```bash
> git tag "v$V" && git -c http.sslVersion=tlsv1.2 push origin "v$V"
> ```

---

## B. 镜像 → Docker Hub / GHCR（4 步）

### B0. 先把「仓库」在网页上建好（各一次）
- Docker Hub：<https://hub.docker.com/repositories> → **Create repository** → 名字填 `screenplay` → Public。
  没建就推会直接 `denied`。
- GHCR：不用建。第一次推成功后会出现在 <https://github.com/users/wyunki462-stack/packages>，
  **默认 private**，要公开得进包设置里改。

### B1. 构建
```bash
cd /vol2/1000/ScreenPlay
bash scripts/docker-build.sh          # 构建阶段 node:22-alpine，运行阶段 alpine+node 二进制；自带代理探测/换源/降级
docker images | grep screenplay       # 应看到 screenplay  latest  <id>  ...
```
构建阶段末尾会打印 `[slim] node_modules: …`（瘦身步骤生效的证据），并做构建产物校验
（`scripts/verify-build-artifacts.sh`，确认前端 bundle、后端编译产物、`build-info.json` 齐全）。

如果构建阶段就卡在 `apk add` / `npm ci`，说明构建容器也走了直连：加 `--no-proxy` 或
`SCREENPLAY_BUILD_PROXY=http://127.0.0.1:7890 bash scripts/docker-build.sh`（本机 mihomo 混合口在 7890）。

### B2. 登录（各一次，装好凭据就不用重复）
```bash
docker login ghcr.io -u wyunki462-stack   # 密码填 PAT（必须勾 write:packages）
docker login -u wyunki                     # 密码填 Docker Hub 的 Access Token
```

### B3. 推
```bash
bash scripts/push-to-ghcr.sh screenplay:latest "$V"
```
> `DOCKERHUB_USER` 默认就是 `wyunki`；要换成别的命名空间写 `DOCKERHUB_USER=xxx`，只推 GHCR 则写 `DOCKERHUB_USER=`（显式置空）。
脚本会：给两个仓库各打 `:$V` 和 `:latest` 两个标签 → **先推版本标签、再推 latest** →
失败按层续传自动重试（默认 5 次 × 5 秒）→ 命中 `denied/unauthorized` 立刻停下提示你先登录。
成功后结尾打印 `✓ 全部标签推送成功`，失败会列出没推成功的标签（重跑同一条命令即可接着传）。

> 第二个参数省略时脚本自己从 `package.json` 取版本；只有想推成别的版号才需要显式传。

### B4. 验证
- <https://hub.docker.com/r/wyunki/screenplay/tags>
- <https://github.com/users/wyunki462-stack/packages>
- 目标机拉取：`docker pull ghcr.io/wyunki462-stack/screenplay:$V`

### B5. push 卡住 / 报 TLS、超时怎么办
docker daemon 是**自己**连出去的（不走 shell 的 http_proxy），你的 `/etc/docker/daemon.json` 里
`"proxies": {}` 是空的 → 给它配上代理再重启：

```bash
sudo mkdir -p /etc/systemd/system/docker.service.d
sudo tee /etc/systemd/system/docker.service.d/proxy.conf >/dev/null <<'EOF'
[Service]
Environment="HTTP_PROXY=http://127.0.0.1:7890"
Environment="HTTPS_PROXY=http://127.0.0.1:7890"
Environment="NO_PROXY=localhost,127.0.0.1,192.168.0.0/16,172.16.0.0/12,10.0.0.0/8"
EOF
sudo systemctl daemon-reload && sudo systemctl restart docker
docker info | grep -i proxy     # 应看到 HTTP Proxy / HTTPS Proxy = http://127.0.0.1:7890
```

---

## C. 推不上就打包搬走（局域网 Windows 同法）

### C1. 在本机打包
```bash
cd /vol2/1000/ScreenPlay
bash scripts/package-image.sh
```
产出（`dist-image/` 已被 gitignore，不会进仓库）：
- `dist-image/screenplay-$V-image.tar.gz` —— `docker save` 出来的镜像包
- `dist-image/screenplay-$V-如何上传.txt` —— 给 Windows 的分步清单
- 还会打印各包的 **sha256**（拷过去后校验：Windows 上用 `certutil -hashfile <文件> SHA256`）

### C2. 拷到那台 Windows
直接拷 `dist-image/` 里的文件（本机 SMB 共享取，或 U 盘）。

**如果目标机是 Linux / 另一台 NAS（有 ssh + rsync）**，也可以一条命令自动搬：
```bash
bash transfer-image.sh 用户名@192.168.3.13
```
它做三步：`docker save` 导出 → `rsync` 传输（断线可续，重复运行从断点继续）→ 远端 `docker load` 并起服务。
Windows 一般没装 rsync，别用这条，走上面的 Docker Desktop 流程。

### C3. 在 Windows 的 Docker Desktop 上
```powershell
# 1) 载入镜像（文件名按实际版本替换）
docker load -i screenplay-<版本>-image.tar.gz
# 2) 登录（同上，凭据在 Windows 上重新登一次）
docker login ghcr.io -u wyunki462-stack
docker login -u wyunki
# 3) 推（先版本标签、后 latest；Windows 上重跑同一条即可重试）
docker tag screenplay:latest ghcr.io/wyunki462-stack/screenplay:<版本>
docker push ghcr.io/wyunki462-stack/screenplay:<版本>
docker tag screenplay:latest ghcr.io/wyunki462-stack/screenplay:latest
docker push ghcr.io/wyunki462-stack/screenplay:latest
```

### C4. 不推仓库、直接在目标机跑（离线部署）
```powershell
docker compose -f docker-compose.deploy.yml up -d --no-build --force-recreate
```
访问 `http://<目标机IP>:3001`，`curl http://127.0.0.1:3001/api/health` 应返回
`"version": "<你构建的版号>"`。各版号的 feature 标记见 `docs/VERIFY.md` 顶部与 `CHANGELOG.md`。

---

## D. 源码也可以用 bundle 搬（不经 GitHub）
先在本机生成两个包（`dist-image/` 已在 gitignore 内）：

```bash
cd /vol2/1000/ScreenPlay
git archive --format=tar.gz --prefix="screenplay-$V/" -o "dist-image/screenplay-$V-src.tar.gz" HEAD
git bundle create "dist-image/screenplay-$V.bundle" --all
sha256sum dist-image/*          # 拷到别的机器后用它核对完整性
```
- `screenplay-$V-src.tar.gz`（`git archive` 全树快照，不含 git 历史）
- `screenplay-$V.bundle`（完整 git 历史，`git bundle verify` = complete history）

在另一台机器上从 bundle 建仓库并推：
```bash
git clone "screenplay-$V.bundle" "screenplay-$V" && cd "screenplay-$V"
git remote set-url origin https://github.com/wyunki462-stack/ScreenPlay.git
git -c http.sslVersion=tlsv1.2 push origin main
```

两个包都从**当前 `main` 顶端**生成（`git log --oneline -1` 可见），已包含 `scripts/push-to-ghcr.sh`。
版本升了之后按上面的命令重新生成即可 —— 校验值以本机 `sha256sum` 的输出为准。