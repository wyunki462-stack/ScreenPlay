/** Media grid, tile rendering, lightbox, video player and tabs. */
export const mediaZh: Record<string, string> = {
  // Media grid — toolbar and sort control.
  "media.sort.label": "排序",
  "media.sort.default": "默认顺序",
  "media.sort.time": "按时间（新→旧）",
  "media.sort.name": "按名称（A→Z）",
  "media.sort.size": "按大小（大→小）",
  "media.count": "{n} 个媒体",
  "media.empty": "暂无媒体文件，点击右上角「刷新元数据」或返回图库「重新扫描」",
  // 相册空态：这个文件夹里确实一张图都没有。与上面那条「可恢复」的提示区分开，
  // 这条是终结答案，不该再劝用户去刷新元数据。
  "media.emptyFolder": "暂无图片",
  // 图库卡片上的空文件夹角标（「暂无图片」四个字放不进角标，用短标）。
  "media.emptyBadge": "空",

  // Media grid — tile badges and lightbox toolbar.
  "media.badge.video": "视频",
  "media.badge.gif": "GIF",
  "media.previous": "上一张",
  "media.next": "下一张",
  "media.zoomIn": "放大",
  "media.zoomOut": "缩小",
  "media.viewOriginal": "查看原图",

  // Video player.
  "media.playTitle": "播放 {name}",

  // Lazy image error fallback.
  "media.imageLoadFailed": "图片加载失败",

  // Tabs.
  "media.tabs.label": "分区",
};