// ScreenPlay Flutter 客户端入口。
// 负责：加载本地偏好 → 注入 Riverpod 初始值 → 决定起始路由 → 深色主题与路由登记
// → 观察应用生命周期（低功耗：后台取消非必要网络请求）。

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'core/api_client.dart';
import 'core/app_lifecycle.dart';
import 'core/image_cache.dart';
import 'core/network_quality.dart';
import 'core/prefs.dart';
import 'core/server_config.dart';
import 'screens/connect_screen.dart';
import 'screens/game_detail_screen.dart';
import 'screens/home_screen.dart';
import 'screens/login_screen.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // 一次性读取全部本地偏好（地址 / 开关 / 会话 / 服务器模式）。
  final AppPrefs prefs = await AppPrefs.load();

  // 是否保存过地址：直接看原始 prefs 键，避免与「编译期默认值」混淆。
  // （AppPrefs.serverUrl 未保存时会回退默认值，无法区分「用户存过 localhost:3000」与「没存过」。）
  bool hasSavedUrl = false;
  try {
    final SharedPreferences rawPrefs = await SharedPreferences.getInstance();
    hasSavedUrl = (rawPrefs.getString(kServerUrlPrefsKey) ?? '').trim().isNotEmpty;
  } catch (_) {
    hasSavedUrl = false;
  }

  final String serverUrl = prefs.serverUrl;
  final ServerMode? storedMode = prefs.serverMode;
  final bool hasToken = (prefs.sessionToken ?? '').trim().isNotEmpty;

  // 起始路由判定（用户规格）：
  //   未保存过地址                          → 连接页
  //   已保存 + Windows 模式                 → 首页（免登录）
  //   已保存 + Linux 模式 + 无凭证          → 登录页（未登录不得进首页）
  //   已保存 + Linux 模式 + 有凭证 / 未知模式 → 首页（未知模式按免登录处理，可再被会话探测修正）
  final String initialRoute =
      hasSavedUrl ? initialRouteForMode(storedMode, hasToken) : '/connect';

  // 给 Flutter 内存图片缓存设上限（长列表 + 原图场景默认值偏大）。
  applyImageMemoryLimits();

  // ProviderContainer 显式构造：先注入初始值，再读一次网络服务启动监听。
  final ProviderContainer container = ProviderContainer(
    overrides: <Override>[
      appPrefsProvider.overrideWithValue(prefs),
      // 注意：riverpod 2.6.1 里 `overrideWithValue` 只存在于 Provider，
      // StateProvider 必须用 `overrideWith((ref) => 初值)`。
      serverConfigProvider.overrideWith((Ref ref) => serverUrl),
      wifiOriginalProvider.overrideWith((Ref ref) => prefs.wifiOriginal),
      syncDeleteProvider.overrideWith((Ref ref) => prefs.syncDelete),
      serverModeProvider.overrideWith((Ref ref) => storedMode),
      // 冷启动必须把已保存的会话令牌注入 ApiClient，否则 Linux 模式重启后
      // 首个请求没有凭证 → 401 → 被踢回登录页（会话其实还有效）。
      // apiClientProvider 默认只传 baseUrl（见 core/api_client.dart:70-72），
      // 这里补上 authToken；仍 watch serverConfigProvider，保证切换地址时重建。
      apiClientProvider.overrideWith((Ref ref) {
        final String raw = (ref.watch(appPrefsProvider).sessionToken ?? '').trim();
        return ApiClient(
          baseUrl: ref.watch(serverConfigProvider),
          authToken: raw.isEmpty ? null : raw,
        );
      }),
    ],
  );
  // 网络类型服务：不 start 的话 WiFi/移动数据永远停在「保守默认 WiFi」，
  // 清晰度开关就失效了。这里显式启动一次（幂等）。订阅随容器存活。
  unawaited(container.read(networkQualityProvider).start());

  runApp(
    UncontrolledProviderScope(
      container: container,
      child: ScreenPlayApp(initialRoute: initialRoute),
    ),
  );
}

/// 起始路由的纯函数分支（便于排查「为什么启动去了某一页」）。
String initialRouteForMode(ServerMode? mode, bool hasToken) {
  if (mode == ServerMode.windows) return '/';
  if (mode == ServerMode.linux) return hasToken ? '/' : '/login';
  // 模式未知（首次连接前）：按免登录处理，实际请求若 401 会再被送回登录页。
  return '/';
}

/// 应用根组件：持有生命周期观察者（需 ref，故用 ConsumerStatefulWidget）。
class ScreenPlayApp extends ConsumerStatefulWidget {
  const ScreenPlayApp({super.key, required this.initialRoute});

  final String initialRoute;

  @override
  ConsumerState<ScreenPlayApp> createState() => _ScreenPlayAppState();
}

class _ScreenPlayAppState extends ConsumerState<ScreenPlayApp>
    with WidgetsBindingObserver {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final AppForegroundState next = appForegroundStateOf(state);

    // 低功耗边界：仅在「前台 → 后台」这一次跳变时取消请求，
    // 避免 inactive/paused/hidden 连续回调时重复取消。
    final bool wasForeground =
        ref.read(appLifecycleProvider) == AppForegroundState.foreground;
    ref.read(appLifecycleProvider.notifier).state = next;

    if (next == AppForegroundState.background && wasForeground) {
      // 退到后台：取消所有非必要网络请求（图片预加载、海报轮播等）。
      // try/catch 兜底：此时可能处于首个 frame 前的极短窗口，provider 尚未就绪。
      try {
        final ApiClient api = ref.read(apiClientProvider);
        api.cancelNonEssential();
      } catch (_) {
        // 忽略：没有活跃客户端时无需取消。
      }
    }
    // 回到前台不在此处强行刷新数据：由各页面按需读取 isForegroundProvider 决定，
    // 避免回前台瞬间并发发起大量请求。
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'ScreenPlay',
      debugShowCheckedModeBanner: false,
      theme: _buildDarkTheme(),
      initialRoute: widget.initialRoute,
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

  /// 手工解析路由，支持带路径参数 `/game/:id`，以及固定名的连接 / 登录页。
  Route<dynamic>? _onGenerateRoute(RouteSettings settings) {
    final String name = settings.name ?? '/';

    if (name == '/connect') {
      return MaterialPageRoute<dynamic>(
        settings: settings,
        builder: (BuildContext context) => const ConnectScreen(),
      );
    }

    if (name == '/login') {
      return MaterialPageRoute<dynamic>(
        settings: settings,
        builder: (BuildContext context) => const LoginScreen(),
      );
    }

    if (name == '/') {
      return MaterialPageRoute<dynamic>(
        settings: settings,
        // 包一层会话守卫：Linux 模式下若本地凭证已失效（token 过期/吊销），
        // 进首页时复查一次并把用户送回登录页。home_screen 属其它工作流，
        // 在其路由构造处兜底是唯一能覆盖该场景、又不越界的做法。
        builder: (BuildContext context) => const HomeGate(),
      );
    }

    final RegExpMatch? match = RegExp(r'^/game/([^/]+)$').firstMatch(name);
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
      builder: (BuildContext context) => const HomeGate(),
    );
  }
}

/// 首页会话守卫（Linux 端「未登录却进首页」的兜底路径）。
///
/// 触发条件（必须同时满足，避免误踢 / 死循环）：
///   1. 当前为 Linux 模式（Windows 端免登录，直接放行）；
///   2. 本地存在非空会话令牌（说明「登录过」）；
///   3. 服务端判定未认证（`session().authenticated == false`）或明确回 401/403。
///
/// 为什么加上「非空令牌」这一条：本客户端没有 cookie jar，登录若拿不到 token
/// 就真的没有任何凭证；若此时也把用户踢回登录页，会导致「登录 → 首页 → 登录」
/// 死循环。因此仅在「有过凭证但已失效」时清会话回登录页；从没登录过的情况
/// 由起始路由（main() 的 initialRouteForMode）拦在登录页。
class HomeGate extends ConsumerStatefulWidget {
  const HomeGate({super.key});

  @override
  ConsumerState<HomeGate> createState() => _HomeGateState();
}

class _HomeGateState extends ConsumerState<HomeGate> {
  bool _probing = false;

  @override
  void initState() {
    super.initState();
    // 首帧之后再探测，避免在 build 期间读写 provider / 触发导航。
    WidgetsBinding.instance.addPostFrameCallback((_) => _verifySession());
  }

  Future<void> _verifySession() async {
    if (_probing) return;
    _probing = true;

    final AppPrefs prefs = ref.read(appPrefsProvider);
    final ServerMode? mode =
        ref.read(serverModeProvider) ?? prefs.serverMode;

    // Windows / 未探测模式：无需登录，放行。
    if (mode != ServerMode.linux) return;

    final bool hasToken = (prefs.sessionToken ?? '').trim().isNotEmpty;
    // 无令牌：不在此处踢人（见类注释，防死循环）。
    if (!hasToken) return;

    try {
      final SessionInfo info = await ref.read(apiClientProvider).session();
      if (!mounted) return;
      if (!info.authenticated) {
        await _expireSession();
      }
    } on ApiException catch (e) {
      if (!mounted) return;
      // 只有明确的身份拒绝才判定失效；网络错误（statusCode 为空）不误踢。
      if (e.statusCode == 401 || e.statusCode == 403) {
        await _expireSession();
      }
    } catch (_) {
      // 其它异常忽略，保持在首页。
    }
  }

  /// 清本地会话 + 内存凭证，并回登录页（一次，不重试，避免 401 死循环）。
  Future<void> _expireSession() async {
    final AppPrefs prefs = ref.read(appPrefsProvider);
    await prefs.clearSession();
    try {
      ref.read(apiClientProvider).setAuthToken(null);
    } catch (_) {
      // 忽略：即使这里失败也已清掉持久化凭证。
    }
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('登录已失效，请重新登录')),
    );
    Navigator.of(context).pushNamedAndRemoveUntil(
      '/login',
      (Route<dynamic> route) => false,
    );
  }

  @override
  Widget build(BuildContext context) => const HomeScreen();
}