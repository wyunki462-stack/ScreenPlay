// 设置页（1.3.1 竖屏适配版）。
//
// 为什么重排成「分组卡片 + 单列」：
//   1. 手机竖屏下宽行（一个 Row 塞多个控件）会显得过宽、点击区域过小，
//      分组卡片 + 单列列表既符合 Material 规范，也保证触控目标 ≥ 48dp；
//   2. 1.3.1 新增了两个开关（WiFi 原图 / 删除同步）和「切换服务器 / 退出登录」，
//      按语义分组（连接 / 显示与同步 / 存储）比堆在一个 ListView 里更好找。
// 原有「服务器地址」查看/修改能力保留（改为「切换服务器」入口 + 当前地址展示）。

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/api_client.dart';
import '../core/image_cache.dart';
import '../core/network_quality.dart';
import '../core/prefs.dart';
import '../core/server_config.dart';
import '../providers/api_providers.dart';

class SettingsScreen extends ConsumerStatefulWidget {
  const SettingsScreen({super.key});

  @override
  ConsumerState<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends ConsumerState<SettingsScreen> {
  /// 当前磁盘缓存占用（字节）；null = 计算中。
  int? _cacheBytes;
  bool _clearing = false;

  @override
  void initState() {
    super.initState();
    _refreshCacheBytes();
  }

  Future<void> _refreshCacheBytes() async {
    final int bytes = await imageCacheBytes();
    if (!mounted) return;
    setState(() => _cacheBytes = bytes);
  }

  /// 字节 → 人类可读（MB/KB），设置页展示用。
  String _formatBytes(int bytes) {
    if (bytes <= 0) return '0 MB';
    const int kb = 1024;
    const int mb = kb * 1024;
    if (bytes >= mb) return '${(bytes / mb).toStringAsFixed(1)} MB';
    if (bytes >= kb) return '${(bytes / kb).toStringAsFixed(0)} KB';
    return '$bytes B';
  }

  Future<void> _clearCache() async {
    if (_clearing) return;
    setState(() => _clearing = true);
    await clearImageCache();
    await _refreshCacheBytes();
    if (!mounted) return;
    setState(() => _clearing = false);
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('图片缓存已清理')),
    );
  }

  Future<void> _setWifiOriginal(bool value) async {
    // 先改内存镜像（UI 立即响应），再落盘；清晰度策略读的就是这个 provider。
    ref.read(wifiOriginalProvider.notifier).state = value;
    await ref.read(appPrefsProvider).setWifiOriginal(value);
  }

  Future<void> _setSyncDelete(bool value) async {
    ref.read(syncDeleteProvider.notifier).state = value;
    await ref.read(appPrefsProvider).setSyncDelete(value);
  }

  /// 切换到别的服务器：清会话（地址要换，旧凭证无效）→ 回连接页重新探测。
  Future<void> _switchServer() async {
    final bool ok = await _confirm('切换服务器', '将清除当前登录状态并返回连接页，是否继续？');
    if (!ok || !mounted) return;
    final AppPrefs prefs = ref.read(appPrefsProvider);
    try {
      await ref.read(apiClientProvider).logout();
    } catch (_) {
      // 登出失败不阻断：本地凭证照样清掉。
    }
    await prefs.clearSession();
    ref.read(serverModeProvider.notifier).state = null;
    // 凭证已清，重建 ApiClient 丢掉旧 token，并让会话缓存失效。
    ref.invalidate(apiClientProvider);
    ref.invalidate(sessionProvider);
    if (!mounted) return;
    Navigator.of(context).pushNamedAndRemoveUntil('/connect', (Route<dynamic> route) => false);
  }

  /// 退出登录：清本地会话 → 回登录页（Windows 模式无需登录，改为回连接页）。
  Future<void> _logout() async {
    final ServerMode mode = ref.read(serverModeProvider) ??
        ref.read(appPrefsProvider).serverMode ??
        ServerMode.linux;
    final bool ok = await _confirm('退出登录', '确定要退出当前账号吗？');
    if (!ok || !mounted) return;

    final AppPrefs prefs = ref.read(appPrefsProvider);
    try {
      await ref.read(apiClientProvider).logout();
    } catch (_) {
      // 网络失败也要清本地凭证，否则用户会「退不出去」。
    }
    await prefs.clearSession();
    ref.read(apiClientProvider).setAuthToken(null);
    // 重建 ApiClient 丢掉旧 token，并让会话缓存失效，避免退出后仍显示已登录。
    ref.invalidate(apiClientProvider);
    ref.invalidate(sessionProvider);

    if (!mounted) return;
    if (mode == ServerMode.windows) {
      // Windows 端本来就免登录，退出即回连接页换地址。
      ref.read(serverModeProvider.notifier).state = ServerMode.windows;
      Navigator.of(context).pushNamedAndRemoveUntil('/connect', (Route<dynamic> route) => false);
    } else {
      Navigator.of(context).pushNamedAndRemoveUntil('/login', (Route<dynamic> route) => false);
    }
  }

  Future<bool> _confirm(String title, String content) async {
    final bool? result = await showDialog<bool>(
      context: context,
      builder: (BuildContext context) => AlertDialog(
        title: Text(title),
        content: Text(content),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('确定'),
          ),
        ],
      ),
    );
    return result ?? false;
  }

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final String serverUrl = ref.watch(serverConfigProvider);
    final ServerMode? mode = ref.watch(serverModeProvider) ?? ref.read(appPrefsProvider).serverMode;
    final String? user = ref.read(appPrefsProvider).sessionUser;
    final bool wifiOriginal = ref.watch(wifiOriginalProvider);
    final bool syncDelete = ref.watch(syncDeleteProvider);
    final AsyncValue<bool> wifiAsync = ref.watch(isWifiProvider);

    final String networkText = wifiAsync.when(
      data: (bool wifi) => wifi ? 'WiFi / 以太网' : '移动数据',
      loading: () => '检测中…',
      error: (Object _, StackTrace __) => '未知',
    );

    final String modeText = switch (mode) {
      ServerMode.linux => 'Linux 端（需要登录）',
      ServerMode.windows => 'Windows 端（免登录）',
      null => '尚未探测（请先连接服务器）',
    };

    return Scaffold(
      appBar: AppBar(title: const Text('设置')),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
        children: <Widget>[
          const _GroupTitle('当前连接'),
          _GroupCard(
            children: <Widget>[
              _InfoTile(
                icon: Icons.dns_outlined,
                title: '服务器地址',
                subtitle: serverUrl,
              ),
              _InfoTile(
                icon: Icons.public,
                title: '当前网络',
                subtitle: networkText,
              ),
              _InfoTile(
                icon: Icons.desktop_windows_outlined,
                title: '服务器模式',
                subtitle: modeText,
              ),
              if ((user ?? '').trim().isNotEmpty)
                _InfoTile(
                  icon: Icons.person_outline,
                  title: '已登录用户',
                  subtitle: user!,
                ),
              ListTile(
                minVerticalPadding: 12,
                leading: const Icon(Icons.swap_horiz),
                title: const Text('切换服务器'),
                subtitle: const Text('重新填写地址并探测服务端类型'),
                trailing: const Icon(Icons.chevron_right),
                onTap: _switchServer,
              ),
            ],
          ),
          const SizedBox(height: 20),

          const _GroupTitle('显示与同步'),
          _GroupCard(
            children: <Widget>[
              SwitchListTile(
                value: wifiOriginal,
                onChanged: _setWifiOriginal,
                secondary: const Icon(Icons.image_outlined),
                title: const Text('WiFi 下自动加载原图'),
                subtitle: Text(
                  wifiOriginal
                      ? 'WiFi / 以太网取原图，移动数据取压缩预览图'
                      : '任何网络都取原图（更清晰，也更费流量）',
                ),
              ),
              const Divider(height: 1),
              SwitchListTile(
                value: syncDelete,
                onChanged: _setSyncDelete,
                secondary: const Icon(Icons.cloud_off_outlined),
                title: const Text('删除同步到服务端'),
                subtitle: Text(
                  syncDelete
                      ? '删除媒体时同时删除服务器文件'
                      : '仅删除本机缓存，服务器文件保留',
                ),
              ),
            ],
          ),
          const SizedBox(height: 20),

          const _GroupTitle('存储'),
          _GroupCard(
            children: <Widget>[
              ListTile(
                minVerticalPadding: 12,
                leading: const Icon(Icons.cleaning_services_outlined),
                title: const Text('清理图片缓存'),
                subtitle: Text(
                  _cacheBytes == null
                      ? '正在统计占用…'
                      : '当前占用 ${_formatBytes(_cacheBytes!)}',
                ),
                trailing: _clearing
                    ? const SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Icon(Icons.chevron_right),
                onTap: _clearing ? null : _clearCache,
              ),
            ],
          ),
          const SizedBox(height: 20),

          const _GroupTitle('账号'),
          _GroupCard(
            children: <Widget>[
              ListTile(
                minVerticalPadding: 12,
                leading: Icon(
                  Icons.logout,
                  color: theme.colorScheme.error,
                ),
                title: Text(
                  '退出登录',
                  style: TextStyle(color: theme.colorScheme.error),
                ),
                subtitle: const Text('清除本机会话凭证'),
                onTap: _logout,
              ),
            ],
          ),
          const SizedBox(height: 24),
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

/// 分组标题。
class _GroupTitle extends StatelessWidget {
  const _GroupTitle(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(4, 0, 4, 8),
      child: Text(
        text,
        style: Theme.of(context).textTheme.titleSmall?.copyWith(
              color: const Color(0xFF9E96B5),
              letterSpacing: 0.5,
            ),
      ),
    );
  }
}

/// 分组卡片容器。
class _GroupCard extends StatelessWidget {
  const _GroupCard({required this.children});

  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    return Card(
      margin: EdgeInsets.zero,
      clipBehavior: Clip.antiAlias,
      child: Column(children: children),
    );
  }
}

/// 只读信息行（图标 + 标题 + 副标题值）。
class _InfoTile extends StatelessWidget {
  const _InfoTile({required this.icon, required this.title, required this.subtitle});

  final IconData icon;
  final String title;
  final String subtitle;

  @override
  Widget build(BuildContext context) {
    return ListTile(
      minVerticalPadding: 12,
      leading: Icon(icon),
      title: Text(title),
      subtitle: Text(
        subtitle,
        maxLines: 3,
        overflow: TextOverflow.ellipsis,
      ),
    );
  }
}