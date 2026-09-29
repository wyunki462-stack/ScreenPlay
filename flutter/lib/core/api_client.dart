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

/// 依赖 serverConfigProvider 的 ApiClient 提供者（地址变更时自动重建）。
final Provider<ApiClient> apiClientProvider = Provider<ApiClient>(
  (ProviderRef<ApiClient> ref) => ApiClient(baseUrl: ref.watch(serverConfigProvider)),
);

class ApiClient {
  /// baseUrl 传入前应已通过 normalizeBaseUrl 去尾斜杠。
  ApiClient({required String baseUrl})
      : _baseUrl = normalizeBaseUrl(baseUrl),
        _dio = Dio(
          BaseOptions(
            baseUrl: normalizeBaseUrl(baseUrl),
            connectTimeout: const Duration(seconds: 10),
            receiveTimeout: const Duration(seconds: 60),
            headers: const <String, dynamic>{'Accept': 'application/json'},
          ),
        ) {
    // 仅在调试模式打印请求/响应日志，减少正式包噪音。
    if (kDebugMode) {
      _dio.interceptors.add(
        LogInterceptor(requestBody: false, responseBody: false),
      );
    }
  }

  final String _baseUrl;
  final Dio _dio;

  /// 把相对/绝对地址归一为绝对 URL（相对地址一律以当前 baseUrl 为前缀）。
  String resolve(String pathOrUrl) {
    if (pathOrUrl.isEmpty) return pathOrUrl;
    if (pathOrUrl.startsWith('http://') || pathOrUrl.startsWith('https://')) {
      return pathOrUrl;
    }
    return '$_baseUrl${pathOrUrl.startsWith('/') ? pathOrUrl : '/$pathOrUrl'}';
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