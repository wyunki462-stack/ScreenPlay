// 媒体操作：分享 / 保存到系统相册 / 删除（含本地缓存语义）。
//
// 为什么单独抽一层：卡片工作流、相册工作流、设置工作流都要用这三种操作，
// 且它们都涉及「下载 → 命中三级缓存 → 临时文件 → 分享/相册」这条链路和
// 「本地缓存与服务器文件是否同步删除」这条策略，放在这里统一避免三处各写一遍。

import 'dart:io';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:gal/gal.dart';
import 'package:path_provider/path_provider.dart';
import 'package:share_plus/share_plus.dart';

import '../models/models.dart';
import 'api_client.dart';
import 'image_cache.dart';
import 'network_quality.dart';
import 'prefs.dart';

/// 删除结果（UI 据此提示「已同步删除到服务器」或「仅清理了本地缓存」）。
class DeleteOutcome {
  const DeleteOutcome({
    required this.syncedToServer,
    required this.serverDeleted,
    required this.localCacheCleared,
    required this.message,
  });

  /// 本次是否真的发起了服务器删除请求（取决于用户的同步开关）。
  final bool syncedToServer;

  /// 服务器端是否已不存在该媒体（含 404 视为已删除）。
  final bool serverDeleted;

  /// 本地磁盘/内存缓存是否已清理。
  final bool localCacheCleared;

  /// 面向用户的中文说明。
  final String message;
}

/// 媒体分享 / 保存 / 删除。
class MediaActions {
  MediaActions({required ApiClient api, required AppPrefs prefs})
      : _api = api,
        _prefs = prefs;

  final ApiClient _api;

  // 目前仅用于「默认是否取原图」等本地偏好；保留字段便于后续扩展。
  // ignore: unused_field
  final AppPrefs _prefs;

  /// 下载（优先命中三级缓存）到临时文件；缺失扩展名时按 URL/兜底补全。
  ///
  /// [quality] 为空时按原图处理：分享/保存是用户主动的「我要这份文件」，画质优先。
  Future<File> downloadToTemp(String url, String fileName,
      {MediaQuality? quality}) async {
    final String absolute = _api.resolve(url);
    final MediaQuality q = quality ?? MediaQuality.original;
    // 先走 flutter_cache_manager：命中磁盘则完全不产生网络请求。
    final File cached =
        await screenplayImageCache.getSingleFile(absolute, key: qualityCacheKey(absolute, q));
    final Directory tmp = await getTemporaryDirectory();
    final File target = File('${tmp.path}/${_safeFileName(fileName, absolute)}');
    if (await target.exists()) {
      await target.delete();
    }
    // copy 而不是 rename：缓存文件要留在缓存目录继续复用。
    return cached.copy(target.path);
  }

  /// 调起系统分享面板（QQ / 微信等目标由系统提供，应用内不做任何平台特判）。
  Future<void> share(String url, String fileName,
      {String? title, MediaQuality? quality}) async {
    final File file = await downloadToTemp(url, fileName, quality: quality);
    await Share.shareXFiles(
      <XFile>[XFile(file.path)],
      text: title ?? '来自 ScreenPlay 的媒体：$fileName',
    );
  }

  /// 保存到系统相册（Android 10+ 走 MediaStore，无需存储权限）。
  Future<void> saveToGallery(String url, String fileName,
      {bool isVideo = false, MediaQuality? quality}) async {
    await ensureGalleryPermissionIfNeeded();
    final File file = await downloadToTemp(
      url,
      _withExtension(fileName, isVideo ? '.mp4' : '.jpg'),
      quality: quality,
    );
    try {
      if (isVideo) {
        await Gal.putVideo(file.path);
      } else {
        await Gal.putImage(file.path);
      }
    } on GalException catch (e) {
      // 转成统一的 ApiException，UI 只需处理一种异常类型。
      throw ApiException('保存到相册失败：${e.type.message}');
    }
  }

  /// Android <= 9 需要 WRITE_EXTERNAL_STORAGE（已在 Manifest 里以 maxSdkVersion=28 声明），
  /// 交给 gal 去请求；Android 10+ 这里是空操作。
  Future<void> ensureGalleryPermissionIfNeeded() async {
    try {
      final bool has = await Gal.hasAccess();
      if (!has) await Gal.requestAccess();
    } on GalException catch (_) {
      // 权限被拒不在这里中断：真正的保存动作会再抛一次并带上明确原因。
    }
  }

  /// 删除媒体：先清本地缓存，[syncToServer] 为真时再调 `DELETE /api/media/:id`。
  ///
  /// 语义（与用户确认过）：
  ///  - 无论是否同步服务器，本地缓存一律先清（用户看到的就是「没了」）；
  ///  - 服务器返回 404 → 视为已删除，不算失败；
  ///  - 服务器返回 401/403 → 抛中文 ApiException，提示需要登录 Linux 端账号。
  Future<DeleteOutcome> delete(Media media, {required bool syncToServer}) async {
    final List<String> urls = _mediaUrls(media);
    await evictImages(urls);
    const bool localCacheCleared = true;

    if (!syncToServer) {
      return const DeleteOutcome(
        syncedToServer: false,
        serverDeleted: false,
        localCacheCleared: localCacheCleared,
        message: '已从本地缓存删除（未同步删除服务器文件）',
      );
    }

    try {
      final DeleteMediaResult res = await _api.deleteMedia(media.id);
      final String detail = res.removedFiles > 0 ? '，服务器已删除 ${res.removedFiles} 个文件' : '';
      return DeleteOutcome(
        syncedToServer: true,
        serverDeleted: res.ok,
        localCacheCleared: localCacheCleared,
        message: '已同步删除到服务器$detail',
      );
    } on ApiException catch (e) {
      if (e.statusCode == 404) {
        return const DeleteOutcome(
          syncedToServer: true,
          serverDeleted: true,
          localCacheCleared: localCacheCleared,
          message: '服务器上已不存在该媒体，视为删除完成',
        );
      }
      if (e.statusCode == 401 || e.statusCode == 403) {
        throw ApiException(
          '需要登录 Linux 端账号后才能同步删除到服务器（本地缓存已清理）：${e.message}',
          statusCode: e.statusCode,
        );
      }
      // 其它错误（5xx/网络）原样抛出，由 UI 提示重试。
      rethrow;
    }
  }

  /// 同一 media 需要清缓存的全部地址（thumbnail/preview/original/stream，另含封面）。
  List<String> _mediaUrls(Media media) {
    final List<String> urls = <String>[
      _api.resolve(media.thumbnailUrl),
      _api.resolve(media.previewPath),
      _api.resolve(media.originalPath),
      _api.resolve(media.streamPath),
    ];
    final String? cover = media.coverUrl;
    if (cover != null && cover.isNotEmpty) urls.add(_api.resolve(cover));
    return urls;
  }

  /// 保证有扩展名（相册/分享目标应用常按扩展名判断类型）。
  String _withExtension(String fileName, String fallbackExt) {
    final String name = fileName.trim();
    if (name.isEmpty) return 'screenplay_media$fallbackExt';
    final int slash = name.lastIndexOf('/');
    final String base = slash >= 0 ? name.substring(slash + 1) : name;
    final int dot = base.lastIndexOf('.');
    if (dot > 0 && dot < base.length - 1) return base;
    return '$base$fallbackExt';
  }

  /// 生成安全的临时文件名（去掉路径分隔符与 Windows 非法字符）。
  String _safeFileName(String fileName, String url) {
    String name = fileName.trim();
    if (name.isEmpty) name = _fileNameFromUrl(url);
    name = name.replaceAll(RegExp(r'[\\/:*?"<>|\x00-\x1f]'), '_');
    if (!name.contains('.') || name.endsWith('.')) {
      name = '$name${_extensionFromUrl(url)}';
    }
    return name;
  }

  String _fileNameFromUrl(String url) {
    final Uri? uri = Uri.tryParse(url);
    if (uri == null || uri.pathSegments.isEmpty) return 'screenplay_media';
    final String last = uri.pathSegments.last;
    return last.isEmpty ? 'screenplay_media' : last;
  }

  String _extensionFromUrl(String url) {
    final String last = _fileNameFromUrl(url);
    final int dot = last.lastIndexOf('.');
    if (dot > 0 && dot < last.length - 1) return last.substring(dot);
    // 后端媒体地址形如 /api/media/:id/original，通常没有扩展名 → 兜底按图片处理。
    return '.jpg';
  }
}

/// 全局媒体操作入口。
final Provider<MediaActions> mediaActionsProvider = Provider<MediaActions>(
  (Ref ref) => MediaActions(
    api: ref.watch(apiClientProvider),
    prefs: ref.read(appPrefsProvider),
  ),
);