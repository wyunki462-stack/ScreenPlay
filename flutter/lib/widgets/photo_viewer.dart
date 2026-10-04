// 分页图片查看器：PageView 左右切换 + InteractiveViewer 捏合缩放。
// 顶栏提供「上一张 / 下一张 /「原图⇄预览」切换 / 分享 / 保存到相册 / 删除」。
//
// 清晰度策略：默认跟随全局 mediaQualityProvider（WiFi+开关开 → 原图，移动数据 → 预览），
// 顶栏可手动切换并即时换 URL 重新加载；两种清晰度用 qualityCacheKey 区分为不同缓存键，
// 都走 screenplayImageCache（内存 + 磁盘），避免来回切换时互相顶掉缓存。

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/api_client.dart';
import '../core/image_cache.dart';
import '../core/media_actions.dart';
import '../core/network_quality.dart';
import '../core/prefs.dart';
import '../models/models.dart';
import 'authed_image.dart';
import 'media_tile.dart';

/// 查看器中的单张图片条目。
class PhotoItem {
  const PhotoItem({
    required this.id,
    required this.displayUrl,
    required this.originalUrl,
    this.label,
    this.media,
  });

  final String id;

  /// 普通显示地址（已拼好的绝对 URL）。
  final String displayUrl;

  /// 原图地址（/original，已拼好的绝对 URL）。
  final String originalUrl;
  final String? label;

  /// 对应的相册媒体。为 null 表示非相册来源（例如 TMDB 截图）：
  /// 这类条目没有 /preview 端点，也不该被删除/分享，因此不显示清晰度切换与操作按钮。
  final Media? media;
}

class PhotoViewer extends ConsumerStatefulWidget {
  const PhotoViewer({
    super.key,
    required this.items,
    required this.initialIndex,
  });

  final List<PhotoItem> items;
  final int initialIndex;

  @override
  ConsumerState<PhotoViewer> createState() => _PhotoViewerState();
}

class _PhotoViewerState extends ConsumerState<PhotoViewer> {
  late final PageController _pageController;
  late int _index;

  /// 手动切换的清晰度；null = 跟随全局策略（mediaQualityProvider）。
  MediaQuality? _override;

  /// 分享/保存/删除进行中，避免重复点击。
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _index = widget.initialIndex.clamp(0, widget.items.length - 1);
    _pageController = PageController(initialPage: _index);
  }

  @override
  void dispose() {
    _pageController.dispose();
    super.dispose();
  }

  /// 过滤掉本地已删除的条目（非相册条目永远保留）。
  /// [removedIds] 来自 media_tile.dart 的本地删除集合（网格/视频页共用）。
  List<PhotoItem> _visibleItems(Set<String> removedIds) => widget.items
      .where((PhotoItem i) {
        final Media? media = i.media;
        return media == null || !removedIds.contains(media.id);
      })
      .toList(growable: false);

  /// 当前生效的清晰度（用于展示）。
  MediaQuality _qualityOf(BuildContext context) =>
      _override ?? ref.read(mediaQualityProvider);

  /// 预览地址：优先服务端给的 previewUrl，缺失时按 previewPath 约定拼。
  String _previewUrl(ApiClient api, PhotoItem item) {
    final Media? media = item.media;
    if (media == null) return item.displayUrl;
    final String? provided = media.previewUrl;
    if (provided != null && provided.isNotEmpty) return api.resolve(provided);
    return api.resolve(media.previewPath);
  }

  /// 按清晰度取图：original → /api/media/<id>/original，其余 → /api/media/<id>/preview。
  String _urlFor(ApiClient api, PhotoItem item, MediaQuality quality) {
    final Media? media = item.media;
    if (media == null) return item.displayUrl;
    if (quality == MediaQuality.original) {
      final String url = api.resolve(media.originalPath);
      return url.isNotEmpty ? url : item.originalUrl;
    }
    return _previewUrl(api, item);
  }

  void _goTo(int index, int length) {
    if (index < 0 || index >= length) return;
    _pageController.animateToPage(
      index,
      duration: const Duration(milliseconds: 220),
      curve: Curves.easeOut,
    );
  }

  void _snack(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));
  }

  void _toggleQuality() {
    final MediaQuality current = _qualityOf(context);
    setState(() {
      _override =
          current == MediaQuality.original ? MediaQuality.preview : MediaQuality.original;
    });
  }

  // --- 分享 / 保存（严格禁止上传：只做「下载到本机 → 系统分享/写入相册」） ---

  Future<void> _share(ApiClient api, PhotoItem item) async {
    final Media? media = item.media;
    if (media == null || _busy) return;
    final MediaQuality quality = _qualityOf(context);
    setState(() => _busy = true);
    try {
      await ref.read(mediaActionsProvider).share(
            _urlFor(api, item, quality),
            media.fileName,
            title: media.fileName,
            quality: quality,
          );
    } on ApiException catch (e) {
      _snack(e.message.isEmpty ? '分享失败' : e.message);
    } on PlatformException catch (e) {
      _snack('分享失败：${e.message ?? e.code}');
    } catch (error) {
      _snack('分享失败：$error');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _save(ApiClient api, PhotoItem item) async {
    final Media? media = item.media;
    if (media == null || _busy) return;
    final MediaQuality quality = _qualityOf(context);
    setState(() => _busy = true);
    try {
      await ref.read(mediaActionsProvider).saveToGallery(
            _urlFor(api, item, quality),
            media.fileName,
            quality: quality,
          );
      _snack('已保存到相册');
    } on ApiException catch (e) {
      _snack(e.message.isEmpty ? '保存到相册失败' : e.message);
    } on PlatformException catch (e) {
      _snack('保存到相册失败：${e.message ?? e.code}');
    } catch (error) {
      _snack('保存到相册失败：$error');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _delete(PhotoItem item) async {
    final Media? media = item.media;
    if (media == null || _busy) return;
    setState(() => _busy = true);
    final bool removed = await runMediaDelete(
      context,
      ref,
      media: media,
      syncToServer: ref.read(syncDeleteProvider),
    );
    if (!mounted) return;
    // 删除成功时 runMediaDelete 已把 id 记入本地隐藏集合（provider 失效 + 本地隐藏双保险），
    // 本页 build 会重新过滤列表，这里只需复位忙状态。
    setState(() => _busy = false);
    if (!removed) return;
    // 列表变短后把页索引收进合法范围；删空了就退出查看器。
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final int length =
          _visibleItems(ref.read(locallyRemovedMediaIdsProvider)).length;
      if (length == 0) {
        Navigator.of(context).maybePop();
        return;
      }
      if (_index > length - 1) {
        _pageController.jumpToPage(length - 1);
        setState(() => _index = length - 1);
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final List<PhotoItem> items =
        _visibleItems(ref.watch(locallyRemovedMediaIdsProvider));
    if (items.isEmpty) {
      // 全部删完（由 _delete 的 post-frame 回调负责退出，这里只兜底渲染）。
      return const Scaffold(backgroundColor: Colors.black, body: SizedBox.shrink());
    }

    final ApiClient api = ref.watch(apiClientProvider);
    // 跟随全局策略（手动切换优先）。
    final MediaQuality quality = _override ?? ref.watch(mediaQualityProvider);
    final int index = _index.clamp(0, items.length - 1);
    final PhotoItem current = items[index];
    final bool isMedia = current.media != null;

    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.transparent,
        title: Text('${index + 1} / ${items.length}'),
        actions: <Widget>[
          if (items.length > 1)
            IconButton(
              tooltip: '上一张',
              visualDensity: VisualDensity.compact,
              icon: const Icon(Icons.chevron_left),
              onPressed: index > 0 ? () => _goTo(index - 1, items.length) : null,
            ),
          if (items.length > 1)
            IconButton(
              tooltip: '下一张',
              visualDensity: VisualDensity.compact,
              icon: const Icon(Icons.chevron_right),
              onPressed:
                  index < items.length - 1 ? () => _goTo(index + 1, items.length) : null,
            ),
          if (isMedia) ...<Widget>[
            IconButton(
              // 中文 tooltip 表明「按一下会发生什么」。
              tooltip: quality == MediaQuality.original ? '切换为预览图' : '查看原图',
              visualDensity: VisualDensity.compact,
              icon: Icon(
                quality == MediaQuality.original ? Icons.hd : Icons.hd_outlined,
              ),
              onPressed: _busy ? null : _toggleQuality,
            ),
            IconButton(
              tooltip: '分享',
              visualDensity: VisualDensity.compact,
              icon: const Icon(Icons.ios_share),
              onPressed: _busy ? null : () => _share(api, current),
            ),
            IconButton(
              tooltip: '保存到相册',
              visualDensity: VisualDensity.compact,
              icon: const Icon(Icons.download_outlined),
              onPressed: _busy ? null : () => _save(api, current),
            ),
            IconButton(
              tooltip: '删除',
              visualDensity: VisualDensity.compact,
              icon: const Icon(Icons.delete_outline),
              onPressed: _busy ? null : () => _delete(current),
            ),
          ],
        ],
      ),
      body: PageView.builder(
        controller: _pageController,
        itemCount: items.length,
        onPageChanged: (int i) => setState(() => _index = i),
        itemBuilder: (BuildContext context, int i) {
          final PhotoItem item = items[i];
          final String url = _urlFor(api, item, quality);
          return _ZoomableImage(
            imageUrl: url,
            cacheKey: qualityCacheKey(url, quality),
            label: item.label ?? item.id,
            heroTag: 'media_${item.id}',
          );
        },
      ),
    );
  }
}

/// 支持捏合缩放的可缩放图片；缩放为 1 时让出手势给 PageView 左右滑动。
class _ZoomableImage extends StatefulWidget {
  const _ZoomableImage({
    required this.imageUrl,
    required this.cacheKey,
    required this.label,
    required this.heroTag,
  });

  final String imageUrl;

  /// 清晰度相关的缓存键（`<quality>|<url>`），避免两种清晰度互相顶掉磁盘条目。
  final String cacheKey;
  final String label;
  final String heroTag;

  @override
  State<_ZoomableImage> createState() => _ZoomableImageState();
}

class _ZoomableImageState extends State<_ZoomableImage> {
  final TransformationController _transform = TransformationController();
  bool _zoomed = false;

  @override
  void initState() {
    super.initState();
    _transform.addListener(_onTransform);
  }

  @override
  void dispose() {
    _transform.removeListener(_onTransform);
    _transform.dispose();
    super.dispose();
  }

  void _onTransform() {
    final bool zoomed = _transform.value.getMaxScaleOnAxis() > 1.01;
    if (zoomed != _zoomed) {
      setState(() => _zoomed = zoomed);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Center(
      child: InteractiveViewer(
        transformationController: _transform,
        maxScale: 6,
        // 未被放大时允许父级 PageView 处理水平滑动；放大后由 InteractiveViewer 平移。
        panEnabled: _zoomed,
        scaleEnabled: true,
        child: Hero(
          tag: widget.heroTag,
          child: AuthedImage(
            imageUrl: widget.imageUrl,
            cacheKey: widget.cacheKey,
            fit: BoxFit.contain,
            placeholder: (BuildContext context, String url) =>
                const Center(child: CircularProgressIndicator(color: Color(0xFF00E5FF))),
            errorWidget: (BuildContext context, String url, Object error) => const Center(
              child: Icon(Icons.broken_image_outlined, color: Color(0xFFFC6255), size: 56),
            ),
          ),
        ),
      ),
    );
  }
}

