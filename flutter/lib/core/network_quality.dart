// 网络质量 / 取图清晰度策略。
//
// 为什么需要：移动数据下加载原图（可能几 MB）会明显卡顿且耗流量；WiFi 下取原图
// 画质更好。这里的 Service 只做「当前是否 WiFi/以太网」的判断，具体取预览图还是
// 原图由 mediaQualityProvider 统一决策，UI 侧不需要各自读 connectivity。

import 'dart:async';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'prefs.dart';

/// 取图清晰度。
/// - [MediaQuality.preview]：后端生成的预览图（体积小、加载快）；
/// - [MediaQuality.original]：原始文件（画质最好，体积最大）。
enum MediaQuality { preview, original }

/// 网络类型监听服务（基于 connectivity_plus）。
///
/// 实现说明：connectivity_plus 5.x 的事件是单个 [ConnectivityResult]，6.x 起是
/// `List<ConnectivityResult>`（可能同时 wifi + vpn）。为了在两种大版本下都能编译
/// 运行，这里通过 dynamic 取事件再按「是否 List」分支处理，避免被插件版本绑死。
class NetworkQualityService {
  NetworkQualityService({Connectivity? connectivity})
      : _connectivity = connectivity ?? Connectivity();

  final Connectivity _connectivity;
  StreamSubscription<dynamic>? _sub;
  final StreamController<bool> _controller = StreamController<bool>.broadcast();

  /// 保守默认：未探测到前按 WiFi 处理（宁可先取原图，也不要一上来就降质）。
  bool _isWifi = true;

  /// 订阅网络变化并初始化当前状态（幂等，重复调用不会重复订阅）。
  Future<void> start() async {
    if (_sub == null) {
      final dynamic raw = _connectivity.onConnectivityChanged;
      _sub = (raw as Stream<dynamic>).listen(_onEvent);
    }
    await _refresh();
  }

  Future<void> _refresh() async {
    try {
      final dynamic current = await _connectivity.checkConnectivity();
      _updateFromEvent(current);
    } catch (_) {
      // 查询失败时保持上一次状态，不因为插件异常打断启动流程。
    }
  }

  void _onEvent(dynamic event) => _updateFromEvent(event);

  void _updateFromEvent(dynamic event) {
    final bool wifi = _isWifiEvent(event);
    if (wifi == _isWifi) return;
    _isWifi = wifi;
    if (!_controller.isClosed) _controller.add(wifi);
  }

  /// 单个 ConnectivityResult 是否算「高带宽」（wifi / ethernet）。
  /// mobile、none、vpn、bluetooth、other 一律为 false。
  bool _isWifiResult(dynamic result) =>
      result == ConnectivityResult.wifi || result == ConnectivityResult.ethernet;

  /// 兼容 5.x（单值）与 6.x+（列表）两种事件形态。
  bool _isWifiEvent(dynamic event) {
    if (event is List) return event.any(_isWifiResult);
    return _isWifiResult(event);
  }

  /// 当前是否 WiFi/以太网。
  bool get isWifi => _isWifi;

  /// 网络类型变化流（每个订阅者都会先收到当前值，再收到后续变化）。
  Stream<bool> get wifiChanges async* {
    yield _isWifi;
    yield* _controller.stream;
  }

  void dispose() {
    _sub?.cancel();
    _sub = null;
    _controller.close();
  }
}

/// 全局单例（provider 销毁时自动释放底层订阅）。
final Provider<NetworkQualityService> networkQualityProvider =
    Provider<NetworkQualityService>((Ref ref) {
  final NetworkQualityService service = NetworkQualityService();
  ref.onDispose(service.dispose);
  return service;
});

/// 当前网络是否 WiFi（响应式：随 connectivity 事件更新）。
final StreamProvider<bool> isWifiProvider = StreamProvider<bool>(
  (Ref ref) => ref.watch(networkQualityProvider).wifiChanges,
);

/// 取图清晰度策略（已与用户确认语义，勿改）：
///  - 开关 wifiOriginal 开启（默认）：WiFi/以太网 → original；移动数据 → preview；
///  - 开关关闭：无论什么网络都 → original（用户主动要求原图，尊重之）。
final Provider<MediaQuality> mediaQualityProvider = Provider<MediaQuality>(
  (Ref ref) {
    final NetworkQualityService service = ref.watch(networkQualityProvider);
    if (!ref.watch(wifiOriginalProvider)) return MediaQuality.original;
    final bool wifi = ref.watch(isWifiProvider).maybeWhen(
          data: (bool v) => v,
          // 首帧未到达时退回服务当前值，避免闪一下 preview。
          orElse: () => service.isWifi,
        );
    return wifi ? MediaQuality.original : MediaQuality.preview;
  },
);