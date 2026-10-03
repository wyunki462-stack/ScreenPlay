// 图片三级缓存：Flutter 内存 ImageCache（L1）→ 磁盘 flutter_cache_manager（L2）→ 网络（L3）。
//
// 为什么自己建 CacheManager 而不是用默认实例：
//  1. 磁盘上限/过期时间要贴合「本地图库」场景（600 条 / 30 天，比默认 200 条更宽松）；
//  2. 需要把「清晰度」编码进缓存键：同一 URL 的预览图与原图各自独立缓存，
//     否则在 WiFi/移动数据间切换时 LRU 会把另一种清晰度顶掉，来回切必然重新下载；
//  3. 删除媒体时需要精确按 URL + 清晰度清掉磁盘与内存条目（见 evictImage）。

import 'dart:io';

import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/painting.dart';
import 'package:flutter_cache_manager/flutter_cache_manager.dart';
import 'package:path_provider/path_provider.dart';

import 'network_quality.dart';

/// Flutter 内存图片缓存上限（80 MiB）。原图较大，条目数不宜再放大。
const int kImageMemCacheBytes = 80 << 20;

/// 磁盘缓存条目上限。
const int kImageDiskMaxObjects = 600;

/// 磁盘缓存过期时间。
const Duration kImageDiskStalePeriod = Duration(days: 30);

/// 内存缓存条目数上限（与 [kImageMemCacheBytes] 双约束，谁先到算谁）。
const int kImageMemCacheObjects = 200;

/// 磁盘缓存目录名 / CacheManager 的 key。
const String kImageCacheKey = 'screenplayImages';

/// ScreenPlay 专用图片缓存管理器（磁盘层）。
class ScreenplayCacheManager extends CacheManager with ImageCacheManager {
  static const String key = kImageCacheKey;

  static final ScreenplayCacheManager _instance = ScreenplayCacheManager._();

  factory ScreenplayCacheManager() => _instance;

  ScreenplayCacheManager._()
      : super(
          Config(
            kImageCacheKey,
            stalePeriod: kImageDiskStalePeriod,
            maxNrOfCacheObjects: kImageDiskMaxObjects,
          ),
        );
}

/// 全局单例（磁盘 + 内存三层缓存的统一入口）。
/// 返回类型保持 [CacheManager]，方便 cached_network_image 直接传 cacheManager。
CacheManager get screenplayImageCache => ScreenplayCacheManager();

/// 把清晰度编码进缓存键。
/// 约定：`<quality>|<url>`。同一 URL 的 preview / original 得到不同键 → 互不顶掉。
/// 海报、封面等无清晰度概念的图沿用 UI 传入的原始 key（一般是 URL 本身）。
String qualityCacheKey(String url, MediaQuality q) => '${q.name}|$url';

/// 某个 URL 可能存在的全部缓存键（两种清晰度 + 兼容未编码的旧键）。
Iterable<String> _allKeysFor(String url) sync* {
  yield qualityCacheKey(url, MediaQuality.preview);
  yield qualityCacheKey(url, MediaQuality.original);
  yield url;
}

/// 删除单个 URL 的磁盘条目，并清掉 Flutter 内存缓存中的对应条目。
/// （删除媒体时，同一 media 的 thumbnail/preview/original/stream 都要调用。）
Future<void> evictImage(String url) async {
  if (url.trim().isEmpty) return;
  for (final String key in _allKeysFor(url)) {
    try {
      await screenplayImageCache.removeFile(key);
    } catch (_) {
      // 条目不存在 / 磁盘异常都不应打断「删除」主流程。
    }
  }
  _evictFromMemory(url);
}

/// 批量清除（等价于逐个调用 [evictImage]）。
Future<void> evictImages(Iterable<String> urls) async {
  for (final String url in urls) {
    await evictImage(url);
  }
}

/// 从 Flutter 内存缓存中驱逐对应条目。
void _evictFromMemory(String url) {
  final ImageCache mem = PaintingBinding.instance.imageCache;
  // 1) 直接用 URL 作为图片地址的场景（Image.network 等）。
  for (final String key in _allKeysFor(url)) {
    mem.evict(NetworkImage(key));
  }
  // 2) CachedNetworkImage 场景：key 是 CachedNetworkImageProvider 对象本身，
  //    这里按 (url, cacheKey) 重建一个等值对象来驱逐。
  for (final String key in _allKeysFor(url)) {
    mem.evict(CachedNetworkImageProvider(url, cacheKey: key));
  }
}

/// 磁盘缓存当前占用（字节）。取不到时返回 0，不抛错（用于设置页展示）。
Future<int> imageCacheBytes() async {
  int total = 0;
  try {
    // 注：不同小版本 API 略有差异，用 dynamic 调用以兼容。
    final dynamic files = await (screenplayImageCache as dynamic).getAllFiles();
    if (files is List) {
      for (final dynamic info in files) {
        final dynamic f = info?.file;
        if (f is File && await f.exists()) {
          total += await f.length();
        }
      }
      if (total > 0) return total;
    }
  } catch (_) {
    // 落到下面的目录统计回退。
  }
  try {
    // 回退：flutter_cache_manager 的 IOFileSystem 把缓存放在 <临时目录>/<key>/。
    final Directory dir =
        Directory('${(await getTemporaryDirectory()).path}/$kImageCacheKey');
    if (await dir.exists()) {
      await for (final FileSystemEntity e
          in dir.list(recursive: true, followLinks: false)) {
        if (e is File) total += await e.length();
      }
    }
  } catch (_) {
    // 统计失败就当 0。
  }
  return total;
}

/// 清空磁盘缓存 + Flutter 内存缓存。
///
/// 为什么内存要连 live images 一起清：正在被解码/展示的图片若不 clearLiveImages，
/// 「清空缓存」后仍会继续占用内存并显示旧图，与用户预期不符。
Future<void> clearImageCache() async {
  await screenplayImageCache.emptyCache();
  final ImageCache mem = PaintingBinding.instance.imageCache;
  mem.clear();
  mem.clearLiveImages();
}

/// 在 `main()` 里调用：给 Flutter 内存图片缓存设上限。
/// 默认上限（100 MiB / 1000 条）在长列表 + 原图场景下容易把内存撑高。
void applyImageMemoryLimits() {
  final ImageCache mem = PaintingBinding.instance.imageCache;
  mem.maximumSizeBytes = kImageMemCacheBytes;
  mem.maximumSize = kImageMemCacheObjects;
}