// Riverpod 数据层：FutureProvider 负责只读数据，AsyncNotifier 承载扫描 / 刷新等
// 变更操作，并在成功后自动 invalidate 相关缓存以触发重新拉取。

import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/api_client.dart';
import '../core/media_actions.dart';
import '../core/network_quality.dart';
import '../models/models.dart';

/// 游戏列表（按过滤条件分族，条件相等时复用缓存；离开首页自动释放）。
final AutoDisposeFutureProviderFamily<List<GameSummary>, GameFilter> gamesProvider =
    FutureProvider.autoDispose.family<List<GameSummary>, GameFilter>(
  (AutoDisposeFutureProviderRef<List<GameSummary>> ref, GameFilter filter) {
    return ref.watch(apiClientProvider).games(filter);
  },
);

/// 游戏详情（按 id 分族）。
final FutureProviderFamily<GameDetail, String> gameDetailProvider =
    FutureProvider.family<GameDetail, String>(
  (FutureProviderRef<GameDetail> ref, String id) =>
      ref.watch(apiClientProvider).game(id),
);

/// 游戏媒体列表（按 gameId 分族）。
final FutureProviderFamily<List<Media>, String> gameMediaProvider =
    FutureProvider.family<List<Media>, String>(
  (FutureProviderRef<List<Media>> ref, String gameId) =>
      ref.watch(apiClientProvider).media(gameId),
);

/// 游戏成就列表（按 gameId 分族）。
final FutureProviderFamily<List<Achievement>, String> achievementsProvider =
    FutureProvider.family<List<Achievement>, String>(
  (FutureProviderRef<List<Achievement>> ref, String gameId) =>
      ref.watch(apiClientProvider).achievements(gameId),
);

/// 游戏媒体评价（按 gameId 分族）。
///
/// 后端 `GET /api/games/:id/media-reviews` 返回 `{ reviews, summary }`；详情页「评分」
/// tab 内的媒体评价区块消费它（Web 端由 `MediaReviewsPanel` 消费同一契约）。
final FutureProviderFamily<MediaReviewsResult, String> mediaReviewsProvider =
    FutureProvider.family<MediaReviewsResult, String>(
  (Ref ref, String gameId) =>
      ref.watch(apiClientProvider).mediaReviews(gameId),
);

/// 全局统计。
final FutureProvider<Stats> statsProvider = FutureProvider<Stats>(
  (FutureProviderRef<Stats> ref) => ref.watch(apiClientProvider).stats(),
);

/// 扫描状态。
final FutureProvider<LibraryStatus> libraryStatusProvider = FutureProvider<LibraryStatus>(
  (FutureProviderRef<LibraryStatus> ref) => ref.watch(apiClientProvider).libraryStatus(),
);

/// 扫描变更（含进行中状态）。
final AsyncNotifierProvider<ScanLibraryNotifier, void> scanLibraryProvider =
    AsyncNotifierProvider<ScanLibraryNotifier, void>(ScanLibraryNotifier.new);

class ScanLibraryNotifier extends AsyncNotifier<void> {
  @override
  Future<void> build() async {}

  /// 触发重新扫描；完成后刷新状态与列表缓存。
  Future<void> run() async {
    state = const AsyncLoading<void>();
    state = await AsyncValue.guard<void>(() async {
      await ref.read(apiClientProvider).scan();
      ref.invalidate(libraryStatusProvider);
      ref.invalidate(gamesProvider);
      ref.invalidate(statsProvider);
    });
  }
}

/// 强制刷新指定游戏元数据（含进行中状态）。
final AsyncNotifierProvider<RefreshGameNotifier, void> refreshGameProvider =
    AsyncNotifierProvider<RefreshGameNotifier, void>(RefreshGameNotifier.new);

class RefreshGameNotifier extends AsyncNotifier<void> {
  @override
  Future<void> build() async {}

  /// 强制刷新给定游戏；完成后刷新该游戏详情、媒体、成就与媒体评价。
  ///
  /// 覆盖面对齐后端能力：除了 `POST /api/games/:id/refresh`（元数据），
  /// 还调用 `POST /api/games/:id/achievements/refresh` 与
  /// `POST /api/games/:id/media-reviews/refresh` 两个独立端点，并 invalidate
  /// 媒体列表（媒体无独立刷新端点，invalidate 后重新拉取）。
  /// 两个附加端点用 try/catch 包成「尽力而为」：数据源不可达或平台不支持时
  /// 不应把整次刷新显示成失败（元数据其实已刷新成功）。
  Future<void> run(String gameId, {List<String>? providers}) async {
    state = const AsyncLoading<void>();
    state = await AsyncValue.guard<void>(() async {
      final ApiClient api = ref.read(apiClientProvider);
      await api.refreshGame(gameId, providers: providers);
      try {
        await api.refreshAchievements(gameId);
      } catch (_) {
        // 尽力而为：失败不影响主刷新结果。
      }
      try {
        await api.refreshMediaReviews(gameId);
      } catch (_) {
        // 尽力而为：失败不影响主刷新结果。
      }
      ref.invalidate(gameDetailProvider(gameId));
      ref.invalidate(gamesProvider);
      ref.invalidate(gameMediaProvider(gameId));
      ref.invalidate(achievementsProvider(gameId));
      ref.invalidate(mediaReviewsProvider(gameId));
    });
  }
}

/// 海报列表（按 gameId 分族）。
///
/// staleTime 取 5 分钟：海报变更频率低，短时间内重复进入详情页不应反复请求；
/// 但超过 5 分钟后释放缓存（关闭 keepAlive + invalidateSelf）以便拿到最新数据。
/// 选中封面 / 增删海报后由调用方显式 `ref.invalidate(postersProvider(gameId))`。
final AutoDisposeFutureProviderFamily<List<Poster>, String> postersProvider =
    FutureProvider.autoDispose.family<List<Poster>, String>(
  (Ref ref, String gameId) {
    final KeepAliveLink link = ref.keepAlive();
    final Timer staleTimer = Timer(const Duration(minutes: 5), () {
      link.close();
      ref.invalidateSelf();
    });
    ref.onDispose(staleTimer.cancel);
    return ref.watch(apiClientProvider).listPosters(gameId);
  },
);

/// 后端会话状态（`GET /api/auth/session`）。
///
/// 登录 / 登出后请务必 `ref.invalidate(sessionProvider)` **并重建 ApiClient**
/// （`apiClientProvider` 只依赖服务端地址，凭证要靠 main.dart override 传入
/// `ApiClient(baseUrl: ..., authToken: prefs.sessionToken)`），否则新 token 不会生效。
final FutureProvider<SessionInfo> sessionProvider = FutureProvider<SessionInfo>(
  (Ref ref) => ref.watch(apiClientProvider).session(),
);

/// 自定义排序变更（含进行中状态）。
final AsyncNotifierProvider<ReorderGamesNotifier, void> reorderGamesProvider =
    AsyncNotifierProvider<ReorderGamesNotifier, void>(ReorderGamesNotifier.new);

class ReorderGamesNotifier extends AsyncNotifier<void> {
  @override
  Future<void> build() async {}

  /// 把 [gameId] 移到 [beforeId] 之前或 [afterId] 之后（都为空 = 移到末尾）。
  /// 成功后失效游戏列表与详情缓存（列表顺序即由自定义顺序决定）。
  Future<void> run({
    required String gameId,
    String? beforeId,
    String? afterId,
  }) async {
    state = const AsyncLoading<void>();
    state = await AsyncValue.guard<void>(() async {
      await ref.read(apiClientProvider).reorderGames(
            gameId: gameId,
            beforeId: beforeId,
            afterId: afterId,
          );
      ref.invalidate(gamesProvider);
      ref.invalidate(gameDetailProvider(gameId));
    });
  }
}

/// 删除媒体变更（含进行中状态）。
final AsyncNotifierProvider<DeleteMediaNotifier, void> deleteMediaProvider =
    AsyncNotifierProvider<DeleteMediaNotifier, void>(DeleteMediaNotifier.new);

class DeleteMediaNotifier extends AsyncNotifier<void> {
  @override
  Future<void> build() async {}

  /// 删除媒体：本地三级缓存必清；[syncToServer]=true 时再同步删服务器文件。
  ///
  /// 注意这里是「先抛后置态」而不是 `AsyncValue.guard`：
  /// 同步删除失败（尤其 401 = 需要登录 Linux 端账号）必须把 ApiException 抛给 UI 提示，
  /// guard 会把异常吞进 state 里，调用方就拿不到带中文说明的报错。
  Future<DeleteOutcome> run(Media media, {required bool syncToServer}) async {
    state = const AsyncLoading<void>();
    try {
      final DeleteOutcome outcome = await ref
          .read(mediaActionsProvider)
          .delete(media, syncToServer: syncToServer);
      // 删除成功后媒体列表 / 游戏详情（内含媒体计数）/ 全局列表与统计都会变。
      ref.invalidate(gameMediaProvider(media.gameId));
      ref.invalidate(gameDetailProvider(media.gameId));
      ref.invalidate(gamesProvider);
      ref.invalidate(statsProvider);
      state = const AsyncData<void>(null);
      return outcome;
    } catch (error, stackTrace) {
      state = AsyncError<void>(error, stackTrace);
      rethrow;
    }
  }
}

/// 当前清晰度（[mediaQualityProvider] 的只读别名，方便设置页按语义引用）。
final Provider<MediaQuality> imageQualityProvider = Provider<MediaQuality>(
  (Ref ref) => ref.watch(mediaQualityProvider),
);

/// 「当前取图 URL 选择器」签名：`thumb=true` 强制缩略图。
typedef PickImageUrl = String Function(Media media, {bool thumb});

/// 取图 URL 选择器：把清晰度策略收敛到一处，卡片 / 相册只调它，不各自判断网络。
///
///  - `thumb=true`：始终缩略图（列表小图 / 快速滚动降级时用）；
///  - 否则按 [mediaQualityProvider]：原图（视频走 stream，否则 original）/ 预览图。
/// 这样「WiFi 原图、移动数据预览、关开关全原图」的策略只实现一次。
final Provider<PickImageUrl> pickImageUrlProvider = Provider<PickImageUrl>(
  (Ref ref) {
    final MediaQuality quality = ref.watch(mediaQualityProvider);
    final ApiClient api = ref.watch(apiClientProvider);
    return (Media media, {bool thumb = false}) {
      if (thumb) return api.mediaUrl(media.id, variant: MediaVariant.thumbnail);
      if (quality == MediaQuality.original) {
        return media.type == MediaType.video
            ? api.mediaUrl(media.id, variant: MediaVariant.stream)
            : api.mediaUrl(media.id, variant: MediaVariant.original);
      }
      return api.mediaUrl(media.id, variant: MediaVariant.preview);
    };
  },
);