// 服务器地址配置。
// 默认值来自编译期 `--dart-define=SCREENPLAY_API_URL=...`，运行时设置屏幕可覆盖，
// 并通过 shared_preferences 持久化（见 lib/widgets/settings_screen.dart）。

import 'package:flutter_riverpod/flutter_riverpod.dart';

/// shared_preferences 中保存服务器地址所用的键。
const String kServerUrlPrefsKey = 'screenplay_server_url';

/// 编译期默认服务器地址（未传 --dart-define 时为 http://localhost:3000）。
String defaultServerUrl() => const String.fromEnvironment(
      'SCREENPLAY_API_URL',
      defaultValue: 'http://localhost:3000',
    );

/// 去掉尾部斜杠，保证后续 URL 拼接不出现双斜杠。
String normalizeBaseUrl(String raw) {
  final String trimmed = raw.trim();
  if (trimmed.isEmpty) return defaultServerUrl();
  return trimmed.endsWith('/') ? trimmed.substring(0, trimmed.length - 1) : trimmed;
}

/// 当前服务器基地址（StateProvider：运行时修改会触发全部依赖重建并重新拉取）。
final StateProvider<String> serverConfigProvider =
    StateProvider<String>((ref) => defaultServerUrl());