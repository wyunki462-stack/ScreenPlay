// 全屏视频播放器：video_player + chewie，接入 `/api/media/:id/stream`（Range 流式），
// 加载期间以封面（/cover）作为海报。
// 顶栏提供「分享 / 保存到相册 / 删除」；分享与保存按 mediaQualityProvider 传清晰度，
// 文件名用 media.fileName。严格禁止上传：只做下载到本机 + 系统分享 / 写相册。

import 'package:chewie/chewie.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:video_player/video_player.dart';

import '../core/api_client.dart';
import '../core/media_actions.dart';
import '../core/network_quality.dart';
import '../core/prefs.dart';
import '../models/models.dart';
import 'authed_image.dart';
import 'media_tile.dart';

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

  /// 给用户看的中文错误说明（区分鉴权/网络失败与格式不支持），与 [_error] 原始异常分开。
  String? _errorText;

  /// 分享/保存/删除进行中：禁用按钮避免重复点击。
  bool _busy = false;

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

    final VideoPlayerController controller = VideoPlayerController.networkUrl(
      Uri.parse(streamUrl),
      // `/api/media/:id/stream` 不在 auth.guard 的 PUBLIC_PATHS 内，必须带会话凭证，
      // 否则 ExoPlayer 收到 401 会报 `VideoError ... error 10: Source error`。
      // 复用与图片相同的 header（Authorization: Bearer + Cookie: screenplay_session）。
      httpHeaders: api.imageHeaders,
    );
    _videoController = controller;

    try {
      await controller.initialize();
    } on Object catch (e) {
      // 初始化失败：进一步探测流地址，区分「鉴权/网络失败」与「格式不支持」。
      final String message = await _describePlaybackError(api, streamUrl);
      // 控制器统一交由 dispose 释放，避免二次释放。
      if (mounted) {
        setState(() {
          _error = e;
          _errorText = message;
        });
      }
      return;
    }

    if (!mounted) return;

    _chewieController = ChewieController(
      videoPlayerController: controller,
      autoPlay: true,
      looping: false,
      // 安卓原生习惯：允许 chewie 自带的横屏全屏播放。
      allowFullScreen: true,
      allowMuting: true,
      materialProgressColors: ChewieProgressColors(
        playedColor: const Color(0xFF00E5FF),
        handleColor: const Color(0xFF00E5FF),
        bufferedColor: const Color(0xFF4A445C),
        backgroundColor: const Color(0xFF2A2637),
      ),
    );
    setState(() {});
  }

  /// 后端 streaming.service.ts 只为 .mp4/.webm/.mkv 分配视频 MIME，
  /// 其余扩展名一律 `application/octet-stream`，ExoPlayer 无法解码。
  static const Set<String> _supportedVideoExts = <String>{'mp4', 'webm', 'mkv'};

  static String _extensionOf(String name) {
    final String path = name.split('?').first.split('#').first;
    final int slash = path.lastIndexOf('/');
    final String base = slash >= 0 ? path.substring(slash + 1) : path;
    final int dot = base.lastIndexOf('.');
    if (dot < 0 || dot == base.length - 1) return '';
    return base.substring(dot + 1).toLowerCase();
  }

  /// 把播放器初始化失败细分为中文提示：先看扩展名是否为后端不支持的容器格式，
  /// 否则探测流地址（带凭证）以区分未登录 / 网络不通 / 文件缺失 / 服务器错误。
  /// 探测可达但仍无法解码时，提示格式（编码）不受支持 —— 不伪造支持、不做端上转码。
  Future<String> _describePlaybackError(ApiClient api, String streamUrl) async {
    final String ext = _extensionOf(
      widget.media.fileName.isNotEmpty ? widget.media.fileName : streamUrl,
    );
    if (ext.isNotEmpty && !_supportedVideoExts.contains(ext)) {
      return '该视频格式（.$ext）不受支持：播放器仅支持 MP4 / WebM / MKV，请先转码再播放。';
    }

    final StreamProbeStatus status;
    try {
      status = await api.probeStream(streamUrl);
    } on Object {
      return '视频加载失败：无法连接服务器，请检查网络或后端服务是否可用。';
    }
    switch (status) {
      case StreamProbeStatus.unauthorized:
        return '视频加载失败：需要登录或登录已过期，请重新登录后再试。';
      case StreamProbeStatus.notFound:
        return '视频加载失败：服务器上找不到该文件，可能已被删除或移动。';
      case StreamProbeStatus.network:
        return '视频加载失败：无法连接服务器，请检查网络或后端服务是否可用。';
      case StreamProbeStatus.serverError:
        return '视频加载失败：服务器返回错误，请稍后重试。';
      case StreamProbeStatus.reachable:
        return '服务器可访问，但播放器无法解码该视频（可能是不受支持的编码格式，仅支持 MP4 / WebM / MKV）。';
    }
  }

  /// 分享/保存用的地址：original → stream（完整可播放文件），preview → /preview。
  String _shareUrl(ApiClient api, MediaQuality quality) {
    final Media media = widget.media;
    if (quality == MediaQuality.original) {
      final String url = api.resolve(media.streamPath);
      return url.isNotEmpty ? url : api.resolve(media.streamUrl);
    }
    final String? provided = media.previewUrl;
    if (provided != null && provided.isNotEmpty) return api.resolve(provided);
    return api.resolve(media.previewPath);
  }

  void _snack(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));
  }

  Future<void> _share() async {
    if (_busy) return;
    final ApiClient api = ref.read(apiClientProvider);
    final MediaQuality quality = ref.read(mediaQualityProvider);
    setState(() => _busy = true);
    try {
      await ref.read(mediaActionsProvider).share(
            _shareUrl(api, quality),
            widget.media.fileName,
            title: widget.media.fileName,
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

  Future<void> _save() async {
    if (_busy) return;
    final ApiClient api = ref.read(apiClientProvider);
    final MediaQuality quality = ref.read(mediaQualityProvider);
    setState(() => _busy = true);
    try {
      await ref.read(mediaActionsProvider).saveToGallery(
            _shareUrl(api, quality),
            widget.media.fileName,
            isVideo: true,
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

  Future<void> _delete() async {
    if (_busy) return;
    setState(() => _busy = true);
    final bool removed = await runMediaDelete(
      context,
      ref,
      media: widget.media,
      syncToServer: ref.read(syncDeleteProvider),
    );
    if (!mounted) return;
    setState(() => _busy = false);
    // 删掉的就是正在播的这个文件：直接退回媒体网格。
    if (removed) Navigator.of(context).maybePop();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.transparent,
        title: Text(widget.media.fileName, maxLines: 1, overflow: TextOverflow.ellipsis),
        actions: <Widget>[
          IconButton(
            tooltip: '分享',
            visualDensity: VisualDensity.compact,
            icon: const Icon(Icons.ios_share),
            onPressed: _busy ? null : _share,
          ),
          IconButton(
            tooltip: '保存到相册',
            visualDensity: VisualDensity.compact,
            icon: const Icon(Icons.download_outlined),
            onPressed: _busy ? null : _save,
          ),
          IconButton(
            tooltip: '删除',
            visualDensity: VisualDensity.compact,
            icon: const Icon(Icons.delete_outline),
            onPressed: _busy ? null : _delete,
          ),
        ],
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
              Text(
                _errorText ?? '视频加载失败，请确认后端可访问该媒体文件。',
                textAlign: TextAlign.center,
              ),
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
                child: AuthedImage(
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