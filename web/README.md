# ScreenPlay Web

Web frontend（React 18 + TypeScript + Vite）for ScreenPlay — 个人游戏媒体图库管理器。
消费后端 `/api` 下所有 JSON 端点，以及 `/api/media/:id/stream|thumbnail|cover|original` 媒体流。

## 技术栈

- React 18 + TypeScript（strict）
- Vite 5（开发代理 `/api` → 后端）
- Tailwind CSS 3（深色游戏图库风格，zinc + violet/cyan 强调色）
- React Router v6（`/` 图库网格、`/game/:id` 详情）
- TanStack Query v5（数据请求/缓存/失效）
- `plyr` + `plyr-react`（视频播放）、`react-photo-view`（图片灯箱）、`lucide-react`（图标）

## 开发 / 构建

```bash
# 安装依赖（在仓库根目录使用 pnpm/npm workspace，或进入 web/ 单独安装）
npm install

# 启动开发服务器（默认 http://localhost:5173，/api 代理到 http://localhost:3000）
npm run dev

# 指定后端地址
VITE_API_BASE=http://<后端主机IP>:3000 npm run dev

# 类型检查 + 生产构建
npm run build

# 本地预览构建产物
npm run preview
```

> 依赖后端已在本机 `http://localhost:3000` 启动。`VITE_API_BASE` 仅覆盖 Vite
> 开发代理的 target；前端请求始终使用相对路径 `/api`。

## 目录结构

```
web/
├── index.html
├── vite.config.ts          # React 插件 + /api 开发代理
├── tailwind.config.ts
├── postcss.config.js
└── src/
    ├── main.tsx            # QueryClientProvider + Router 挂载
    ├── App.tsx             # 顶部导航 + 路由
    ├── index.css           # Tailwind + 深色全局样式 + skeleton shimmer
    ├── types.ts            # 与 docs/API.md 一致的模型类型
    ├── api/
    │   ├── client.ts       # 类型化 fetch 封装（base /api，错误处理）
    │   └── hooks.ts        # TanStack Query hooks + mutations
    ├── lib/
    │   ├── utils.ts        # cn() / metacritic 配色 / 渐变占位
    │   └── format.ts       # formatDuration / formatBytes / formatDate
    ├── components/
    │   ├── ui/             # Button/Input/Badge/Card/Tabs/Skeleton/Select
    │   ├── GameCard.tsx
    │   ├── PosterImage.tsx
    │   ├── MetacriticBadge.tsx
    │   ├── ScreenshotCarousel.tsx
    │   ├── MediaGrid.tsx   # 图片/视频网格 + PhotoSlider 灯箱
    │   └── VideoPlayer.tsx # Plyr 全屏视频弹窗
    └── pages/
        ├── Home.tsx        # 统计栏 + 过滤 + 网格 + 重新扫描
        └── GameDetail.tsx  # 详情 + 轮播 + 信息 + 标签页
```

## 关于 API 的假设

- `PATCH /api/games/:id` 假定返回更新后的 `GameDetail`（前端当前未消费该响应用于界面）。
- `GET /api/library/status` 的 `lastScanAt` 类型为 `string | null`（首次扫描前可能为空）。
- 媒体对象返回的 `streamUrl` / `thumbnailUrl` / `coverUrl` 均为相对 `/api/...` 路径，前端直接使用。
- `gif` 类型媒体在网格与灯箱中直接使用 `streamUrl`（原始字节，保证原生动画），`image` 类型网格使用
  `thumbnailUrl`（缓存缩略图）、灯箱使用 `streamUrl`（原图清晰度）。
- 「查看原图」动作按需求打开 `/api/media/:id/original`（新标签页）。
- 成就标签页使用独立的 `GET /api/achievements/:gameId`（实况数据），而不是详情里内嵌的
  `game.achievements` 快照。
- Metacritic 配色阈值：绿 ≥75、黄 ≥50、红 <50（无评分为灰）。
- 时间线类型中文映射：`first_media` = 首次媒体、`last_media` = 最后媒体、`milestone` = 里程碑、
  `note` = 备注。