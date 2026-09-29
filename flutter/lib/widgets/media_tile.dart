// 媒体网格单元：图片直接展示，视频/gif 展示封面并叠加播放角标。

import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';

import '../models/models.dart';

class MediaTile extends StatelessWidget {
  const MediaTile({
    super.key,
    required this.media,
    required this.coverUrl,
    required this.onTap,
  });

  final Media media;

  /// 已拼好的封面/缩略图地址（视频优先封面，图片用缩略图）。
  final String? coverUrl;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    // AspectRatio 依据已知宽高比给出确定高度，配合 MasonryGridView 的等宽列，
    // 使图片（竖图/横图）与视频封面以各自比例混合排布；未知时回退 16:9/1:1。
    return AspectRatio(
      aspectRatio: _aspectRatio(),
      child: GestureDetector(
        onTap: onTap,
        child: ClipRRect(
          borderRadius: BorderRadius.circular(10),
          child: Stack(
            fit: StackFit.expand,
            children: <Widget>[
              _cover(context),
              if (media.type.isMotion) const _PlayOverlay(),
            ],
          ),
        ),
      ),
    );
  }

  double _aspectRatio() {
    final int? w = media.width;
    final int? h = media.height;
    if (w != null && h != null && w > 0 && h > 0) return w / h;
    return media.type == MediaType.image ? 1.0 : 16.0 / 9.0;
  }

  Widget _cover(BuildContext context) {
    final Widget fallback = Container(
      decoration: const BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: <Color>[Color(0xFF241D3D), Color(0xFF00546B)],
        ),
      ),
      child: const Center(
        child: Icon(Icons.image_outlined, color: Color(0x99FFFFFF), size: 32),
      ),
    );

    if (coverUrl == null || coverUrl!.isEmpty) return fallback;
    return CachedNetworkImage(
      imageUrl: coverUrl!,
      fit: BoxFit.cover,
      placeholder: (BuildContext context, String url) => fallback,
      errorWidget: (BuildContext context, String url, Object error) => fallback,
    );
  }
}

/// 播放角标：半透明暗底 + 居中播放三角形。
class _PlayOverlay extends StatelessWidget {
  const _PlayOverlay();

  @override
  Widget build(BuildContext context) {
    return ColoredBox(
      color: const Color(0x33000000),
      child: Center(
        child: Container(
          width: 46,
          height: 46,
          decoration: const BoxDecoration(
            color: Color(0x99000000),
            shape: BoxShape.circle,
          ),
          child: const Icon(
            Icons.play_arrow_rounded,
            color: Colors.white,
            size: 32,
          ),
        ),
      ),
    );
  }
}