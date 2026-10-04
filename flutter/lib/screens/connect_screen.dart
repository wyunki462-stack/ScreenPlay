// 连接页：填写 / 校验服务器地址，并依据服务端类型决定「免登录直连」还是「去登录」。
//
// 为什么必须探测 /api/auth/session 的 enabled 字段来区分两种服务端：
//   - Linux 端（NAS）后端开启认证（APP_GUARD=AuthGuard），enabled=true，
//     安卓端必须像 Web 端一样登录系统账号（PAM）才能做写操作；
//   - Windows 桌面端内置后端在启动时注入 AUTH_DISABLED=1（见 windows/src-tauri
//     backend.rs），enabled=false，无需登录、直接 IP+端口即可连。
// 客户端无法从地址/端口推断是哪一端，唯一权威信号就是该字段，因此登录与否
// 由探测结果决定，而不是由用户手选。

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/api_client.dart';
import '../core/prefs.dart';
import '../core/server_config.dart';
import '../widgets/brand_mark.dart';

class ConnectScreen extends ConsumerStatefulWidget {
  const ConnectScreen({super.key});

  @override
  ConsumerState<ConnectScreen> createState() => _ConnectScreenState();
}

class _ConnectScreenState extends ConsumerState<ConnectScreen> {
  late final TextEditingController _controller;
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    // 默认填已保存地址（没有则用编译期/内置默认），减少用户输入。
    _controller = TextEditingController(text: ref.read(serverConfigProvider));
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  /// 连接主流程：健康检查 → 会话探测 → 分流。
  Future<void> _connect() async {
    if (_busy) return;
    final String url = normalizeBaseUrl(_controller.text);
    if (url.isEmpty) {
      setState(() => _error = '请输入服务器地址');
      return;
    }

    setState(() {
      _busy = true;
      _error = null;
    });

    // 连接过程中把全局地址切到目标地址，apiClientProvider 会随之重建。
    final String previousUrl = ref.read(serverConfigProvider);
    // 本页是否处在栈底：启动直接进连接页时为 true，从设置页「切换服务器」压栈进来时为 false。
    final bool isFirst = ModalRoute.of(context)?.isFirst ?? false;

    try {
      ref.read(serverConfigProvider.notifier).state = url;
      final ApiClient api = ref.read(apiClientProvider);

      // 1) 先探活：地址写错 / 服务没起来时给出明确的中文提示（含地址与原因）。
      try {
        await api.health();
      } on ApiException catch (e) {
        throw ApiException('无法连接到服务器 $url：${e.message}', statusCode: e.statusCode);
      }

      // 2) 探测服务端类型：enabled 是「是否需要登录」的唯一权威信号。
      final SessionInfo session = await api.session();

      // 地址已确认可达，落盘持久化，下次启动直接复用。
      final AppPrefs prefs = ref.read(appPrefsProvider);
      await prefs.setServerUrl(url);

      if (!session.enabled) {
        // Windows 桌面端：免登录。保存 windows 模式并清掉可能残留的旧凭证，
        // 避免拿着 Linux 端的 token 去访问不需要认证的后端。
        await prefs.clearSession();
        api.setAuthToken(null);
        ref.read(serverModeProvider.notifier).state = ServerMode.windows;
        // 清掉凭证后重建 ApiClient，确保不会把旧 token 发给免登录的 Windows 后端。
        ref.invalidate(apiClientProvider);
        if (!mounted) return;
        _goHome(isFirst);
        return;
      }

      // Linux 端：需要登录。保存 linux 模式；本地若仍有 token / 会话已认证则允许
      // 直接复用（会话可能仍然有效），否则去登录页。未登录一律不得进入首页。
      ref.read(serverModeProvider.notifier).state = ServerMode.linux;
      final bool hasCredential =
          (prefs.sessionToken ?? '').trim().isNotEmpty || session.authenticated;
      if (!mounted) return;
      if (hasCredential) {
        _goHome(isFirst);
      } else {
        _goLogin(isFirst);
      }
    } on ApiException catch (e) {
      // 失败：回滚内存中的地址，避免失败的地址污染其它页面的请求。
      ref.read(serverConfigProvider.notifier).state = previousUrl;
      if (!mounted) return;
      setState(() => _error = e.message);
    } catch (e) {
      ref.read(serverConfigProvider.notifier).state = previousUrl;
      if (!mounted) return;
      setState(() => _error = '连接失败：$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// 进首页：栈底替换，否则把连接页替换掉（避免用户返回又看到连接页）。
  void _goHome(bool isFirst) {
    if (isFirst) {
      Navigator.of(context).pushReplacementNamed('/');
    } else {
      Navigator.of(context).popAndPushNamed('/');
    }
  }

  /// 去登录页（同上策略）。
  void _goLogin(bool isFirst) {
    if (isFirst) {
      Navigator.of(context).pushReplacementNamed('/login');
    } else {
      Navigator.of(context).popAndPushNamed('/login');
    }
  }

  /// 未带协议时按 http 补全：绝大多数 NAS 局域网部署走明文 HTTP。
  void _usePlainHost() {
    final String raw = _controller.text.trim();
    if (raw.isEmpty) return;
    if (!raw.contains('://')) {
      setState(() => _controller.text = 'http://$raw');
    }
  }

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text('连接服务器')),
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: <Widget>[
          // 与 Web 端同一个品牌块（web/src/pages/Login.tsx:36-37），三端视觉一致。
          const Center(child: BrandMark(size: 64, shadow: true)),
          const SizedBox(height: 12),
          Text(
            '输入 ScreenPlay 服务地址',
            textAlign: TextAlign.center,
            style: theme.textTheme.titleLarge,
          ),
          const SizedBox(height: 8),
          Text(
            '支持 host、host:port 与 http(s):// 完整地址。\n'
            'Linux 端需要登录系统账号；Windows 端免登录直接连接。',
            textAlign: TextAlign.center,
            style: theme.textTheme.bodySmall?.copyWith(color: const Color(0xFF9E96B5)),
          ),
          const SizedBox(height: 20),
          TextField(
            controller: _controller,
            autofocus: true,
            keyboardType: TextInputType.url,
            textInputAction: TextInputAction.go,
            enabled: !_busy,
            decoration: const InputDecoration(
              labelText: '服务器地址',
              hintText: '例如 192.168.1.10:3000',
              prefixIcon: Icon(Icons.link),
            ),
            onSubmitted: (_) => _connect(),
          ),
          const SizedBox(height: 16),
          if (_busy)
            const Center(
              child: Padding(
                padding: EdgeInsets.all(8),
                child: CircularProgressIndicator(color: Color(0xFF00E5FF)),
              ),
            ),
          if (_error != null) ...<Widget>[
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: theme.colorScheme.error.withOpacity(0.12),
                borderRadius: BorderRadius.circular(10),
              ),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Icon(Icons.error_outline, color: theme.colorScheme.error, size: 20),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      _error!,
                      style: theme.textTheme.bodyMedium
                          ?.copyWith(color: theme.colorScheme.error),
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 12),
          ],
          SizedBox(
            height: 48, // 触控目标 ≥ 48dp
            child: FilledButton.icon(
              onPressed: _busy ? null : _connect,
              icon: const Icon(Icons.login),
              label: const Text('连接'),
            ),
          ),
          const SizedBox(height: 8),
          TextButton(
            onPressed: _busy ? null : _usePlainHost,
            child: const Text('补全为 http:// 前缀'),
          ),
          const SizedBox(height: 24),
          Text(
            '编译期默认值：${defaultServerUrl()}\n'
            '可通过 --dart-define=SCREENPLAY_API_URL=... 覆盖；此处保存后优先使用。',
            style: theme.textTheme.bodySmall?.copyWith(color: const Color(0xFF9E96B5)),
          ),
        ],
      ),
    );
  }
}