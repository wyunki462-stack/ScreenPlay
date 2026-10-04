// 媒体网格单元：图片直接展示，视频/gif 展示封面并叠加播放角标。
//
// 本文件同时集中承载「媒体删除」的确认弹窗与执行流程：网格长按、大图查看器、
// 视频页三处入口行为必须一致（同样的中文说明、同样的 401 提示、同样的失效语义），
// 放在这里统一实现，避免三处各写一遍分叉。

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/api_client.dart';
import '../core/app_lifecycle.dart';
import '../core/media_actions.dart';
import '../models/models.dart';
import '../providers/api_providers.dart';
import 'authed_image.dart';

class MediaTile extends StatelessWidget {
  const MediaTile({
    super.key,
    required this.media,
    required this.coverUrl,
    required this.onTap,
    this.onLongPress,
  });

  final Media media;

  /// 已拼好的封面/缩略图地址（视频优先封面，图片用缩略图）。
  final String? coverUrl;
  final VoidCallback onTap;

  /// 长按回调（安卓原生习惯：长按 = 删除入口）。为 null 时不响应长按。
  final VoidCallback? onLongPress;

  @override
  Widget build(BuildContext context) {
    // AspectRatio 依据已知宽高比给出确定高度，配合 MasonryGridView 的等宽列，
    // 使图片（竖图/横图）与视频封面以各自比例混合排布；未知时回退 16:9/1:1。
    return AspectRatio(
      aspectRatio: _aspectRatio(),
      child: GestureDetector(
        onTap: onTap,
        onLongPress: onLongPress,
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
    return AuthedImage(
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

// ---------------------------------------------------------------------------
// 删除流程（网格长按 / 大图查看器 / 视频页共用）
// ---------------------------------------------------------------------------

/// 本地已删除媒体 id 集合（共享给网格 / 大图查看器 / 视频页）。
///
/// 关闭「同步删除到服务器」时服务端仍有该文件，但本机缓存已清空，必须保持在 UI 里隐藏，
/// 否则重新拉取列表会把它又显示出来、甚至再次请求已清缓存的图片。
/// 三个删除入口都在 widgets 层，共用一个会话级集合，就不必跨页面回传删除结果。
final StateProvider<Set<String>> locallyRemovedMediaIdsProvider =
    StateProvider<Set<String>>((Ref ref) => <String>{});

/// 删除流程结果：弹窗内执行删除，把「是否隐藏该项」和「要提示的文案」带回调用方。
class MediaDeleteResult {
  /// 是否应从本地列表隐藏该项（删除成功，或服务器 404 视为已删除）。
  bool removed = false;

  /// 需要给用户看的中文提示（成功或失败）。
  String? message;

  /// 401/403：需要登录 Linux 端账号才能同步删服务器文件。
  bool needsLogin = false;
}

/// 确认弹窗的说明文案，随「删除同步到服务端」开关变化（语义已与用户确认）：
///  - 开启同步：将从服务器与本机缓存中删除，且不可恢复；
///  - 关闭同步：仅从本机缓存删除，不影响服务器。
String _deleteConfirmMessage(bool syncToServer) => syncToServer
    ? '将从服务器与本机缓存中删除该文件，且不可恢复。'
    : '仅从本机缓存删除，不影响服务器。';

/// 完整删除流程（前台校验 → 确认弹窗（含进度态）→ 删除 → 中文提示）。
///
/// 返回 true 表示调用方应把该项从本地列表立刻隐藏（provider 失效 + 本地 removedId 双保险）。
///
/// 删除语义：
///  - [syncToServer]=true → `deleteMediaProvider.run(...)`，内部会同步删服务端文件，
///    并失效 `gameMediaProvider` / `gameDetailProvider` / `gamesProvider` / `statsProvider`；
///  - [syncToServer]=false → 直接调 `mediaActions.delete(media, syncToServer: false)`，
///    只清本机三级缓存、**不**失效列表（避免再次请求把已删项又拉回来），由调用方的
///    本地 removedId 集合从 UI 隐藏；
///  - 401/403 → 提示「需要登录 Linux 端账号才能删除服务器文件」并给「去登录」动作；
///  - 404 → 视为已删除，照常刷新列表。
Future<bool> runMediaDelete(
  BuildContext context,
  WidgetRef ref, {
  required Media media,
  required bool syncToServer,
}) async {
  // 删除是写操作：只在应用前台执行。用户手势触发天然满足这一点，
  // 这里显式判断一次，避免日后有非手势路径（如通知/深链）误触发写操作。
  if (!ref.read(isForegroundProvider)) return false;

  final MediaDeleteResult result = MediaDeleteResult();
  await showDialog<void>(
    context: context,
    barrierDismissible: false,
    builder: (BuildContext _) => _MediaDeleteDialog(
      media: media,
      syncToServer: syncToServer,
      result: result,
    ),
  );

  if (!context.mounted) return result.removed;

  final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);
  if (result.needsLogin) {
    messenger.showSnackBar(
      SnackBar(
        content: const Text('需要登录 Linux 端账号才能删除服务器文件'),
        action: SnackBarAction(
          label: '去登录',
          // 路由名固定为 '/login'（由登录工作流注册）。
          onPressed: () => Navigator.pushNamed(context, '/login'),
        ),
      ),
    );
  } else if (result.message != null) {
    messenger.showSnackBar(SnackBar(content: Text(result.message!)));
  }
  return result.removed;
}

/// 确认弹窗本体：自身承载删除请求，删除期间禁用按钮并显示 loading（防重复点击）。
class _MediaDeleteDialog extends ConsumerStatefulWidget {
  const _MediaDeleteDialog({
    required this.media,
    required this.syncToServer,
    required this.result,
  });

  final Media media;
  final bool syncToServer;
  final MediaDeleteResult result;

  @override
  ConsumerState<_MediaDeleteDialog> createState() => _MediaDeleteDialogState();
}

class _MediaDeleteDialogState extends ConsumerState<_MediaDeleteDialog> {
  bool _busy = false;

  Future<void> _delete() async {
    if (_busy) return;
    setState(() => _busy = true);

    final MediaDeleteResult result = widget.result;
    try {
      if (widget.syncToServer) {
        // 契约入口：同步删除 → 删服务端文件 + 失效媒体列表/详情/游戏列表/统计。
        await ref
            .read(deleteMediaProvider.notifier)
            .run(widget.media, syncToServer: true);
        result.removed = true;
        result.message = '已删除（已同步服务器）';
      } else {
        // 关闭同步：只清本机三级缓存，服务端不动，也不失效列表（避免再次请求）。
        await ref
            .read(mediaActionsProvider)
            .delete(widget.media, syncToServer: false);
        result.removed = true;
        result.message = '已从本机缓存删除（未同步服务器）';
      }
    } on ApiException catch (e) {
      if (e.statusCode == 404) {
        // 404：服务器上已不存在该文件，视为删除完成，照常刷新列表。
        result.removed = true;
        result.message = '服务器上已不存在该文件，已从列表移除';
        _invalidate();
      } else if (e.statusCode == 401 || e.statusCode == 403) {
        result.needsLogin = true;
      } else {
        result.message = e.message.isEmpty ? '删除失败' : e.message;
      }
    } catch (error) {
      result.message = '删除失败：$error';
    }

    // 记录到共享的本地隐藏集合：网格/查看器/视频页立刻少一项，
    // 列表被重新拉取时也不会把已删项再显示出来。
    if (result.removed) {
      ref.read(locallyRemovedMediaIdsProvider.notifier).update(
            (Set<String> ids) => <String>{...ids, widget.media.id},
          );
    }

    if (mounted) Navigator.of(context).pop();
  }

  /// 404 时 provider 未自动失效（notifier 只在成功路径失效），这里补一次。
  void _invalidate() {
    try {
      ref.invalidate(gameMediaProvider(widget.media.gameId));
      ref.invalidate(gameDetailProvider(widget.media.gameId));
      ref.invalidate(gamesProvider);
      ref.invalidate(statsProvider);
    } catch (_) {
      // 容器已销毁等情况忽略：列表下次进入会重新拉取。
    }
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      // 删除请求进行中不允许返回，避免出现「已发起但用户以为取消」的状态。
      canPop: !_busy,
      child: AlertDialog(
        title: const Text('删除'),
        content: Text(_deleteConfirmMessage(widget.syncToServer)),
        actions: <Widget>[
          TextButton(
            onPressed: _busy ? null : () => Navigator.of(context).pop(),
            child: const Text('取消'),
          ),
          TextButton(
            onPressed: _busy ? null : _delete,
            style: TextButton.styleFrom(foregroundColor: const Color(0xFFFC6255)),
            child: _busy
                ? const SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(
                      strokeWidth: 2,
                      color: Color(0xFFFC6255),
                    ),
                  )
                : const Text('删除'),
          ),
        ],
      ),
    );
  }
}