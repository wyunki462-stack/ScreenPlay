// Riverpod 数据层：FutureProvider 负责只读数据，AsyncNotifier 承载扫描 / 刷新等
// 变更操作，并在成功后自动 invalidate 相关缓存以触发重新拉取。

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/api_client.dart';
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

  /// 强制刷新给定游戏；完成后刷新该游戏详情。
  Future<void> run(String gameId, {List<String>? providers}) async {
    state = const AsyncLoading<void>();
    state = await AsyncValue.guard<void>(() async {
      await ref.read(apiClientProvider).refreshGame(gameId, providers: providers);
      ref.invalidate(gameDetailProvider(gameId));
      ref.invalidate(gamesProvider);
    });
  }
}