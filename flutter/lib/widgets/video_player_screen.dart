// 全屏视频播放器：video_player + chewie，接入 `/api/media/:id/stream`（Range 流式），
// 加载期间以封面（/cover）作为海报。

import 'package:cached_network_image/cached_network_image.dart';
import 'package:chewie/chewie.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:video_player/video_player.dart';

import '../core/api_client.dart';
import '../models/models.dart';

class VideoPlayerScreen extends ConsumerStatefulWidget {
  const VideoPlayerScreen({super.key, required this.media});

  final Media media;

  @override
  ConsumerState<VideoPlayerScreen> createState() => _VideoPlayerScreenState();
}

class _VideoPlayerScreenState extends ConsumerState<VideoPlayerScreen> {
  VideoPlayerController? _videoController;
  ChewieController? _chewieController;
  String? _posterUrl;
  Object? _error;

  @override
  void initState() {
    super.initState();
    _initialize();
  }

  @override
  void dispose() {
    _chewieController?.dispose();
    _videoController?.dispose();
    super.dispose();
  }

  Future<void> _initialize() async {
    final ApiClient api = ref.read(apiClientProvider);
    final String streamUrl = api.resolve(widget.media.streamUrl);
    _posterUrl = widget.media.coverUrl == null
        ? api.resolve(widget.media.thumbnailUrl)
        : api.resolve(widget.media.coverUrl!);

    final VideoPlayerController controller =
        VideoPlayerController.networkUrl(Uri.parse(streamUrl));
    _videoController = controller;

    try {
      await controller.initialize();
    } catch (Object e) {
      // 初始化失败：仅记录错误以便展示；控制器统一交由 dispose 释放，避免二次释放。
      if (mounted) setState(() => _error = e);
      return;
    }

    if (!mounted) return;

    _chewieController = ChewieController(
      videoPlayerController: controller,
      autoPlay: true,
      looping: false,
      allowFullScreen: true,
      allowMuting: true,
      materialProgressColors: const ChewieProgressColors(
        playedColor: Color(0xFF00E5FF),
        handleColor: Color(0xFF00E5FF),
        bufferedColor: Color(0xFF4A445C),
        backgroundColor: Color(0xFF2A2637),
      ),
    );
    setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.transparent,
        title: Text(widget.media.fileName, maxLines: 1, overflow: TextOverflow.ellipsis),
      ),
      body: SafeArea(child: _buildBody()),
    );
  }

  Widget _buildBody() {
    if (_error != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              const Icon(Icons.error_outline, color: Color(0xFFFC6255), size: 48),
              const SizedBox(height: 12),
              const Text('视频加载失败，请确认后端可访问该媒体文件。', textAlign: TextAlign.center),
              const SizedBox(height: 4),
              Text(
                _error.toString(),
                maxLines: 3,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(color: Color(0xFF9E96B5), fontSize: 12),
              ),
            ],
          ),
        ),
      );
    }

    final ChewieController? chewie = _chewieController;
    final VideoPlayerController? video = _videoController;
    if (chewie == null || video == null || !video.value.isInitialized) {
      // 加载中：用封面作为海报。
      return Center(
        child: Stack(
          alignment: Alignment.center,
          children: <Widget>[
            if (_posterUrl != null && _posterUrl!.isNotEmpty)
              Positioned.fill(
                child: CachedNetworkImage(
                  imageUrl: _posterUrl!,
                  fit: BoxFit.contain,
                  errorWidget: (BuildContext context, String url, Object error) =>
                      const SizedBox.shrink(),
                ),
              ),
            const CircularProgressIndicator(color: Color(0xFF00E5FF)),
          ],
        ),
      );
    }

    return Center(
      child: AspectRatio(
        aspectRatio: video.value.aspectRatio == 0 ? 16 / 9 : video.value.aspectRatio,
        child: Chewie(controller: chewie),
      ),
    );
  }
}