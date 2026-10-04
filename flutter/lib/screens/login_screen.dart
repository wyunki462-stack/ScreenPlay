// 登录页：Linux 端后端需要系统账号（PAM）会话，登录成功后才能进入首页。
//
// 会话凭证说明（空 token 的兜底，重要）：
// 后端登录成功时通过 `Set-Cookie: screenplay_session=…` 下发 httpOnly cookie，
// 响应体里不含 token。core 的 `login()` 会从 set-cookie 头里提取 token 字符串，
// **可能返回空串**（例如拿不到 set-cookie 头时）。
//
// 关键事实：本客户端**没有 cookie jar**（`ApiClient` 只是在请求头里手动回带
// `Cookie: screenplay_session=<token>`，见 core/api_client.dart:94-105）。
// 因此 token 为空时，实际上没有可用于后续请求的凭证。这里仍按「2xx 即成功」
// 处理（不把空 token 当失败），并提示用户；真正的失效会由首页守卫
// （main.dart 的 HomeGate）在后续请求 401 时把用户送回登录页，不会死循环。
//
// 待办（已上报父代理）：让 core 层接入 dio_cookie_manager/cookie_jar，或让
// 后端在响应体里回传 token，空 token 场景才真正可用。

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/api_client.dart';
import '../core/prefs.dart';
import '../providers/api_providers.dart';
import '../widgets/brand_mark.dart';

class LoginScreen extends ConsumerStatefulWidget {
  const LoginScreen({super.key});

  @override
  ConsumerState<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends ConsumerState<LoginScreen> {
  final TextEditingController _userController = TextEditingController();
  final TextEditingController _passController = TextEditingController();

  /// 记住我（默认开）：对应后端 `remember` 字段 → 会话有效期更长。
  bool _remember = true;
  bool _busy = false;
  bool _obscure = true;
  String? _error;

  @override
  void dispose() {
    _userController.dispose();
    _passController.dispose();
    super.dispose();
  }

  Future<void> _login() async {
    if (_busy) return;
    final String username = _userController.text.trim();
    final String password = _passController.text;

    if (username.isEmpty) {
      setState(() => _error = '请输入用户名');
      return;
    }
    if (password.isEmpty) {
      setState(() => _error = '请输入密码');
      return;
    }

    setState(() {
      _busy = true;
      _error = null;
    });

    final bool isFirst = ModalRoute.of(context)?.isFirst ?? false;

    try {
      final ApiClient api = ref.read(apiClientProvider);
      // 成功返回可当凭证的 token 字符串（可能为空串，见文件头说明）。
      final String token = await api.login(
        username: username,
        password: password,
        remember: _remember,
      );

      // 空 token 也按成功处理（见文件头说明）；但本客户端无 cookie jar，
      // 此时并无真正凭证，给用户一句提示以便排查。
      api.setAuthToken(token.isEmpty ? null : token);

      final AppPrefs prefs = ref.read(appPrefsProvider);
      // 当前模式优先取内存镜像，其次取持久化值，最后兜底 linux。
      final ServerMode mode = ref.read(serverModeProvider) ??
          prefs.serverMode ??
          ServerMode.linux;
      await prefs.saveSession(token: token, user: username, mode: mode);
      ref.read(serverModeProvider.notifier).state = mode;

      // 凭证已落盘，让 apiClientProvider 重建以带上新 token（否则后续请求
      // 仍可能复用旧实例），并刷新会话状态缓存供其它页面读取。
      ref.invalidate(apiClientProvider);
      ref.invalidate(sessionProvider);

      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            token.isEmpty
                ? '已登录，但未取到会话令牌，写操作可能需要重新登录'
                : '已登录：$username',
          ),
        ),
      );
      _goHome(isFirst);
    } on ApiException catch (e) {
      // 只展示后端 message（中文），绝不回显密码；也不把输入的密码拼进任何提示。
      if (!mounted) return;
      setState(() => _error = e.message);
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = '登录失败：$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _goHome(bool isFirst) {
    if (isFirst) {
      Navigator.of(context).pushReplacementNamed('/');
    } else {
      Navigator.of(context).popAndPushNamed('/');
    }
  }

  /// 回连接页换一个服务器。
  void _backToConnect() {
    Navigator.of(context).pushReplacementNamed('/connect');
  }

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(
        title: const Text('登录'),
        leading: IconButton(
          tooltip: '切换服务器',
          icon: const Icon(Icons.arrow_back),
          onPressed: _busy ? null : _backToConnect,
        ),
      ),
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: <Widget>[
          // 与 Web 登录页同一个品牌块（web/src/pages/Login.tsx:36-37）。
          const Center(child: BrandMark(size: 64, shadow: true)),
          const SizedBox(height: 12),
          Text(
            '登录 ScreenPlay',
            textAlign: TextAlign.center,
            style: theme.textTheme.titleLarge,
          ),
          const SizedBox(height: 8),
          Text(
            '使用 Linux 端系统账号登录（与 Web 端一致）。',
            textAlign: TextAlign.center,
            style: theme.textTheme.bodySmall?.copyWith(color: const Color(0xFF9E96B5)),
          ),
          const SizedBox(height: 20),
          TextField(
            controller: _userController,
            enabled: !_busy,
            textInputAction: TextInputAction.next,
            autofillHints: const <String>[AutofillHints.username],
            decoration: const InputDecoration(
              labelText: '用户名',
              prefixIcon: Icon(Icons.person_outline),
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _passController,
            enabled: !_busy,
            obscureText: _obscure,
            textInputAction: TextInputAction.done,
            autofillHints: const <String>[AutofillHints.password],
            decoration: InputDecoration(
              labelText: '密码',
              prefixIcon: const Icon(Icons.key_outlined),
              suffixIcon: IconButton(
                tooltip: _obscure ? '显示密码' : '隐藏密码',
                icon: Icon(_obscure ? Icons.visibility_off : Icons.visibility),
                onPressed: () => setState(() => _obscure = !_obscure),
              ),
            ),
            onSubmitted: (_) => _login(),
          ),
          const SizedBox(height: 4),
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            value: _remember,
            onChanged: _busy ? null : (bool v) => setState(() => _remember = v),
            title: const Text('记住我'),
            subtitle: const Text('延长登录有效期，适合个人手机'),
          ),
          if (_error != null) ...<Widget>[
            const SizedBox(height: 8),
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
          ],
          const SizedBox(height: 20),
          SizedBox(
            height: 48, // 触控目标 ≥ 48dp
            child: FilledButton.icon(
              onPressed: _busy ? null : _login,
              icon: _busy
                  ? const SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.login),
              label: Text(_busy ? '登录中…' : '登录'),
            ),
          ),
        ],
      ),
    );
  }
}