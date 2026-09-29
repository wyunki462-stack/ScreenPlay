/** Game detail page: header metadata, tabs, timeline, achievements, ratings. */
export const detailZh: Record<string, string> = {
  "detail.backToGallery": "返回图库",
  "detail.loadFailed": "加载游戏详情失败",
  "detail.mediaFailed": "加载媒体失败",
  "detail.editPoster": "编辑海报",
  "detail.platformSettings": "平台设置",
  "detail.matchManually": "手动匹配",
  "detail.refreshMetadata": "刷新元数据",
  "detail.refreshing": "刷新中…",
  "detail.refreshFailed": "刷新失败，请稍后重试",

  "detail.platform.manual": "手动设置的平台",
  "detail.platform.auto": "自动识别的平台",

  "detail.tab.media": "媒体",
  "detail.tab.timeline": "时间线",
  "detail.tab.achievements": "成就",
  "detail.tab.ratings": "媒体评价",

  "detail.developer": "开发商",
  "detail.publisher": "发行商",
  "detail.releaseDate": "发售日期",
  "detail.playtime": "平均通关时长",
  "detail.price": "价格",

  /** Joins a list of names / prices (the Chinese enumeration comma). */
  "detail.listSeparator": "、",
  "detail.priceSeparator": " ； ",

  "detail.playtime.mainStory": "主线 {hours} 小时",
  "detail.playtime.mainPlusExtra": "主线+支线 {hours} 小时",
  "detail.playtime.completionist": "完美通关 {hours} 小时",

  "detail.price.was": "原价 {price}",
  "detail.price.low": "史低 {price}",

  "detail.timeline.firstMedia": "首次媒体",
  "detail.timeline.lastMedia": "最后媒体",
  "detail.timeline.milestone": "里程碑",
  "detail.timeline.note": "备注",
  "detail.timeline.empty": "暂无时间线记录",

  "detail.achievements.empty":
    "暂无可展示的成就数据，请尝试手动选择游戏或稍后重试",
  "detail.achievements.summary": "全部成就 / 奖杯 · 共 {n} 个（含未达成，非个人已解锁）",
  "detail.achievements.globalPercent": "全球达成率 {percent}%",
  "detail.achievements.failed": "加载成就失败",
  // Unified failure copy: never name the underlying site, and always point at
  // 「手动选择游戏」, which is the real fix when auto-matching picked wrong.
  "detail.achievements.failedHint": "当前游戏成就数据暂不可用，请尝试手动选择游戏或稍后重试",

  "detail.achievements.tierPlatinum": "白金",
  "detail.achievements.tierGold": "金",
  "detail.achievements.tierSilver": "银",
  "detail.achievements.tierBronze": "铜",
  "detail.achievements.totalLabel": "共 {n} 个",
  "detail.achievements.rarityLabel": "稀有度",
  "detail.achievements.baseGame": "本体",
  "detail.achievements.dlcLabel": "DLC · {name}",
  "detail.achievements.refresh": "重新抓取成就 / 奖杯",
  "detail.achievements.refreshing": "抓取中…（最长约 30 秒）",
  "detail.achievements.refreshFailed": "重新抓取失败，请稍后重试",
  "detail.achievements.refreshed": "抓取完成，数据已更新",

  "detail.achievements.pick.open": "手动选择游戏",
  "detail.achievements.pick.title": "为「{name}」选择成就目标",
  "detail.achievements.pick.intro":
    "自动匹配依据文件夹名推断，缩写、多版本或重名时容易选错。在这里指定后，后续全量刮削与刷新都会沿用该选择。",
  "detail.achievements.pick.placeholder": "输入游戏名称搜索",
  "detail.achievements.pick.searching": "搜索中…",
  "detail.achievements.pick.noResults": "没有找到匹配的游戏条目，换个关键词试试",
  "detail.achievements.pick.emptyQuery": "输入关键词开始搜索",
  "detail.achievements.pick.current": "当前手动选择：{name}",
  "detail.achievements.pick.confirm": "确认并重新抓取",
  "detail.achievements.pick.applying": "抓取中…（最长约 30 秒）",
  "detail.achievements.pick.done": "已应用，成就数据已更新",
  "detail.achievements.pick.failedMsg": "应用失败，请稍后重试",
  "detail.achievements.pick.clear": "恢复自动匹配",
  "detail.achievements.pick.cleared": "已恢复自动匹配",
  "detail.achievements.unsupported":
    "当前游戏暂无匹配到的成就数据源，请尝试手动选择游戏",

  "detail.ratings.empty": "暂无评分数据",
  "detail.ratings.metascore": "Metascore",
  "detail.ratings.userScore": "用户评分",
  "detail.ratings.criticCount": "{count} 个评论",
  "detail.ratings.userCount": "{count} 个评分",

  // 「媒体评价」标签页（媒体名称 / 媒体打分 / 媒体评价原文）
  "detail.reviews.title": "媒体评价",
  "detail.reviews.empty": "暂无媒体评价",
  // 空状态要区分「没抓过」「抓过但没有」「抓取失败」，否则用户无法判断该不该重试
  "detail.reviews.neverFetched": "还没有抓取过媒体评价，点「补全媒体评价」获取。",
  "detail.reviews.noneFound": "该游戏的媒体评价数据源没有收录评价内容。",
  "detail.reviews.failed": "媒体评价抓取失败：{reason}",
  "detail.reviews.failedHint": "常见原因：数据源站点不可达（需要代理）或被限流。稍后重试即可，已抓到的评价不会被清空。",
  "detail.reviews.unsupported": "未找到该游戏在媒体评价站的对应条目。",
  "detail.reviews.refresh": "重新抓取媒体评价",
  "detail.reviews.refreshing": "抓取中…",
  "detail.reviews.refreshed": "已更新：共 {count} 条媒体评价",
  "detail.reviews.refreshFailed": "抓取失败：{reason}",
  "detail.reviews.count": "共 {count} 条媒体评价",
  "detail.reviews.outlet": "媒体",
  "detail.reviews.score": "打分",
  "detail.reviews.noScore": "未打分",
  "detail.reviews.readOriginal": "查看原文",
  "detail.reviews.source": "数据来源",
  "detail.reviews.fetchedAt": "抓取于 {time}",
  "detail.reviews.platform": "对应平台",
  "detail.reviews.author": "作者",

  "detail.metacritic.withCritics": "Metacritic {score} · 基于 {criticCount} 家媒体",
  "detail.metacritic.score": "Metacritic {score}",
  "detail.metacritic.empty": "暂无 Metacritic 评分",

  // 「手动选择评分」（M站评分按平台手动指定）
  "detail.rating.pick.open": "手动选择评分",
  "detail.rating.pick.title": "为「{name}」选择 M站 评分",
  "detail.rating.pick.intro":
    "同一款游戏在不同平台的 Metacritic 条目与评分不同。选择与实际游玩平台相符的条目后，游戏卡片与详情页会同步显示该分数，且不会被后续刮削重置。",
  "detail.rating.pick.placeholder": "输入游戏名称搜索",
  "detail.rating.pick.searching": "搜索中…",
  "detail.rating.pick.noResults": "没有找到带评分的条目，换个关键词试试",
  "detail.rating.pick.current": "当前手动选择：{platform} · {score} 分",
  "detail.rating.pick.currentAuto": "当前为自动匹配：{score} 分",
  "detail.rating.pick.noScore": "当前没有可用的 M站 评分",
  "detail.rating.pick.inUse": "使用中",
  "detail.rating.pick.metascore": "Metascore 媒体均分",
  "detail.rating.pick.unknownPlatform": "未知平台",
  "detail.rating.pick.confirm": "使用该评分",
  "detail.rating.pick.applying": "保存中…",
  "detail.rating.pick.done": "已使用 {platform} 的 {score} 分，卡片与详情页已同步",
  "detail.rating.pick.failedMsg": "保存失败，请稍后重试",
  "detail.rating.pick.clear": "恢复自动匹配",
  "detail.rating.pick.cleared": "已恢复自动匹配，评分将跟随系统刮削结果",
  "detail.rating.pick.manualBadge": "手动选择",

  // 上一个 / 下一个游戏
  "detail.nav.prev": "上一个",
  "detail.nav.next": "下一个",
  "detail.nav.prevTitle": "上一个游戏：{name}",
  "detail.nav.nextTitle": "下一个游戏：{name}",
  "detail.nav.position": "第 {index} / {total} 个（按当前排序）",
  "detail.nav.loading": "正在读取相邻游戏…",

  // 详情页官方海报轮播（大图区）
  "detail.poster.prev": "上一张海报",
  "detail.poster.next": "下一张海报",
  "detail.poster.goto": "查看第 {index} 张海报",
  "detail.poster.official": "官方海报 / 截图",
  "detail.poster.alt": "官方海报",
  "detail.poster.empty": "暂无海报，点「编辑海报」添加",
};