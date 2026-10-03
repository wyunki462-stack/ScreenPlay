// 本地偏好（SharedPreferences 收口）。
//
// 为什么单独建这个文件：1.3.1 起客户端需要持久化的东西变多了（服务器地址、
// 清晰度开关、删除同步开关、会话凭证、服务器模式）。原先 server_config.dart
// 只存地址。这里把全部读写集中到 AppPrefs，避免各屏幕各自 getInstance 导致
// 默认值/键名不一致（键名都是 `screenplay_` 前缀，便于排查）。

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'server_config.dart';

/// 服务器模式。
/// - [ServerMode.linux]：Linux/Web 端后端，媒体删除等写操作必须带会话凭证；
/// - [ServerMode.windows]：Windows 桌面端后端，免登录直连。
enum ServerMode { linux, windows }

/// WiFi 下是否加载原图。默认 true（开着更清晰；移动数据自动降级为预览图）。
const String kWifiOriginalPrefsKey = 'screenplay_load_original_on_wifi';

/// 删除媒体时是否同步删除服务器文件。默认 true。
const String kSyncDeletePrefsKey = 'screenplay_sync_delete_to_server';

/// 会话令牌（后端的 httpOnly cookie 值，这里本地留一份用于 Bearer/Cookie 双通道）。
const String kSessionTokenPrefsKey = 'screenplay_session_token';

/// 会话对应的登录用户名（用于设置页展示「已登录：xxx」）。
const String kSessionUserPrefsKey = 'screenplay_session_user';

/// 服务器模式（'linux' | 'windows'）。
const String kServerModePrefsKey = 'screenplay_server_mode';

/// [ServerMode] ↔ 持久化字符串。
String serverModeToString(ServerMode mode) =>
    mode == ServerMode.windows ? 'windows' : 'linux';

/// 持久化字符串 → [ServerMode]（未知值返回 null，交由调用方决定默认）。
ServerMode? serverModeFromString(String? raw) {
  switch (raw) {
    case 'linux':
      return ServerMode.linux;
    case 'windows':
      return ServerMode.windows;
    default:
      return null;
  }
}

/// 应用级本地偏好。全部经 SharedPreferences 读写。
class AppPrefs {
  AppPrefs._(this._prefs);

  final SharedPreferences _prefs;

  /// 一次性读取全部键（同步 getter 后续不再碰磁盘）。
  /// 缺省：wifiOriginal=true、syncDelete=true、serverMode 未设置=null。
  static Future<AppPrefs> load() async {
    final SharedPreferences prefs = await SharedPreferences.getInstance();
    return AppPrefs._(prefs);
  }

  /// 服务器基地址（未保存过则回退到编译期默认值）。
  String get serverUrl =>
      _prefs.getString(kServerUrlPrefsKey) ?? defaultServerUrl();

  String? get sessionToken => _prefs.getString(kSessionTokenPrefsKey);

  String? get sessionUser => _prefs.getString(kSessionUserPrefsKey);

  ServerMode? get serverMode =>
      serverModeFromString(_prefs.getString(kServerModePrefsKey));

  /// 是否 WiFi 下加载原图（开关关闭时任何网络都取原图）。
  bool get wifiOriginal => _prefs.getBool(kWifiOriginalPrefsKey) ?? true;

  /// 删除时是否同步删除服务器文件。
  bool get syncDelete => _prefs.getBool(kSyncDeletePrefsKey) ?? true;

  Future<void> setServerUrl(String url) =>
      _prefs.setString(kServerUrlPrefsKey, url);

  Future<void> setWifiOriginal(bool v) =>
      _prefs.setBool(kWifiOriginalPrefsKey, v);

  Future<void> setSyncDelete(bool v) =>
      _prefs.setBool(kSyncDeletePrefsKey, v);

  /// 登录成功后一次性写入令牌 + 用户名 + 服务器模式。
  Future<void> saveSession({
    required String token,
    required String user,
    required ServerMode mode,
  }) async {
    await _prefs.setString(kSessionTokenPrefsKey, token);
    await _prefs.setString(kSessionUserPrefsKey, user);
    await _prefs.setString(kServerModePrefsKey, serverModeToString(mode));
  }

  /// 登出 / 会话失效：清掉令牌与用户名（保留服务器模式与地址）。
  Future<void> clearSession() async {
    await _prefs.remove(kSessionTokenPrefsKey);
    await _prefs.remove(kSessionUserPrefsKey);
  }
}

/// 由 main.dart 用真实实例 override（`overrideWithValue(await AppPrefs.load())`）。
/// 未 override 时立即抛错，避免出现「静默用默认值」的假成功。
final Provider<AppPrefs> appPrefsProvider = Provider<AppPrefs>(
  (Ref ref) =>
      throw UnimplementedError('appPrefsProvider 需在 main.dart 里 override'),
);

/// 运行时可变的开关镜像（UI 直接 watch 这两个，改完再落盘 AppPrefs）。
final StateProvider<bool> wifiOriginalProvider =
    StateProvider<bool>((ref) => true);
final StateProvider<bool> syncDeleteProvider = StateProvider<bool>((ref) => true);

/// 当前服务器模式（null = 尚未探测/设置）。
final StateProvider<ServerMode?> serverModeProvider =
    StateProvider<ServerMode?>((ref) => null);