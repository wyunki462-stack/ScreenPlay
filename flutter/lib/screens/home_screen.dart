// 首页：统计栏 + 搜索 + 过滤（排序 / 平台）+ 游戏网格。

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/api_client.dart';
import '../models/models.dart';
import '../providers/api_providers.dart';
import '../utils/format.dart';
import '../widgets/game_card.dart';
import '../widgets/settings_screen.dart';

class HomeScreen extends ConsumerStatefulWidget {
  const HomeScreen({super.key});

  @override
  ConsumerState<HomeScreen> createState() => _HomeScreenState();
}

/// 排序选项（value → 后端 sort 参数，中文标签）。
const List<MapEntry<String, String>> _sortOptions = <MapEntry<String, String>>[
  MapEntry<String, String>('name', '名称'),
  MapEntry<String, String>('created', '入库时间'),
  MapEntry<String, String>('duration', '游玩时长'),
  MapEntry<String, String>('mediaCount', '媒体数量'),
  MapEntry<String, String>('metacritic', 'Metacritic 评分'),
];

class _HomeScreenState extends ConsumerState<HomeScreen> {
  final TextEditingController _searchController = TextEditingController();
  Timer? _debounce;

  String _search = '';
  String _sort = 'name';
  String _platform = ''; // 空字符串 → 全部平台

  @override
  void dispose() {
    _debounce?.cancel();
    _searchController.dispose();
    super.dispose();
  }

  void _onSearchChanged(String value) {
    // 300ms 防抖，避免每个字符都触发请求。
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 300), () {
      if (mounted) setState(() => _search = value.trim());
    });
  }

  /// 依据当前 UI 状态构造过滤条件；metacritic 排序时默认降序。
  GameFilter _filter() => GameFilter(
        search: _search,
        platform: _platform.isEmpty ? null : _platform,
        sort: _sort,
        order: _sort == 'metacritic' ? 'desc' : 'asc',
      );

  void _openGame(GameSummary game) {
    Navigator.of(context).pushNamed('/game/${Uri.encodeComponent(game.id)}');
  }

  void _openSettings() {
    Navigator.of(context).push(
      MaterialPageRoute<dynamic>(builder: (BuildContext context) => const SettingsScreen()),
    );
  }

  Future<void> _scan() async {
    // 扫描为异步操作；完成后 notifier 会 invalidate 相关缓存。
    await ref.read(scanLibraryProvider.notifier).run();
    if (!mounted) return;
    final AsyncValue<void> state = ref.read(scanLibraryProvider);
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          state.hasError ? '扫描失败：${state.error}' : '已开始重新扫描资料库',
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final AsyncValue<Stats> statsAsync = ref.watch(statsProvider);
    final ThemeData theme = Theme.of(context);

    return Scaffold(
      appBar: AppBar(
        title: const Text('ScreenPlay'),
        actions: <Widget>[
          IconButton(
            tooltip: '重新扫描',
            icon: const Icon(Icons.sync),
            onPressed: _scan,
          ),
          IconButton(
            tooltip: '设置',
            icon: const Icon(Icons.settings_outlined),
            onPressed: _openSettings,
          ),
        ],
      ),
      body: Column(
        children: <Widget>[
          _StatsBar(statsAsync: statsAsync),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
            child: TextField(
              controller: _searchController,
              onChanged: _onSearchChanged,
              decoration: const InputDecoration(
                hintText: '搜索游戏名称…',
                prefixIcon: Icon(Icons.search),
                isDense: true,
              ),
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 4, 16, 4),
            child: Row(
              children: <Widget>[
                Expanded(child: _buildSortDropdown(theme)),
                const SizedBox(width: 12),
                Expanded(child: _buildPlatformDropdown(theme, statsAsync)),
              ],
            ),
          ),
          Expanded(child: _buildGameGrid()),
        ],
      ),
    );
  }

  Widget _buildSortDropdown(ThemeData theme) {
    return DropdownButtonFormField<String>(
      value: _sort,
      decoration: const InputDecoration(labelText: '排序', isDense: true),
      items: _sortOptions
          .map((MapEntry<String, String> e) => DropdownMenuItem<String>(
                value: e.key,
                child: Text(e.value),
              ))
          .toList(growable: false),
      onChanged: (String? value) {
        if (value != null) setState(() => _sort = value);
      },
    );
  }

  Widget _buildPlatformDropdown(ThemeData theme, AsyncValue<Stats> statsAsync) {
    final List<String> platforms = (statsAsync.valueOrNull?.platforms.keys.toList() ?? <String>[])
      ..sort();
    return DropdownButtonFormField<String>(
      value: _platform,
      decoration: const InputDecoration(labelText: '平台', isDense: true),
      items: <DropdownMenuItem<String>>[
        const DropdownMenuItem<String>(value: '', child: Text('全部平台')),
        ...platforms.map((String p) => DropdownMenuItem<String>(value: p, child: Text(p))),
      ],
      onChanged: (String? value) => setState(() => _platform = value ?? ''),
    );
  }

  Widget _buildGameGrid() {
    final AsyncValue<List<GameSummary>> gamesAsync = ref.watch(gamesProvider(_filter()));
    return gamesAsync.when(
      loading: () => const Center(child: CircularProgressIndicator(color: Color(0xFF00E5FF))),
      error: (Object error, StackTrace stackTrace) => _ErrorView(
        message: _friendlyError(error),
        onRetry: () => ref.invalidate(gamesProvider),
      ),
      data: (List<GameSummary> games) {
        if (games.isEmpty) {
          return const Center(child: Text('暂无游戏，点击右上角同步图标开始扫描。'));
        }
        final ApiClient api = ref.read(apiClientProvider);
        return GridView.builder(
          padding: const EdgeInsets.all(16),
          gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
            maxCrossAxisExtent: 240,
            mainAxisSpacing: 12,
            crossAxisSpacing: 12,
            childAspectRatio: 0.56, // 2:3 海报 + 文本信息区
          ),
          itemCount: games.length,
          itemBuilder: (BuildContext context, int index) {
            final GameSummary game = games[index];
            final String? poster =
                game.posterUrl == null ? null : api.resolve(game.posterUrl!);
            return GameCard(
              game: game,
              posterUrl: poster,
              onTap: () => _openGame(game),
            );
          },
        );
      },
    );
  }

  static String _friendlyError(Object error) {
    if (error is ApiException) return error.message;
    return '无法连接后端，请在设置中检查服务器地址。';
  }
}

/// 顶部统计栏。
class _StatsBar extends StatelessWidget {
  const _StatsBar({required this.statsAsync});

  final AsyncValue<Stats> statsAsync;

  @override
  Widget build(BuildContext context) {
    final Stats? stats = statsAsync.valueOrNull;
    if (stats == null) {
      return const SizedBox(
        height: 48,
        child: Center(
          child: SizedBox(
            width: 16,
            height: 16,
            child: CircularProgressIndicator(strokeWidth: 2, color: Color(0xFF00E5FF)),
          ),
        ),
      );
    }
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 16),
      decoration: const BoxDecoration(
        color: Color(0xFF14111D),
        border: Border(bottom: BorderSide(color: Color(0xFF2A2637))),
      ),
      child: Wrap(
        spacing: 18,
        runSpacing: 8,
        children: <Widget>[
          _Stat(text: '游戏', value: '${stats.totalGames}'),
          _Stat(text: '媒体', value: '${stats.totalMedia}'),
          _Stat(text: '图片', value: '${stats.totalImages}'),
          _Stat(text: '视频', value: '${stats.totalVideos}'),
          _Stat(text: '总时长', value: formatDuration(stats.totalPlayTimeSeconds)),
          _Stat(text: '占用', value: formatBytes(stats.totalSizeBytes)),
        ],
      ),
    );
  }
}

class _Stat extends StatelessWidget {
  const _Stat({required this.text, required this.value});

  final String text;
  final String value;

  @override
  Widget build(BuildContext context) {
    return RichText(
      text: TextSpan(
        style: DefaultTextStyle.of(context).style,
        children: <InlineSpan>[
          TextSpan(
            text: '$value ',
            style: const TextStyle(fontWeight: FontWeight.bold, color: Color(0xFF00E5FF)),
          ),
          TextSpan(text: text, style: const TextStyle(color: Color(0xFF9E96B5))),
        ],
      ),
    );
  }
}

/// 错误视图。
class _ErrorView extends StatelessWidget {
  const _ErrorView({required this.message, required this.onRetry});

  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            const Icon(Icons.cloud_off_outlined, size: 48, color: Color(0xFFFC6255)),
            const SizedBox(height: 12),
            Text(message, textAlign: TextAlign.center),
            const SizedBox(height: 12),
            FilledButton.icon(
              onPressed: onRetry,
              icon: const Icon(Icons.refresh),
              label: const Text('重试'),
            ),
          ],
        ),
      ),
    );
  }
}