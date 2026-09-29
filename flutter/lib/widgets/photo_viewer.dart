// 分页图片查看器：PageView 左右切换 + InteractiveViewer 捏合缩放，
// 顶栏提供「上一张 / 下一张 / 查看原图」，「查看原图」打开 /original 地址。

import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';

/// 查看器中的单张图片条目。
class PhotoItem {
  const PhotoItem({
    required this.id,
    required this.displayUrl,
    required this.originalUrl,
    this.label,
  });

  final String id;

  /// 普通显示地址（已拼好的绝对 URL）。
  final String displayUrl;

  /// 原图地址（/original，已拼好的绝对 URL）。
  final String originalUrl;
  final String? label;
}

class PhotoViewer extends StatefulWidget {
  const PhotoViewer({
    super.key,
    required this.items,
    required this.initialIndex,
  });

  final List<PhotoItem> items;
  final int initialIndex;

  @override
  State<PhotoViewer> createState() => _PhotoViewerState();
}

class _PhotoViewerState extends State<PhotoViewer> {
  late final PageController _pageController;
  late int _index;

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

  void _goTo(int index) {
    if (index < 0 || index >= widget.items.length) return;
    _pageController.animateToPage(
      index,
      duration: const Duration(milliseconds: 220),
      curve: Curves.easeOut,
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.transparent,
        title: Text('${_index + 1} / ${widget.items.length}'),
        actions: <Widget>[
          IconButton(
            tooltip: '上一张',
            icon: const Icon(Icons.chevron_left),
            onPressed: _index > 0 ? () => _goTo(_index - 1) : null,
          ),
          IconButton(
            tooltip: '下一张',
            icon: const Icon(Icons.chevron_right),
            onPressed: _index < widget.items.length - 1 ? () => _goTo(_index + 1) : null,
          ),
          IconButton(
            tooltip: '查看原图',
            icon: const Icon(Icons.hd_outlined),
            onPressed: _openOriginal,
          ),
        ],
      ),
      body: PageView.builder(
        controller: _pageController,
        itemCount: widget.items.length,
        onPageChanged: (int index) => setState(() => _index = index),
        itemBuilder: (BuildContext context, int index) {
          final PhotoItem item = widget.items[index];
          return _ZoomableImage(
            imageUrl: item.displayUrl,
            label: item.label ?? item.id,
            heroTag: 'media_${item.id}',
          );
        },
      ),
    );
  }

  void _openOriginal() {
    final PhotoItem item = widget.items[_index];
    Navigator.of(context).push(
      MaterialPageRoute<dynamic>(
        builder: (BuildContext context) => _OriginalImageScreen(
          item: item,
          position: '${_index + 1} / ${widget.items.length}',
        ),
      ),
    );
  }
}

/// 支持捏合缩放的可缩放图片；缩放为 1 时让出手势给 PageView 左右滑动。
class _ZoomableImage extends StatefulWidget {
  const _ZoomableImage({
    required this.imageUrl,
    required this.label,
    required this.heroTag,
  });

  final String imageUrl;
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
          child: CachedNetworkImage(
            imageUrl: widget.imageUrl,
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

/// 「查看原图」：全屏展示 /original 原始字节（正确的 Content-Type）。
class _OriginalImageScreen extends StatelessWidget {
  const _OriginalImageScreen({required this.item, required this.position});

  final PhotoItem item;
  final String position;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.transparent,
        title: Text('原图 · $position'),
      ),
      body: Center(
        child: InteractiveViewer(
          maxScale: 6,
          child: Image.network(
            item.originalUrl,
            fit: BoxFit.contain,
            loadingBuilder: (BuildContext context, Widget child, ImageChunkEvent? progress) {
              if (progress == null) return child;
              return const Center(
                child: CircularProgressIndicator(color: Color(0xFF00E5FF)),
              );
            },
            errorBuilder: (BuildContext context, Object error, StackTrace? stackTrace) =>
                const Center(
              child: Text(
                '原图加载失败',
                style: TextStyle(color: Color(0xFFFC6255)),
              ),
            ),
          ),
        ),
      ),
    );
  }
}