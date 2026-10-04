// ScreenPlay — API 模型类。
// 字段与 `/docs/API.md` 中「Model shapes」逐项对应；fromJson 对所有可能为 null 的
// 字段做防御式解析。日期统一解析为 UTC DateTime?，原始 null 保持 null。

/// ISO-8601 UTC 字符串 → DateTime?（解析失败返回 null，避免单项污染整个模型）。
DateTime? _parseUtc(dynamic value) {
  if (value == null) return null;
  if (value is DateTime) return value.toUtc();
  return DateTime.tryParse(value.toString())?.toUtc();
}

/// 安全读取 int?（服务端数字可能以 int/double/字符串形式返回）。
int? _asInt(dynamic value) {
  if (value == null) return null;
  if (value is num) return value.toInt();
  return int.tryParse(value.toString());
}

/// 安全读取 double?。
double? _asDouble(dynamic value) {
  if (value == null) return null;
  if (value is num) return value.toDouble();
  return double.tryParse(value.toString());
}

/// 安全读取 String?（非字符串也转为字符串，不抛异常）。
String? _asString(dynamic value) => value?.toString();

/// 多键名取值 —— 同一实体在不同端点上键名不一致时使用。
///
/// 实例：详情响应内嵌的 `achievements[]` 用 snake_case（`game_id`、`icon_url`、
/// `global_percent`），而 `GET /api/achievements/:id` 用 camelCase（`gameId`…）。
/// 只认一种写法会让另一种直接把整页打挂（`type 'Null' is not a subtype of type 'String'`）。
String? _asStringAny(Map<String, dynamic> json, List<String> keys) {
  for (final String key in keys) {
    final String? value = _asString(json[key]);
    if (value != null && value.isNotEmpty) return value;
  }
  return null;
}

/// 多键名取 double?（见 `_asStringAny`）。
double? _asDoubleAny(Map<String, dynamic> json, List<String> keys) {
  for (final String key in keys) {
    final double? value = _asDouble(json[key]);
    if (value != null) return value;
  }
  return null;
}

/// 安全读取 List<String>（容忍 null → 空列表）。
List<String> _asStringList(dynamic value) {
  if (value is! List) return const [];
  return value.map((dynamic e) => e.toString()).toList(growable: false);
}

/// 媒体类型：`image` / `video` / `gif`。
enum MediaType {
  image,
  video,
  gif;

  /// 由 API 字符串解析，未知值回退为 image。
  static MediaType fromString(String? raw) {
    switch (raw) {
      case 'video':
        return MediaType.video;
      case 'gif':
        return MediaType.gif;
      case 'image':
      default:
        return MediaType.image;
    }
  }

  /// 是否可视为「动图/视频」一类的动态内容（用于网格播放角标）。
  bool get isMotion => this == MediaType.video || this == MediaType.gif;
}

/// 时间线事件类型。
enum TimelineEventType {
  firstMedia,
  lastMedia,
  milestone,
  note;

  static TimelineEventType fromString(String? raw) {
    switch (raw) {
      case 'first_media':
        return TimelineEventType.firstMedia;
      case 'last_media':
        return TimelineEventType.lastMedia;
      case 'milestone':
        return TimelineEventType.milestone;
      case 'note':
      default:
        return TimelineEventType.note;
    }
  }
}

/// `GameSummary` —— 游戏列表项（不含重型字段）。
class GameSummary {
  const GameSummary({
    required this.id,
    required this.name,
    required this.platform,
    required this.posterUrl,
    required this.mediaCount,
    required this.durationSeconds,
    required this.durationText,
    required this.metacriticScore,
    required this.firstPlayedAt,
    required this.lastPlayedAt,
    this.posters = const <String>[],
    this.posterMode = 'static',
  });

  factory GameSummary.fromJson(Map<String, dynamic> json) {
    return GameSummary(
      // 不再 `as String` 硬转：列表里只要有一行缺 id/name（脏数据、老后端字段名
      // 不同），硬转就会抛 `type 'Null' is not a subtype of type 'String'`，
      // 整页列表 / 详情直接白屏。缺字段的卡片顶多打不开，好过整页失败。
      id: _asString(json['id']) ?? '',
      name: _asString(json['name']) ?? '',
      platform: _asString(json['platform']),
      posterUrl: _asString(json['posterUrl']),
      posters: _asStringList(json['posters']),
      posterMode: _asString(json['posterMode']) ?? 'static',
      mediaCount: _asInt(json['mediaCount']) ?? 0,
      durationSeconds: _asInt(json['durationSeconds']) ?? 0,
      durationText: _asString(json['durationText']) ?? '',
      metacriticScore: _asInt(json['metacriticScore']),
      firstPlayedAt: _parseUtc(json['firstPlayedAt']),
      lastPlayedAt: _parseUtc(json['lastPlayedAt']),
    );
  }

  final String id;
  final String name;
  final String? platform;
  final String? posterUrl;

  /// 首页卡片轮播集合（后端 `cardPosters()`：勾选 ∪ 当前封面，封面优先）。
  /// 与 Web `GameCard` 消费的 `game.posters` 是同一份数据、同一顺序。
  final List<String> posters;

  /// 卡片轮播开关（后端 `poster_mode`：`slideshow` = 开启 / `static` = 关闭）。
  ///
  /// 与 Web `GameCard` 消费的 `game.posterMode` 同源（web/src/components/GameCard.tsx:162
  /// `mode={game.posterMode ?? "static"}`）——Linux/Web 端改开关，移动端下次取列表即
  /// 同步生效，卡片的表现（是否自动轮播 + 是否可翻页）随之切换。
  final String posterMode;

  /// 是否开启自动轮播：Web 端判定 `game.posterMode === "slideshow"`。
  bool get slideshowEnabled => posterMode == 'slideshow';

  final int mediaCount;
  final int durationSeconds;
  final String durationText;
  final int? metacriticScore;
  final DateTime? firstPlayedAt;
  final DateTime? lastPlayedAt;
}

/// `GameDetail` —— 完整详情，extends GameSummary。
class GameDetail extends GameSummary {
  const GameDetail({
    required super.id,
    required super.name,
    required super.platform,
    required super.posterUrl,
    required super.mediaCount,
    required super.durationSeconds,
    required super.durationText,
    required super.metacriticScore,
    required super.firstPlayedAt,
    required super.lastPlayedAt,
    super.posters,
    super.posterMode,
    required this.folderName,
    required this.folderPath,
    required this.aliases,
    required this.summary,
    required this.developers,
    required this.publishers,
    required this.releaseDate,
    required this.voiceActors,
    required this.screenshots,
    required this.youTubeTrailers,
    required this.mainStoryHours,
    required this.mainPlusExtraHours,
    required this.completionistHours,
    required this.ratings,
    required this.prices,
    required this.achievements,
    required this.timeline,
    required this.cachedAt,
    required this.lastMetadataRefresh,
  });

  factory GameDetail.fromJson(Map<String, dynamic> json) {
    // 复用 GameSummary 解析，避免基类字段重复解析。
    final GameSummary base = GameSummary.fromJson(json);
    return GameDetail(
      id: base.id,
      name: base.name,
      platform: base.platform,
      posterUrl: base.posterUrl,
      mediaCount: base.mediaCount,
      durationSeconds: base.durationSeconds,
      durationText: base.durationText,
      metacriticScore: base.metacriticScore,
      firstPlayedAt: base.firstPlayedAt,
      lastPlayedAt: base.lastPlayedAt,
      posters: base.posters,
      posterMode: base.posterMode,
      folderName: json['folderName'] as String? ?? '',
      folderPath: json['folderPath'] as String? ?? '',
      aliases: _asStringList(json['aliases']),
      summary: _asString(json['summary']),
      developers: _asStringList(json['developers']),
      publishers: _asStringList(json['publishers']),
      releaseDate: _asString(json['releaseDate']),
      voiceActors: _asStringList(json['voiceActors']),
      screenshots: _asStringList(json['screenshots']),
      youTubeTrailers: _asStringList(json['youTubeTrailers']),
      mainStoryHours: _asDouble(json['mainStoryHours']),
      mainPlusExtraHours: _asDouble(json['mainPlusExtraHours']),
      completionistHours: _asDouble(json['completionistHours']),
      ratings: _parseList(json['ratings'], Rating.fromJson),
      prices: _parseList(json['prices'], Price.fromJson),
      achievements: _parseList(json['achievements'], Achievement.fromJson),
      timeline: _parseList(json['timeline'], TimelineEvent.fromJson),
      cachedAt: _parseUtc(json['cachedAt']),
      lastMetadataRefresh: _parseUtc(json['lastMetadataRefresh']),
    );
  }

  final String folderName;
  final String folderPath;
  final List<String> aliases;
  final String? summary;
  final List<String> developers;
  final List<String> publishers;
  final String? releaseDate;
  final List<String> voiceActors;
  final List<String> screenshots;
  final List<String> youTubeTrailers;
  final double? mainStoryHours;
  final double? mainPlusExtraHours;
  final double? completionistHours;
  final List<Rating> ratings;
  final List<Price> prices;
  final List<Achievement> achievements;
  final List<TimelineEvent> timeline;
  final DateTime? cachedAt;
  final DateTime? lastMetadataRefresh;
}

/// 通用的「对象数组」解析辅助。
///
/// 逐项容错：单条记录字段畸形时**跳过该条**，而不是让整个模型解析失败。
/// （2026-10 事故：详情响应内嵌的 `achievements[]` 是 snake_case，
/// `Achievement.fromJson` 抛 `type 'Null' is not a subtype of type 'String'`，
/// 导致 `gameDetailProvider` 每个游戏都报错、详情页显示「加载详情失败」。）
List<T> _parseList<T>(
  dynamic value,
  T Function(Map<String, dynamic>) fromJson,
) {
  if (value is! List) return const [];
  final List<T> parsed = <T>[];
  for (final dynamic item in value) {
    if (item is! Map) continue;
    try {
      parsed.add(fromJson(Map<String, dynamic>.from(item)));
    } catch (_) {
      continue; // 坏数据只丢这一条，不污染整页。
    }
  }
  return List<T>.unmodifiable(parsed);
}

/// `Media` —— 单个媒体文件。
class Media {
  const Media({
    required this.id,
    required this.gameId,
    required this.fileName,
    required this.type,
    required this.mimeType,
    required this.width,
    required this.height,
    required this.sizeBytes,
    required this.createdAt,
    required this.durationSeconds,
    required this.streamUrl,
    required this.thumbnailUrl,
    required this.coverUrl,
    this.previewUrl,
  });

  factory Media.fromJson(Map<String, dynamic> json) {
    return Media(
      id: json['id'] as String,
      gameId: json['gameId'] as String,
      fileName: json['fileName'] as String? ?? '',
      type: MediaType.fromString(_asString(json['type'])),
      mimeType: json['mimeType'] as String? ?? '',
      width: _asInt(json['width']),
      height: _asInt(json['height']),
      sizeBytes: _asInt(json['sizeBytes']) ?? 0,
      createdAt: _parseUtc(json['createdAt']) ?? DateTime.fromMillisecondsSinceEpoch(0),
      durationSeconds: _asInt(json['durationSeconds']),
      streamUrl: json['streamUrl'] as String? ?? '',
      thumbnailUrl: json['thumbnailUrl'] as String? ?? '',
      coverUrl: _asString(json['coverUrl']),
      previewUrl: _asString(json['previewUrl']),
    );
  }

  final String id;
  final String gameId;
  final String fileName;
  final MediaType type;
  final String mimeType;
  final int? width;
  final int? height;
  final int sizeBytes;
  final DateTime createdAt;
  final int? durationSeconds;
  final String streamUrl;
  final String thumbnailUrl;
  final String? coverUrl;

  /// 预览图地址（后端媒体 DTO 的 `previewUrl`，形如 `/api/media/:id/preview`）。
  /// 移动数据下取图清晰度降级时会优先用它（见 core/network_quality.dart）。
  final String? previewUrl;

  /// 派生缩略图地址（`/api/media/:id/thumbnail`），由 ApiClient 负责拼接绝对前缀。
  String get thumbnailPath => '/api/media/$id/thumbnail';

  /// 派生预览图地址（`/api/media/:id/preview`）。
  String get previewPath => '/api/media/$id/preview';

  /// 派生原图地址（`/api/media/:id/original`），由 ApiClient 负责拼接绝对前缀。
  String get originalPath => '/api/media/$id/original';

  /// 视频流地址（后端 DTO 中已是可直接播放的地址，这里只做别名，便于统一取用）。
  String get streamPath => streamUrl;
}

/// `Achievement` —— 成就。
class Achievement {
  const Achievement({
    required this.id,
    required this.gameId,
    required this.name,
    required this.description,
    required this.iconUrl,
    required this.globalPercent,
  });

  factory Achievement.fromJson(Map<String, dynamic> json) {
    return Achievement(
      id: _asStringAny(json, <String>['id', 'external_id']) ?? '',
      // 详情端点内嵌数组是 snake_case（`game_id`），
      // 独立端点 `GET /api/achievements/:id` 是 camelCase（`gameId`）——两种都认。
      gameId: _asStringAny(json, <String>['gameId', 'game_id']) ?? '',
      name: _asStringAny(json, <String>['name']) ?? '',
      description: _asString(json['description']),
      iconUrl: _asStringAny(json, <String>['iconUrl', 'icon_url']),
      globalPercent:
          _asDoubleAny(json, <String>['globalPercent', 'global_percent']),
    );
  }

  final String id;
  final String gameId;
  final String name;
  final String? description;
  final String? iconUrl;
  final double? globalPercent;
}

/// `Rating` —— Metacritic 评分。
class Rating {
  const Rating({
    required this.source,
    required this.metascore,
    required this.criticCount,
    required this.userScore,
    required this.userCount,
    required this.ratingClass,
  });

  factory Rating.fromJson(Map<String, dynamic> json) {
    return Rating(
      source: json['source'] as String? ?? 'metacritic',
      metascore: _asInt(json['metascore']),
      criticCount: _asInt(json['criticCount']),
      userScore: _asDouble(json['userScore']),
      userCount: _asInt(json['userCount']),
      ratingClass: _asString(json['ratingClass']),
    );
  }

  final String source;
  final int? metascore;
  final int? criticCount;
  final double? userScore;
  final int? userCount;
  final String? ratingClass;
}

/// `Price` —— Steam 价格。
class Price {
  const Price({
    required this.source,
    required this.currency,
    required this.currentPrice,
    required this.initialPrice,
    required this.discountPercent,
    required this.historicalLow,
    required this.lastUpdated,
  });

  factory Price.fromJson(Map<String, dynamic> json) {
    return Price(
      source: json['source'] as String? ?? 'steam',
      currency: _asString(json['currency']),
      currentPrice: _asDouble(json['currentPrice']),
      initialPrice: _asDouble(json['initialPrice']),
      discountPercent: _asDouble(json['discountPercent']),
      historicalLow: _asDouble(json['historicalLow']),
      lastUpdated: _asString(json['lastUpdated']),
    );
  }

  final String source;
  final String? currency;
  final double? currentPrice;
  final double? initialPrice;
  final double? discountPercent;
  final double? historicalLow;
  final String? lastUpdated;
}

/// `TimelineEvent` —— 时间线事件。
class TimelineEvent {
  const TimelineEvent({
    required this.date,
    required this.type,
    required this.title,
    required this.description,
  });

  factory TimelineEvent.fromJson(Map<String, dynamic> json) {
    return TimelineEvent(
      date: _parseUtc(json['date']) ?? DateTime.fromMillisecondsSinceEpoch(0),
      type: TimelineEventType.fromString(_asString(json['type'])),
      title: json['title'] as String? ?? '',
      description: _asString(json['description']),
    );
  }

  final DateTime date;
  final TimelineEventType type;
  final String title;
  final String? description;
}

/// `Stats` —— 全局统计。
class Stats {
  const Stats({
    required this.totalGames,
    required this.totalMedia,
    required this.totalImages,
    required this.totalVideos,
    required this.totalSizeBytes,
    required this.totalPlayTimeSeconds,
    required this.platforms,
  });

  factory Stats.fromJson(Map<String, dynamic> json) {
    final Map<String, dynamic> rawPlatforms =
        json['platforms'] is Map ? Map<String, dynamic>.from(json['platforms'] as Map) : const {};
    return Stats(
      totalGames: _asInt(json['totalGames']) ?? 0,
      totalMedia: _asInt(json['totalMedia']) ?? 0,
      totalImages: _asInt(json['totalImages']) ?? 0,
      totalVideos: _asInt(json['totalVideos']) ?? 0,
      totalSizeBytes: _asInt(json['totalSizeBytes']) ?? 0,
      totalPlayTimeSeconds: _asInt(json['totalPlayTimeSeconds']) ?? 0,
      platforms: rawPlatforms.map((String key, dynamic value) => MapEntry(key, (value as num).toInt())),
    );
  }

  final int totalGames;
  final int totalMedia;
  final int totalImages;
  final int totalVideos;
  final int totalSizeBytes;
  final int totalPlayTimeSeconds;
  final Map<String, int> platforms;
}

/// `LibraryStatus` —— 扫描状态。
class LibraryStatus {
  const LibraryStatus({
    required this.scanning,
    required this.lastScanAt,
    required this.totalGames,
    required this.totalMedia,
  });

  factory LibraryStatus.fromJson(Map<String, dynamic> json) {
    return LibraryStatus(
      scanning: json['scanning'] as bool? ?? false,
      lastScanAt: _parseUtc(json['lastScanAt']),
      totalGames: _asInt(json['totalGames']) ?? 0,
      totalMedia: _asInt(json['totalMedia']) ?? 0,
    );
  }

  final bool scanning;
  final DateTime? lastScanAt;
  final int totalGames;
  final int totalMedia;
}

/// `Poster` —— 海报（`GET /api/games/:id/posters` 的列表项）。
/// 字段与后端 posters.service.ts 的 DTO 同名映射。
class Poster {
  const Poster({
    required this.id,
    required this.gameId,
    required this.url,
    required this.thumbUrl,
    required this.source,
    required this.mediaId,
    required this.isSelected,
    required this.isCover,
    required this.inSlideshow,
    required this.sortOrder,
    required this.createdAt,
  });

  factory Poster.fromJson(Map<String, dynamic> json) {
    return Poster(
      // 与 GameSummary / Achievement 同样的原则：不做 `as String` 硬转，
      // 一行脏数据不该让整个海报列表（乃至设置页）崩掉。
      id: _asString(json['id']) ?? '',
      gameId: _asString(json['gameId']) ?? '',
      url: _asString(json['url']) ?? '',
      thumbUrl: _asString(json['thumbUrl']),
      source: _asString(json['source']) ?? 'upload',
      mediaId: _asString(json['mediaId']),
      isSelected: json['isSelected'] as bool? ?? false,
      isCover: json['isCover'] as bool? ?? false,
      inSlideshow: json['inSlideshow'] as bool? ?? false,
      sortOrder: _asInt(json['sortOrder']) ?? 0,
      createdAt: _parseUtc(json['createdAt']),
    );
  }

  final String id;
  final String gameId;

  /// 原图地址（由 ApiClient.resolve 拼绝对前缀）。
  final String url;

  /// 缩略图地址；可能为空（此时回退用 [url]）。
  final String? thumbUrl;

  /// 来源：`upload` / `media` / ...
  final String source;

  /// 来自媒体时对应的 mediaId。
  final String? mediaId;

  final bool isSelected;
  final bool isCover;
  final bool inSlideshow;
  final int sortOrder;
  final DateTime? createdAt;
}

/// 游戏列表过滤条件 —— 作为 `gamesProvider.family` 的参数，需实现相等语义。
class GameFilter {
  const GameFilter({
    this.search = '',
    this.platform,
    this.sort = 'name',
    this.order = 'asc',
  });

  final String search;
  final String? platform;
  final String sort;
  final String order;

  @override
  bool operator ==(Object other) {
    return other is GameFilter &&
        other.search == search &&
        other.platform == platform &&
        other.sort == sort &&
        other.order == order;
  }

  @override
  int get hashCode => Object.hash(search, platform, sort, order);

  /// 生成后端接受的查询参数（空值不携带）。
  Map<String, dynamic> toQuery() {
    final Map<String, dynamic> query = <String, dynamic>{
      'sort': sort,
      'order': order,
    };
    if (search.isNotEmpty) query['search'] = search;
    if (platform != null && platform!.isNotEmpty) query['platform'] = platform;
    return query;
  }
}