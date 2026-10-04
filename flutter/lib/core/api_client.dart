// API 客户端：封装 Dio，统一错误处理，并把后端返回的相对媒体地址拼成绝对 URL。

import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/models.dart';
import 'server_config.dart';

/// 统一的 API 异常，携带后端错误信息中的 `message` 与 HTTP 状态码。
class ApiException implements Exception {
  const ApiException(this.message, {this.statusCode});

  final String message;
  final int? statusCode;

  @override
  String toString() => 'ApiException($statusCode): $message';
}

/// 后端会话信息（`GET /api/auth/session`）。
class SessionInfo {
  const SessionInfo({
    required this.enabled,
    required this.mode,
    required this.authenticated,
    required this.username,
  });

  /// 后端是否启用了鉴权。
  final bool enabled;

  /// 鉴权模式：`system` | `local`。
  final String mode;

  /// 本次请求是否已通过鉴权。
  final bool authenticated;

  /// 已登录用户名（未登录为 null）。
  final String? username;
}

/// `DELETE /api/media/:id` 的返回体。
class DeleteMediaResult {
  const DeleteMediaResult({
    required this.ok,
    required this.id,
    required this.removedFiles,
    required this.postersRemoved,
    required this.originalSkipped,
  });

  final bool ok;
  final String id;

  /// 服务器上删除的文件数。
  final int removedFiles;

  /// 顺带清理的悬空海报引用数。
  final int postersRemoved;

  /// 原文件是否被跳过（例如文件已不在磁盘）。
  final bool originalSkipped;
}

/// 媒体变体（用于 [ApiClient.mediaUrl] 拼接地址）。
enum MediaVariant { thumbnail, preview, original, stream, cover }

/// 依赖 serverConfigProvider 的 ApiClient 提供者（地址变更时自动重建）。
final Provider<ApiClient> apiClientProvider = Provider<ApiClient>(
  (ProviderRef<ApiClient> ref) => ApiClient(baseUrl: ref.watch(serverConfigProvider)),
);

class ApiClient {
  /// baseUrl 传入前应已通过 normalizeBaseUrl 去尾斜杠。
  ///
  /// [authToken] 为会话凭证（后端 httpOnly cookie `screenplay_session` 的值）。
  /// 请求时同时发两种凭证（无副作用），因为：
  ///  - `Authorization: Bearer <token>` 走后端 auth.guard.ts:51-55 的 Bearer 分支；
  ///  - `Cookie: screenplay_session=<token>` 走 cookie 分支（Web/浏览器端习惯）。
  /// 之所以需要「双通道」：后端 login 响应体里没有 token 字段，只有 Set-Cookie，
  /// 且不同端（Linux/Web vs 安卓）可能落在不同校验分支，双发最稳。
  ApiClient({required String baseUrl, String? authToken})
      : _baseUrl = normalizeBaseUrl(baseUrl),
        _authToken = authToken,
        _dio = Dio(
          BaseOptions(
            baseUrl: normalizeBaseUrl(baseUrl),
            connectTimeout: const Duration(seconds: 10),
            receiveTimeout: const Duration(seconds: 60),
            headers: const <String, dynamic>{'Accept': 'application/json'},
          ),
        ) {
    _dio.interceptors.add(
      InterceptorsWrapper(
        onRequest: (RequestOptions options, RequestInterceptorHandler handler) {
          final String? token = _authToken;
          if (token != null && token.isNotEmpty) {
            options.headers['Authorization'] = 'Bearer $token';
            options.headers['Cookie'] = 'screenplay_session=$token';
          }
          handler.next(options);
        },
      ),
    );
    // 仅在调试模式打印请求/响应日志，减少正式包噪音。
    if (kDebugMode) {
      _dio.interceptors.add(
        LogInterceptor(requestBody: false, responseBody: false),
      );
    }
  }

  final String _baseUrl;
  final Dio _dio;
  String? _authToken;

  /// 暴露底层 Dio，供媒体工作流把非必要请求绑定到 [nonEssentialCancelToken]。
  Dio get dio => _dio;

  /// 当前会话凭证（null = 未登录 / 无 token 模式）。
  String? get authToken => _authToken;

  /// 设置/清除凭证（登录成功后设置，登出或会话失效时传 null）。
  /// 传空串等同于清除，避免空 token 也拼出一个无效 `Bearer ` 头。
  void setAuthToken(String? token) {
    _authToken = (token != null && token.isEmpty) ? null : token;
  }

  /// 「非必要」请求共用的取消令牌（图片预加载、列表预热等）。
  CancelToken _nonEssentialToken = CancelToken();

  /// 供 UI/服务层把非必要请求（图片预加载）绑定到同一令牌上。
  CancelToken get nonEssentialCancelToken => _nonEssentialToken;

  /// 取消全部「非必要」请求（进入后台 / 快速滚动时调用），并换一个新令牌
  /// 供后续请求继续使用（旧的已 cancelled，不能复用）。
  /// 注意：删除 / 排序 / 扫描等写操作【不】使用该令牌，不会被这次取消波及。
  Future<void> cancelNonEssential() async {
    if (!_nonEssentialToken.isCancelled) {
      _nonEssentialToken.cancel('非必要请求已取消（后台或快速滚动）');
    }
    _nonEssentialToken = CancelToken();
  }

  /// 图片请求头（与业务请求同一套双通道凭证）。
  ///
  /// 为什么需要单独暴露：`CachedNetworkImage` / `Image.network` 直接走 dart:io 的
  /// HTTP 客户端，**不经过上面 Dio 的拦截器**。Linux 后端默认 `AUTH_MODE=system`
  /// （鉴权开启）时，`/api/media/*`、`/api/media/proxy`、`/api/posters/*` 等图片端点
  /// 无凭证一律 401 —— 现象就是「连 Linux 后端后大部分海报不显示、只有彩色渐变占位」。
  /// （Windows 桌面端 `AUTH_DISABLED=1` 无凭证放行，所以只在 Linux 后端暴露出来。）
  Map<String, String> get imageHeaders {
    final String? token = _authToken;
    if (token == null || token.isEmpty) return const <String, String>{};
    return <String, String>{
      'Authorization': 'Bearer $token',
      'Cookie': 'screenplay_session=$token',
    };
  }

  /// 把相对/绝对地址归一为绝对 URL（相对地址一律以当前 baseUrl 为前缀）。
  String resolve(String pathOrUrl) {
    if (pathOrUrl.isEmpty) return pathOrUrl;
    if (pathOrUrl.startsWith('http://') || pathOrUrl.startsWith('https://')) {
      return pathOrUrl;
    }
    return '$_baseUrl${pathOrUrl.startsWith('/') ? pathOrUrl : '/$pathOrUrl'}';
  }

  /// 图片地址归一化 —— 与 Web 端走**同一条**取图路径。
  ///
  ///  - 相对地址（`/api/media/...`，列表 `posterUrl` / 后端已代理过的地址）
  ///    → 拼上 baseUrl，直连本服务端；
  ///  - 远端 CDN 绝对地址（`https://media.rawg.io/...`、`*.steamstatic.com` 等，
  ///    来自 `GET /api/games/:id/posters`、成就图标等）
  ///    → 改走后端 `/api/media/proxy?url=…`：后端带代理抓取 + 磁盘缓存
  ///    （见 backend/src/media/media.controller.ts 的 `proxy()` 与
  ///    common/http/remote-image.service.ts）。手机直连境外 CDN 在大陆网络下基本
  ///    不可用，这正是「部分海报显示、部分不显示、与 Web 数量不一致」的另一半原因。
  ///  - 已是本服务端地址 → 原样返回。
  String imageSource(String pathOrUrl) {
    if (pathOrUrl.isEmpty) return pathOrUrl;
    if (!pathOrUrl.startsWith('http://') && !pathOrUrl.startsWith('https://')) {
      return resolve(pathOrUrl);
    }
    if (pathOrUrl.startsWith(_baseUrl)) return pathOrUrl;
    return '$_baseUrl/api/media/proxy?url=${Uri.encodeComponent(pathOrUrl)}';
  }

  /// 媒体预览图地址 → 缩略图地址（`/api/media/:id/preview` → `/api/media/:id/thumbnail`）。
  ///
  /// 与 Web `web/src/components/GameCard.tsx` 的 `cardFrame()` 完全一致：卡片tile 只有
  /// ~300px 宽，`/preview` 是一张 2.5–9.8 MB 的 4K 图，`/thumbnail` 是磁盘缓存的
  /// ~6 KB WebP，观感相同而带宽差三个数量级。只改写媒体 rendition，上传海报
  /// （`/api/posters/:id/image`）与远端 CDN 图不动。
  static final RegExp _mediaPreview = RegExp(r'^/api/media/([^/]+)/preview$');

  String cardImageSource(String pathOrUrl) {
    final RegExpMatch? match = _mediaPreview.firstMatch(pathOrUrl);
    final String normalized =
        match == null ? pathOrUrl : '/api/media/${match.group(1)}/thumbnail';
    return imageSource(normalized);
  }

  /// 首页卡片的海报列表 —— 与 Web `cardPosters()` 逐条对齐：
  /// 封面（`game.posterUrl`）优先，其后是后端给出的轮播集合（`game.posters`，
  /// 判据 `in_slideshow = 1 OR is_selected = 1`），去重后全部走卡片封面档。
  ///
  /// 这样 App 卡片显示的张数、顺序、清晰度档位与 Web 端完全一致；返回长度 ≤ 1 时
  /// 卡片按单张图渲染（无轮播、无指示点），与 Web 的 `PosterCarousel` 同规则。
  List<String> cardPosterSources(GameSummary game) {
    final List<String> raw = <String>[
      if (game.posterUrl != null && game.posterUrl!.isNotEmpty) game.posterUrl!,
      ...game.posters,
    ];
    final List<String> out = <String>[];
    for (final String url in raw) {
      if (url.isEmpty) continue;
      final String source = cardImageSource(url);
      if (!out.contains(source)) out.add(source);
    }
    return out;
  }

  /// `/api/media/:id/original`（用于「查看原图」）。
  String mediaOriginalUrl(String mediaId) => '$_baseUrl/api/media/$mediaId/original';

  /// 统一错误转义与守护执行体。
  Future<T> _guard<T>(Future<T> Function() run) async {
    try {
      return await run();
    } on DioException catch (e) {
      throw _toApiException(e);
    }
  }

  /// 提取后端 `{statusCode, message, error}` 形错误体，回退到 Dio 自带描述。
  ApiException _toApiException(DioException e) {
    final dynamic data = e.response?.data;
    int? statusCode = e.response?.statusCode;
    String message = e.message ?? '网络请求失败';
    if (data is Map) {
      final dynamic raw = data['message'];
      if (raw is String && raw.isNotEmpty) message = raw;
    }
    return ApiException(message, statusCode: statusCode);
  }

  Future<Map<String, dynamic>> health() {
    return _guard(() async {
      final Response<dynamic> res = await _dio.get<dynamic>('/api/health');
      return Map<String, dynamic>.from(res.data as Map);
    });
  }

  Future<List<GameSummary>> games(GameFilter filter) {
    return _guard(() async {
      final Response<dynamic> res = await _dio.get<dynamic>(
        '/api/games',
        queryParameters: filter.toQuery(),
      );
      return _parseListResponse(res, GameSummary.fromJson);
    });
  }

  Future<GameDetail> game(String id) {
    return _guard(() async {
      final Response<dynamic> res = await _dio.get<dynamic>('/api/games/$id');
      return GameDetail.fromJson(Map<String, dynamic>.from(res.data as Map));
    });
  }

  Future<List<Media>> media(String gameId) {
    return _guard(() async {
      final Response<dynamic> res =
          await _dio.get<dynamic>('/api/games/$gameId/media');
      return _parseListResponse(res, Media.fromJson);
    });
  }

  Future<List<Achievement>> achievements(String gameId) {
    return _guard(() async {
      final Response<dynamic> res =
          await _dio.get<dynamic>('/api/achievements/$gameId');
      return _parseListResponse(res, Achievement.fromJson);
    });
  }

  Future<Stats> stats() {
    return _guard(() async {
      final Response<dynamic> res = await _dio.get<dynamic>('/api/stats');
      return Stats.fromJson(Map<String, dynamic>.from(res.data as Map));
    });
  }

  Future<LibraryStatus> libraryStatus() {
    return _guard(() async {
      final Response<dynamic> res = await _dio.get<dynamic>('/api/library/status');
      return LibraryStatus.fromJson(Map<String, dynamic>.from(res.data as Map));
    });
  }

  /// 触发一次重新扫描（异步执行，立即返回）。
  Future<void> scan() {
    return _guard(() async {
      await _dio.post<dynamic>('/api/library/scan');
    });
  }

  /// 强制刷新指定游戏的元数据（绕过缓存）。
  Future<void> refreshGame(String id, {List<String>? providers}) {
    return _guard(() async {
      await _dio.post<dynamic>(
        '/api/games/$id/refresh',
        data: providers == null ? null : <String, dynamic>{'providers': providers},
      );
    });
  }

  /// 会话状态（`GET /api/auth/session`）。
  Future<SessionInfo> session() {
    return _guard(() async {
      final Response<dynamic> res =
          await _dio.get<dynamic>('/api/auth/session');
      final Map<String, dynamic> map =
          Map<String, dynamic>.from(res.data as Map);
      final dynamic user = map['user'];
      String? username;
      if (user is Map) {
        username = _asStringOrNull(user['username']);
      } else if (user is String) {
        username = user;
      }
      return SessionInfo(
        enabled: map['enabled'] == true,
        mode: map['mode']?.toString() ?? 'local',
        authenticated: map['authenticated'] == true,
        username: username,
      );
    });
  }

  /// 登录（`POST /api/auth/login`）。
  ///
  /// 返回值 = **会话令牌**（拿到后由调用方保存并用于 [setAuthToken]）。
  /// 后端不返回 token 字段，只能从 `Set-Cookie: screenplay_session=<token>` 里取；
  /// 取不到时返回空串，调用方应回退成「无 token 模式」（仅 Windows 免登录端可行）。
  Future<String> login({
    required String username,
    required String password,
    bool remember = true,
  }) {
    return _guard(() async {
      final Response<dynamic> res = await _dio.post<dynamic>(
        '/api/auth/login',
        data: <String, dynamic>{
          'username': username,
          'password': password,
          'remember': remember,
        },
      );
      final String token = _extractSessionToken(res);
      if (token.isNotEmpty) setAuthToken(token);
      return token;
    });
  }

  /// 登出（`POST /api/auth/logout`），成功后清除本地凭证。
  Future<void> logout() {
    return _guard(() async {
      await _dio.post<dynamic>('/api/auth/logout');
      setAuthToken(null);
    });
  }

  /// 从 Set-Cookie 响应头（回退响应体 `token` 字段）提取会话令牌，拿不到返回空串。
  String _extractSessionToken(Response<dynamic> res) {
    final List<String> cookies =
        res.headers['set-cookie'] ?? const <String>[];
    for (final String raw in cookies) {
      final RegExpMatch? m =
          RegExp(r'screenplay_session=([^;]+)').firstMatch(raw);
      if (m == null) continue;
      final String value = m.group(1)!.trim();
      if (value.isEmpty) continue;
      try {
        return Uri.decodeComponent(value);
      } catch (_) {
        return value;
      }
    }
    final dynamic data = res.data;
    if (data is Map && data['token'] is String) {
      return (data['token'] as String).trim();
    }
    return '';
  }

  /// 游戏媒体列表（新调用点统一用这个名字；复用既有 [media]，行为完全一致）。
  Future<List<Media>> listMedia(String gameId) => media(gameId);

  /// 海报列表（`GET /api/games/:id/posters`）。
  Future<List<Poster>> listPosters(String gameId) {
    return _guard(() async {
      final Response<dynamic> res =
          await _dio.get<dynamic>('/api/games/$gameId/posters');
      return _parseListResponse(res, Poster.fromJson);
    });
  }

  /// 删除媒体（`DELETE /api/media/:id`）。
  /// 后端 404 表示媒体已不存在，是否视为「删除完成」由调用方（MediaActions）决定。
  Future<DeleteMediaResult> deleteMedia(String id) {
    return _guard(() async {
      final Response<dynamic> res = await _dio.delete<dynamic>('/api/media/$id');
      final Map<String, dynamic> map = res.data is Map
          ? Map<String, dynamic>.from(res.data as Map)
          : <String, dynamic>{};
      return DeleteMediaResult(
        ok: map['ok'] == true,
        id: map['id']?.toString() ?? id,
        removedFiles: (map['removedFiles'] as num?)?.toInt() ?? 0,
        postersRemoved: (map['postersRemoved'] as num?)?.toInt() ?? 0,
        originalSkipped: map['originalSkipped'] == true,
      );
    });
  }

  /// 自定义排序（`PUT /api/games/order`）：把 [gameId] 移到 [beforeId] 之前，
  /// 或 [afterId] 之后（两者都为空表示移到列表末尾，由后端解释）。
  Future<void> reorderGames({
    required String gameId,
    String? beforeId,
    String? afterId,
  }) {
    return _guard(() async {
      final Map<String, dynamic> body = <String, dynamic>{'gameId': gameId};
      if (beforeId != null) body['beforeId'] = beforeId;
      if (afterId != null) body['afterId'] = afterId;
      await _dio.put<dynamic>('/api/games/order', data: body);
    });
  }

  /// 清空自定义顺序（`DELETE /api/games/order`）。
  Future<void> resetGameOrder() {
    return _guard(() async {
      await _dio.delete<dynamic>('/api/games/order');
    });
  }

  /// 媒体变体的绝对地址。
  String mediaUrl(String id, {MediaVariant variant = MediaVariant.thumbnail}) {
    switch (variant) {
      case MediaVariant.preview:
        return '$_baseUrl/api/media/$id/preview';
      case MediaVariant.original:
        return mediaOriginalUrl(id);
      case MediaVariant.stream:
        return '$_baseUrl/api/media/$id/stream';
      case MediaVariant.cover:
        return '$_baseUrl/api/media/$id/cover';
      case MediaVariant.thumbnail:
        return '$_baseUrl/api/media/$id/thumbnail';
    }
  }

  /// 海报原图地址（`GET /api/posters/:posterId/image`，后端带 7 天 Cache-Control）。
  String posterImageUrl(String posterId) =>
      '$_baseUrl/api/posters/$posterId/image';

  /// 海报缩略图地址（[Poster.thumbUrl] 为空时回退 [Poster.url]）。
  String posterThumbUrl(Poster p) {
    final String? thumb = p.thumbUrl;
    if (thumb != null && thumb.isNotEmpty) return resolve(thumb);
    return resolve(p.url);
  }

  /// 健康检查（复用既有 [health]，不解析返回体）。
  Future<void> checkHealth() async {
    await health();
  }

  /// 宽松的字符串读取（会话返回体里的 username 可能是任意可空类型）。
  String? _asStringOrNull(dynamic value) => value?.toString();

  List<T> _parseListResponse<T>(
    Response<dynamic> res,
    T Function(Map<String, dynamic>) fromJson,
  ) {
    final dynamic data = res.data;
    if (data is! List) return const [];
    return data
        .whereType<Map>()
        .map((dynamic e) => fromJson(Map<String, dynamic>.from(e as Map)))
        .toList(growable: false);
  }
}