// 应用前后台 / 快速滚动状态 → 供「低功耗」降级使用。
//
// 为什么需要：卡片工作流在后台时不应继续自动轮播、预加载海报；快速滚动时也不应
// 同时发起大量图片请求（容易把移动网络打满、掉帧）。统一由这三个 provider 表达，
// UI 只读不写，避免每处各自订阅 AppLifecycleState 造成行为不一致。

import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// 前台 / 后台。
enum AppForegroundState { foreground, background }

/// 当前前后台状态（由根组件的 observer 或其他工作流更新）。
final StateProvider<AppForegroundState> appLifecycleProvider =
    StateProvider<AppForegroundState>((ref) => AppForegroundState.foreground);

/// 是否在前台。
final Provider<bool> isForegroundProvider =
    Provider<bool>((ref) => ref.watch(appLifecycleProvider) == AppForegroundState.foreground);

/// 列表是否正在快速滚动（卡片据此推迟海报/图片加载）。
final StateProvider<bool> fastScrollingProvider =
    StateProvider<bool>((ref) => false);

/// 后台时应暂停的东西（自动轮播、预加载）统一读这个。
final Provider<bool> preloadAllowedProvider = Provider<bool>(
  (Ref ref) =>
      ref.watch(isForegroundProvider) && !ref.watch(fastScrollingProvider),
);

/// 便捷判断（需要显式传 ref；纯静态无法拿到 Riverpod 容器）。
class ForegroundGate {
  const ForegroundGate._();

  /// 当前是否允许做非必要工作（前台且不在快速滚动）。
  static bool allowed(WidgetRef ref) => ref.read(preloadAllowedProvider);

  /// 仅判断是否在前台。
  static bool isForeground(WidgetRef ref) => ref.read(isForegroundProvider);
}

/// 把 WidgetsBinding 的生命周期回调桥接到 [appLifecycleProvider]。
///
/// 用法（由根组件 / main.dart 接入，本工作流不改 main.dart）：
/// ```dart
/// class _AppState extends ConsumerState<ScreenPlayApp> with WidgetsBindingObserver {
///   @override
///   void didChangeAppLifecycleState(AppLifecycleState state) =>
///       ref.read(appLifecycleProvider.notifier).state = appForegroundStateOf(state);
/// }
/// ```
class AppLifecycleObserver with WidgetsBindingObserver {
  AppLifecycleObserver(this.onChange);

  final void Function(AppForegroundState state) onChange;

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) =>
      onChange(appForegroundStateOf(state));
}

/// [AppLifecycleState] → [AppForegroundState] 的唯一映射处。
/// inactive（来电、下拉通知栏等）按后台处理：此时也应当暂停预加载/轮播。
AppForegroundState appForegroundStateOf(AppLifecycleState state) {
  if (state == AppLifecycleState.resumed) return AppForegroundState.foreground;
  return AppForegroundState.background;
}