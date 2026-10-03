# ScreenPlay 优化前后对比（容器侧实测）

- 优化前：`docs/perf/before-docker.txt`（ScreenPlay perf baseline 2026-10-03 11:50:39）
- 优化后：`docs/perf/after-docker.txt`（ScreenPlay perf baseline 2026-10-03 11:57:50）
- 生成：`bash scripts/perf-compare.sh` —— 只读这两个文件

## 一、镜像体积

| 项目 | 优化前 | 优化后 | 变化（差值 / 百分比） |
| --- | --- | --- | --- |
| 镜像解压体积 | 386.8 MiB | 322.1 MiB | -64.7 MiB  -16.7%  ✅ 缩小 |
| 各层大小合计 | 406.3 MiB | 337.6 MiB | -68.7 MiB  -16.9%  ✅ 缩小 |
| 层数 | 13 | 12 | -1    （不判方向） |

## 二、运行内存峰值

| 项目 | 优化前 | 优化后 | 变化（差值 / 百分比） |
| --- | --- | --- | --- |
| VmHWM（进程 RSS 峰值） | 153.3 MiB | 152.5 MiB | -856.0 KiB  -0.5%  ✅ 缩小 |
| cgroup 内存峰值（含内核/页缓存） | 784.3 MiB | 622.7 MiB | -161.6 MiB  -20.6%  ✅ 缩小 |
| VmRSS（采集时刻 RSS） | 13.0 MiB | 120.8 MiB | 107.8 MiB  +829.8%  ⚠️ 增大 |
| cgroup 当前占用 | 21.5 MiB | 557.8 MiB | 536.3 MiB  +2492.0%  ⚠️ 增大 |
| VmPeak（虚拟地址空间峰值） | 10.79 GiB | 10.79 GiB | -1.4 MiB    ✅ 缩小 |
| 读负载后 cgroup 增量 | 7.9 MiB | 3.2 MiB | -4.6 MiB  -58.8%  ✅ 缩小 |
| 读负载后 RSS 增量 | 9.0 MiB | 3.1 MiB | -5.9 MiB  -65.7%  ✅ 缩小 |

## 三、磁盘占用

| 项目 | 优化前 | 优化后 | 变化（差值 / 百分比） |
| --- | --- | --- | --- |
| /data 合计 | 311.4 MiB | 304.0 MiB | -7.4 MiB  -2.4%  ✅ 缩小 |
| SQLite 主文件（探针 stat，权威口径） | 256.2 MiB | 256.2 MiB | 0 B    持平 |
| SQLite 主文件（③ 段 ls -l 汇总，口径存疑） | 3.2 MiB | 3.2 MiB | 0 B    持平 |
| SQLite WAL（采集时刻，空闲态） | 4.1 MiB | 156.9 KiB | -3.9 MiB  -96.2%  ✅ 缩小 |
| SQLite WAL（读负载后探针） | 4.0 MiB | 4.0 MiB | 0 B    持平 |
| 页数（page_count） | 65596 | 65596 | 0    持平 |
| 空闲页（freelist_count） | 812 | 812 | 0    持平 |

> 关于上面两组同名指标：③ 段用容器里 `ls -l /data/*.db | awk {s+=$5}` 汇总、④ 段探针用
> `stat()`，同一容器同一时刻附近却给出不同的数（实测 3,399,680 B vs 268,697,600 B），成因未定；
> 本表**以探针的 stat 为准**，并保留 ③ 段数值供对照。WAL 同理：读负载后两边都停在 1000 页
> 自动 checkpoint 阈值（4 MiB），真正体现启动 `wal_checkpoint(TRUNCATE)` 的是「采集时刻」那一行。

> 容器侧「/data 子目录明细」「宿主侧产物」见两份原始基线文件；镜像瘦身明细见 `docs/perf/PERF-REPORT.md` 3.1。

## 四、附录：SQLite 与热接口

| 项目 | 优化前 | 优化后 | 变化（差值 / 百分比） |
| --- | --- | --- | --- |
| page_size | 4096 | 4096 | 0    持平 |
| cache_size | -2000 | -2000 | 0    持平 |
| mmap_size | 0 | 0 | 0    持平 |
| journal_mode | wal | wal | — |

**接口耗时（ms）**

| 接口 | 优化前 | 优化后 | 变化（差值 / 百分比） |
| --- | --- | --- | --- |
| api__api_games_1_media_ms | 2.5 | 1.5 | -1.0  -40.0%  ✅ 缩小 |
| api__api_games_1_media_reviews_page_1_ms | 4.1 | 2.4 | -1.7  -41.5%  ✅ 缩小 |
| api__api_games_1_ms | 3.2 | 1.6 | -1.6  -50.0%  ✅ 缩小 |
| api__api_games_1_neighbors_ms | 1.9 | 1.7 | -0.2  -10.5%  ✅ 缩小 |
| api__api_games_limit_60_ms | 13.9 | 9.6 | -4.3  -30.9%  ✅ 缩小 |
| api__api_games_stats_ms | 3.1 | 3.0 | -0.1  -3.2%  ✅ 缩小 |
| api__api_health_ms | 4.1 | 1.7 | -2.4  -58.5%  ✅ 缩小 |
| api__api_library_status_ms | 3.2 | 1.8 | -1.4  -43.8%  ✅ 缩小 |
| api__api_media_1_cover_ms | 1.7 | 1.4 | -0.3  -17.6%  ✅ 缩小 |
| api__api_media_1_preview_ms | 1.3 | 1.3 | 0.0    持平 |
| api__api_media_1_thumbnail_ms | 2.7 | 1.5 | -1.2  -44.4%  ✅ 缩小 |
| api__api_settings_ms | 3.7 | 1.5 | -2.2  -59.5%  ✅ 缩小 |

> 接口键名沿用采集端的写法（`perf-baseline.sh` 把 URL 里所有非字母数字字符换成 `_`，再包上 `api_` 前缀与 `_ms` 后缀），
> 所以 `api__api_games_limit_60_ms` 就是 `GET /api/games?limit=60`；只有出现在优化前基线里的接口才列出。
>
> 附录里的 `cache_size` / `mmap_size` / `synchronous` / `temp_store` 是**探针那条只读连接自己**的 per-connection
> 取值（SQLite 不把它们写进库文件），不代表应用进程的设置；`journal_mode` / `user_version` / `page_size` /
> `auto_vacuum` 是库文件里的持久属性，看到的就是真实值。
