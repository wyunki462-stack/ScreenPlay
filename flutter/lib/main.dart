// ScreenPlay Flutter 客户端入口。
// 负责：加载持久化的服务器地址 → ProviderScope → 深色 MaterialApp → 路由登记。

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'core/server_config.dart';
import 'screens/game_detail_screen.dart';
import 'screens/home_screen.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // 启动时读取持久化的服务器地址；若此前未保存则回退到编译期 / 内置默认值。
  String? storedUrl;
  try {
    final SharedPreferences prefs = await SharedPreferences.getInstance();
    storedUrl = prefs.getString(kServerUrlPrefsKey);
  } catch (_) {
    // shared_preferences 读取失败（极少数平台问题）时静默回退默认值。
    storedUrl = null;
  }

  runApp(
    ProviderScope(
      overrides: <Override>[
        // 以持久化地址覆盖默认值；回调参数类型由 overrideWith 推断。
        serverConfigProvider.overrideWith(
          (ref) => storedUrl ?? defaultServerUrl(),
        ),
      ],
      child: const ScreenPlayApp(),
    ),
  );
}

/// 应用根组件。
class ScreenPlayApp extends StatelessWidget {
  const ScreenPlayApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'ScreenPlay',
      debugShowCheckedModeBanner: false,
      theme: _buildDarkTheme(),
      initialRoute: '/',
      onGenerateRoute: _onGenerateRoute,
    );
  }

  /// 深色「游戏图库」主题：紫罗兰种子色 + 青色强调，Material 3。
  ThemeData _buildDarkTheme() {
    final ColorScheme scheme = ColorScheme.fromSeed(
      seedColor: const Color(0xFF7C4DFF), // 紫罗兰
      brightness: Brightness.dark,
    ).copyWith(
      secondary: const Color(0xFF00E5FF), // 青色
      surface: const Color(0xFF14121A),
    );

    return ThemeData(
      useMaterial3: true,
      colorScheme: scheme,
      scaffoldBackgroundColor: const Color(0xFF0E0C14),
      appBarTheme: const AppBarTheme(
        centerTitle: false,
        elevation: 0,
        backgroundColor: Colors.transparent,
      ),
      cardTheme: CardTheme(
        elevation: 0,
        color: const Color(0xFF1B1826),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(14),
        ),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: const Color(0xFF1B1826),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: BorderSide.none,
        ),
      ),
      dividerTheme: const DividerThemeData(
        color: Color(0xFF2A2637),
        thickness: 1,
      ),
    );
  }

  /// 手工解析路由，支持带路径参数 `/game/:id`。
  Route<dynamic>? _onGenerateRoute(RouteSettings settings) {
    final String name = settings.name ?? '/';
    if (name == '/') {
      return MaterialPageRoute<dynamic>(
        settings: settings,
        builder: (BuildContext context) => const HomeScreen(),
      );
    }

    final RegExpMatch? match =
        RegExp(r'^/game/([^/]+)$').firstMatch(name);
    if (match != null) {
      final String gameId = Uri.decodeComponent(match.group(1)!);
      return MaterialPageRoute<dynamic>(
        settings: settings,
        builder: (BuildContext context) => GameDetailScreen(gameId: gameId),
      );
    }

    // 未知路由回退首页。
    return MaterialPageRoute<dynamic>(
      settings: settings,
      builder: (BuildContext context) => const HomeScreen(),
    );
  }
}