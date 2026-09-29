// 设置屏幕：运行时修改服务器地址（立即生效并持久化到 shared_preferences）。

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../core/server_config.dart';

class SettingsScreen extends ConsumerStatefulWidget {
  const SettingsScreen({super.key});

  @override
  ConsumerState<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends ConsumerState<SettingsScreen> {
  late final TextEditingController _controller;

  @override
  void initState() {
    super.initState();
    _controller = TextEditingController(text: ref.read(serverConfigProvider));
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final String normalized = normalizeBaseUrl(_controller.text);
    ref.read(serverConfigProvider.notifier).state = normalized;

    // 持久化（最佳努力：失败仅提示，不影响本次会话内生效）。
    try {
      final SharedPreferences prefs = await SharedPreferences.getInstance();
      await prefs.setString(kServerUrlPrefsKey, normalized);
    } catch (_) {
      // 忽略持久化失败。
    }

    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('服务器地址已保存并生效')),
    );
    Navigator.of(context).pop();
  }

  void _reset() {
    _controller.text = defaultServerUrl();
  }

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text('设置')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: <Widget>[
          Text('后端服务器地址', style: theme.textTheme.titleMedium),
          const SizedBox(height: 8),
          Text(
            '修改后保存立即生效，并跨启动持久化。Android 真机请使用局域网 IP。',
            style: theme.textTheme.bodySmall?.copyWith(color: const Color(0xFF9E96B5)),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _controller,
            keyboardType: TextInputType.url,
            decoration: const InputDecoration(
              labelText: '服务器基地址',
              hintText: 'http://localhost:3000',
              prefixIcon: Icon(Icons.dns_outlined),
            ),
            onSubmitted: (String _) => _save(),
          ),
          const SizedBox(height: 16),
          Row(
            children: <Widget>[
              Expanded(
                child: FilledButton(
                  onPressed: _save,
                  child: const Text('保存'),
                ),
              ),
              const SizedBox(width: 12),
              OutlinedButton(
                onPressed: _reset,
                child: const Text('重置为默认'),
              ),
            ],
          ),
          const SizedBox(height: 24),
          const Divider(),
          const SizedBox(height: 12),
          Text(
            '编译期默认值：${defaultServerUrl()}\n'
            '可通过 --dart-define=SCREENPLAY_API_URL=... 覆盖；运行时设置优先。',
            style: theme.textTheme.bodySmall?.copyWith(color: const Color(0xFF9E96B5)),
          ),
        ],
      ),
    );
  }
}