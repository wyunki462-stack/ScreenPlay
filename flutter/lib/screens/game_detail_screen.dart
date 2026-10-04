// 游戏详情页：头部（海报/名称/平台/评分/时长）+ 截图轮播 + 信息区，
// 下方 TabBar 分区：媒体网格 / 时间线 / 成就 / 评分·价格。顶部刷新按钮。

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_staggered_grid_view/flutter_staggered_grid_view.dart';

import '../core/api_client.dart';
import '../core/prefs.dart';
import '../models/models.dart';
import '../providers/api_providers.dart';
import '../utils/format.dart';
import '../widgets/authed_image.dart';
import '../widgets/game_card.dart';
import '../widgets/media_tile.dart';
import '../widgets/photo_viewer.dart';
import '../widgets/video_player_screen.dart';

class GameDetailScreen extends ConsumerStatefulWidget {
  const GameDetailScreen({super.key, required this.gameId});

  final String gameId;

  @override
  ConsumerState<GameDetailScreen> createState() => _GameDetailScreenState();
}

class _GameDetailScreenState extends ConsumerState<GameDetailScreen>
    with SingleTickerProviderStateMixin {
  late final TabController _tabController;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 4, vsync: this);
    // TabBar 切换时重建 body，显示对应分区的挂载内容。
    _tabController.addListener(() {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _tabController.dispose();
    super.dispose();
  }

  Future<void> _refresh() async {
    await ref.read(refreshGameProvider.notifier).run(widget.gameId);
    if (!mounted) return;
    final AsyncValue<void> state = ref.read(refreshGameProvider);
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(state.hasError ? '刷新失败：${state.error}' : '已强制刷新元数据'),
      ),
    );
  }

  void _openScreenshots(List<PhotoItem> items, int index) {
    Navigator.of(context).push(
      MaterialPageRoute<dynamic>(
        builder: (BuildContext context) => PhotoViewer(items: items, initialIndex: index),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final AsyncValue<GameDetail> detailAsync = ref.watch(gameDetailProvider(widget.gameId));
    final bool refreshing = ref.watch(refreshGameProvider).isLoading;

    return Scaffold(
      appBar: AppBar(
        title: Text(detailAsync.valueOrNull?.name ?? '载入中…', maxLines: 1, overflow: TextOverflow.ellipsis),
        actions: <Widget>[
          if (refreshing)
            const Padding(
              padding: EdgeInsets.symmetric(horizontal: 12),
              child: Center(
                child: SizedBox(
                  width: 18,
                  height: 18,
                  child: CircularProgressIndicator(strokeWidth: 2, color: Color(0xFF00E5FF)),
                ),
              ),
            )
          else
            IconButton(
              tooltip: '强制刷新元数据',
              icon: const Icon(Icons.autorenew),
              onPressed: _refresh,
            ),
        ],
      ),
      body: detailAsync.when(
        loading: () => const Center(child: CircularProgressIndicator(color: Color(0xFF00E5FF))),
        error: (Object error, StackTrace stackTrace) => Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              const Icon(Icons.error_outline, color: Color(0xFFFC6255), size: 48),
              const SizedBox(height: 12),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 24),
                child: Text(
                  error is ApiException ? error.message : '加载详情失败',
                  textAlign: TextAlign.center,
                ),
              ),
              const SizedBox(height: 12),
              FilledButton.icon(
                onPressed: () => ref.invalidate(gameDetailProvider(widget.gameId)),
                icon: const Icon(Icons.refresh),
                label: const Text('重试'),
              ),
            ],
          ),
        ),
        data: (GameDetail detail) => _buildContent(context, detail),
      ),
    );
  }

  Widget _buildContent(BuildContext context, GameDetail detail) {
    final ApiClient api = ref.read(apiClientProvider);
    final List<PhotoItem> screenshots = detail.screenshots
        .asMap()
        .entries
        .map((MapEntry<int, String> e) {
          // 截图来自 `screenshots[]`（后端缓存的远端 CDN 地址）→ 走 NAS 代理，与 Web 一致。
          final String url = api.imageSource(e.value);
          return PhotoItem(
            id: 'screenshot_${e.key}',
            displayUrl: url,
            originalUrl: url, // 截图无独立 /original 端点，原图即自身。
            label: '截图 ${e.key + 1}',
          );
        })
        .toList(growable: false);

    return RefreshIndicator(
      onRefresh: () async {
        // 下拉刷新与 AppBar 刷新走同一条链路：先打后端 refresh，再让
        // 详情/媒体/成就/媒体评价 provider 全部重新拉取（见 RefreshGameNotifier.run）。
        await ref.read(refreshGameProvider.notifier).run(widget.gameId);
      },
      child: ListView(
        padding: const EdgeInsets.only(bottom: 24),
        children: <Widget>[
          _DetailHeader(detail: detail, api: api),
          if (screenshots.isNotEmpty)
            _ScreenshotCarousel(items: screenshots, onOpen: _openScreenshots),
          _InfoSection(detail: detail),
          const SizedBox(height: 8),
          // 分区切换 TabBar（与 Web 前端保持「媒体/时间线/成就/评分」分区一致）。
          ColoredBox(
            color: const Color(0xFF14111D),
            child: TabBar(
              controller: _tabController,
              isScrollable: false,
              labelColor: const Color(0xFF00E5FF),
              unselectedLabelColor: const Color(0xFF9E96B5),
              indicatorColor: const Color(0xFF00E5FF),
              tabs: const <Tab>[
                Tab(text: '媒体'),
                Tab(text: '时间线'),
                Tab(text: '成就'),
                Tab(text: '评分'),
              ],
            ),
          ),
          const SizedBox(height: 12),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: _buildTabContent(detail),
          ),
        ],
      ),
    );
  }

  Widget _buildTabContent(GameDetail detail) {
    switch (_tabController.index) {
      case 0:
        return _MediaTab(gameId: widget.gameId);
      case 1:
        return _TimelineTab(timeline: detail.timeline);
      case 2:
        return _AchievementsTab(gameId: widget.gameId);
      case 3:
      default:
        return _RatingsTab(detail: detail);
    }
  }
}

/// 头部：海报 + 名称 + 平台 + Metacritic 徽章 + 时长。
class _DetailHeader extends StatelessWidget {
  const _DetailHeader({required this.detail, required this.api});

  final GameDetail detail;
  final ApiClient api;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final String? poster = detail.posterUrl == null ? null : api.imageSource(detail.posterUrl!);

    return Padding(
      padding: const EdgeInsets.all(16),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          ClipRRect(
            borderRadius: BorderRadius.circular(12),
            child: SizedBox(
              width: 110,
              height: 150,
              child: poster == null
                  ? const _MiniPlaceholder()
                  : AuthedImage(
                      imageUrl: poster,
                      fit: BoxFit.cover,
                      errorWidget: (BuildContext context, String url, Object error) =>
                          const _MiniPlaceholder(),
                    ),
            ),
          ),
          const SizedBox(width: 16),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  detail.name,
                  style: theme.textTheme.titleLarge?.copyWith(fontWeight: FontWeight.bold),
                ),
                const SizedBox(height: 8),
                Wrap(
                  spacing: 8,
                  runSpacing: 6,
                  children: <Widget>[
                    if (detail.platform != null && detail.platform!.isNotEmpty)
                      Chip(
                        label: Text(detail.platform!),
                        visualDensity: VisualDensity.compact,
                      ),
                    if (detail.metacriticScore != null)
                      Chip(
                        avatar: Text(
                          '${detail.metacriticScore}',
                          style: TextStyle(
                            color: GameCard.metacriticColor(detail.metacriticScore!),
                            fontWeight: FontWeight.bold,
                          ),
                        ),
                        label: const Text('Metacritic'),
                        visualDensity: VisualDensity.compact,
                      ),
                  ],
                ),
                const SizedBox(height: 8),
                Row(
                  children: <Widget>[
                    const Icon(Icons.schedule, size: 16, color: Color(0xFF9E96B5)),
                    const SizedBox(width: 4),
                    Expanded(
                      child: Text(
                        detail.durationText.isNotEmpty ? detail.durationText : '时长未知',
                        style: theme.textTheme.bodyMedium?.copyWith(color: const Color(0xFF9E96B5)),
                      ),
                    ),
                  ],
                ),
                if (detail.releaseDate != null) ...<Widget>[
                  const SizedBox(height: 4),
                  Text(
                    '发售：${detail.releaseDate}',
                    style: theme.textTheme.bodySmall?.copyWith(color: const Color(0xFF9E96B5)),
                  ),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _MiniPlaceholder extends StatelessWidget {
  const _MiniPlaceholder();

  @override
  Widget build(BuildContext context) {
    return const DecoratedBox(
      decoration: BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: <Color>[Color(0xFF2A2148), Color(0xFF006B84)],
        ),
      ),
      child: Center(
        child: Icon(Icons.sports_esports, color: Color(0x99FFFFFF), size: 36),
      ),
    );
  }
}

/// 截图轮播：PageView + 分页指示圆点，点击进入全屏查看器。
class _ScreenshotCarousel extends StatefulWidget {
  const _ScreenshotCarousel({required this.items, required this.onOpen});

  final List<PhotoItem> items;
  final void Function(List<PhotoItem> items, int index) onOpen;

  @override
  State<_ScreenshotCarousel> createState() => _ScreenshotCarouselState();
}

class _ScreenshotCarouselState extends State<_ScreenshotCarousel> {
  late final PageController _controller;
  int _current = 0;

  @override
  void initState() {
    super.initState();
    _controller = PageController();
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      children: <Widget>[
        SizedBox(
          height: 200,
          child: PageView.builder(
            controller: _controller,
            itemCount: widget.items.length,
            onPageChanged: (int index) => setState(() => _current = index),
            itemBuilder: (BuildContext context, int index) {
              final PhotoItem item = widget.items[index];
              return GestureDetector(
                onTap: () => widget.onOpen(widget.items, index),
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 16),
                  child: ClipRRect(
                    borderRadius: BorderRadius.circular(12),
                    child: AuthedImage(
                      imageUrl: item.displayUrl,
                      fit: BoxFit.cover,
                      width: double.infinity,
                      errorWidget: (BuildContext context, String url, Object error) =>
                          const _MiniPlaceholder(),
                    ),
                  ),
                ),
              );
            },
          ),
        ),
        const SizedBox(height: 8),
        Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: List<Widget>.generate(widget.items.length, (int index) {
            final bool selected = index == _current;
            return AnimatedContainer(
              duration: const Duration(milliseconds: 180),
              margin: const EdgeInsets.symmetric(horizontal: 3),
              width: selected ? 18 : 8,
              height: 8,
              decoration: BoxDecoration(
                color: selected ? const Color(0xFF00E5FF) : const Color(0xFF4A445C),
                borderRadius: BorderRadius.circular(4),
              ),
            );
          }),
        ),
      ],
    );
  }
}

/// 信息区：简介 + 开发商 / 发行商 / 配音 / 别名。
class _InfoSection extends StatelessWidget {
  const _InfoSection({required this.detail});

  final GameDetail detail;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          if (detail.summary != null && detail.summary!.isNotEmpty) ...<Widget>[
            Text('简介', style: theme.textTheme.titleMedium),
            const SizedBox(height: 6),
            Text(detail.summary!, style: theme.textTheme.bodyMedium),
            const SizedBox(height: 16),
          ],
          if (detail.developers.isNotEmpty)
            _LabelValue(label: '开发商', value: detail.developers.join('、')),
          if (detail.publishers.isNotEmpty)
            _LabelValue(label: '发行商', value: detail.publishers.join('、')),
          if (detail.voiceActors.isNotEmpty)
            _LabelValue(label: '配音', value: detail.voiceActors.join('、')),
          if (detail.aliases.isNotEmpty)
            _LabelValue(label: '别名', value: detail.aliases.join('、')),
          _LabelValue(label: '文件夹', value: detail.folderName),
          // 通关时长（HLTB）与价格对齐 Web 详情页顶部信息网格：从「评分」tab 移到
          // 此处，排在「元数据刷新」行之前（顺序：… 文件夹 → 通关时长 → 价格 → 元数据刷新）。
          if (detail.mainStoryHours != null ||
              detail.mainPlusExtraHours != null ||
              detail.completionistHours != null) ...<Widget>[
            Text('通关时长 (HLTB)', style: theme.textTheme.titleSmall),
            const SizedBox(height: 8),
            Wrap(
              spacing: 12,
              children: <Widget>[
                if (detail.mainStoryHours != null)
                  _MiniCard(label: '主线', value: '${_hours(detail.mainStoryHours)} 小时'),
                if (detail.mainPlusExtraHours != null)
                  _MiniCard(label: '主线+支线', value: '${_hours(detail.mainPlusExtraHours)} 小时'),
                if (detail.completionistHours != null)
                  _MiniCard(label: '全收集', value: '${_hours(detail.completionistHours)} 小时'),
              ],
            ),
            const SizedBox(height: 16),
          ],
          if (detail.prices.isNotEmpty) ...<Widget>[
            Text('价格', style: theme.textTheme.titleSmall),
            const SizedBox(height: 8),
            ...detail.prices.map((Price p) => _PriceCard(price: p)),
            const SizedBox(height: 16),
          ],
          if (detail.lastMetadataRefresh != null)
            _LabelValue(label: '元数据刷新', value: formatDateTime(detail.lastMetadataRefresh)),
        ],
      ),
    );
  }

  /// 小时数文本：整数不带小数点（90 而非 90.0），小数保留一位。
  static String _hours(double? v) =>
      v == null ? '—' : (v % 1 == 0 ? v.toInt().toString() : v.toStringAsFixed(1));
}

class _LabelValue extends StatelessWidget {
  const _LabelValue({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          SizedBox(
            width: 86,
            child: Text(label, style: theme.textTheme.bodyMedium?.copyWith(color: const Color(0xFF9E96B5))),
          ),
          Expanded(
            child: Text(value, style: theme.textTheme.bodyMedium),
          ),
        ],
      ),
    );
  }
}

/// 媒体分区：图片/视频混合（MasonryGridView），shrinkWrap 嵌入整页滚动。
/// 长按 = 删除（确认弹窗 → 同步删服务器 / 仅清本机缓存）。
/// 删除后共享的本地隐藏集合会让网格立刻少一张；同步删除时 provider 也会被失效，两者互为兜底。
class _MediaTab extends ConsumerWidget {
  const _MediaTab({required this.gameId});

  final String gameId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final AsyncValue<List<Media>> mediaAsync = ref.watch(gameMediaProvider(gameId));
    return mediaAsync.when(
      loading: () => const _TabLoading(),
      error: (Object error, StackTrace stackTrace) => _TabError(
        onRetry: () => ref.invalidate(gameMediaProvider(gameId)),
      ),
      data: (List<Media> all) {
        // 过滤本地已删除项（含「仅清本机缓存」的情况）；剩下的为空就是空态，
        // 直接渲染空态、不额外发任何请求（不做递归扫描）。
        final Set<String> removedIds = ref.watch(locallyRemovedMediaIdsProvider);
        final List<Media> media = all
            .where((Media m) => !removedIds.contains(m.id))
            .toList(growable: false);
        if (media.isEmpty) return const _EmptyText(text: '暂无图片');
        final ApiClient api = ref.read(apiClientProvider);
        // 非视频媒体可进入图片查看器（含 gif，按图片展示）。
        final List<Media> images =
            media.where((Media m) => m.type != MediaType.video).toList(growable: false);

        return MasonryGridView.count(
          shrinkWrap: true,
          physics: const NeverScrollableScrollPhysics(),
          crossAxisCount: 2,
          mainAxisSpacing: 8,
          crossAxisSpacing: 8,
          itemCount: media.length,
          itemBuilder: (BuildContext context, int index) {
            final Media m = media[index];
            return MediaTile(
              media: m,
              coverUrl: _coverUrl(api, m),
              onTap: () => _onTapMedia(context, api, images, m),
              onLongPress: () => _deleteMedia(context, ref, m),
            );
          },
        );
      },
    );
  }

  Future<void> _deleteMedia(BuildContext context, WidgetRef ref, Media media) async {
    // 删除是写操作：只在应用前台执行（用户长按触发天然满足，runMediaDelete 内也会显式判断）。
    // 确认弹窗 → 执行删除 → 中文 SnackBar；成功后由共享的本地隐藏集合把该项从网格移除。
    await runMediaDelete(
      context,
      ref,
      media: media,
      syncToServer: ref.read(syncDeleteProvider),
    );
  }

  String? _coverUrl(ApiClient api, Media m) {
    // 网格缩略图继续用 thumbnail（列表要快）；视频优先封面。
    // imageSource：封面可能是远端 CDN 绝对地址 → 走后端 /api/media/proxy。
    if (m.type == MediaType.video && m.coverUrl != null && m.coverUrl!.isNotEmpty) {
      return api.imageSource(m.coverUrl!);
    }
    return m.thumbnailUrl.isEmpty ? null : api.imageSource(m.thumbnailUrl);
  }

  void _onTapMedia(
    BuildContext context,
    ApiClient api,
    List<Media> images,
    Media tapped,
  ) {
    if (tapped.type == MediaType.video) {
      Navigator.of(context).push(
        MaterialPageRoute<dynamic>(
          builder: (BuildContext context) => VideoPlayerScreen(media: tapped),
        ),
      );
      return;
    }

    // 大图浏览按清晰度取图（preview/original），网格用缩略图保证快；
    // displayUrl 只是 preview 端点缺失时的兜底（缩略图地址）。
    final List<PhotoItem> items = images
        .map((Media img) => PhotoItem(
              id: img.id,
              displayUrl: api.imageSource(img.thumbnailUrl),
              originalUrl: api.mediaOriginalUrl(img.id),
              label: img.fileName,
              media: img,
            ))
        .toList(growable: false);
    int start = images.indexWhere((Media img) => img.id == tapped.id);
    if (start < 0) start = 0;

    Navigator.of(context).push(
      MaterialPageRoute<dynamic>(
        builder: (BuildContext context) => PhotoViewer(items: items, initialIndex: start),
      ),
    );
  }
}

/// 时间线分区。
class _TimelineTab extends StatelessWidget {
  const _TimelineTab({required this.timeline});

  final List<TimelineEvent> timeline;

  IconData _iconFor(TimelineEventType type) {
    switch (type) {
      case TimelineEventType.firstMedia:
        return Icons.play_circle_outline;
      case TimelineEventType.lastMedia:
        return Icons.stop_circle_outlined;
      case TimelineEventType.milestone:
        return Icons.flag_outlined;
      case TimelineEventType.note:
      default:
        return Icons.sticky_note_2_outlined;
    }
  }

  String _labelFor(TimelineEventType type) {
    switch (type) {
      case TimelineEventType.firstMedia:
        return '首次游玩';
      case TimelineEventType.lastMedia:
        return '最近游玩';
      case TimelineEventType.milestone:
        return '里程碑';
      case TimelineEventType.note:
      default:
        return '备注';
    }
  }

  @override
  Widget build(BuildContext context) {
    if (timeline.isEmpty) return const _EmptyText(text: '暂无时间线');
    final ThemeData theme = Theme.of(context);
    return Column(
      children: timeline.map((TimelineEvent event) {
        return Padding(
          padding: const EdgeInsets.only(bottom: 12),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Icon(_iconFor(event.type), size: 20, color: const Color(0xFF00E5FF)),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(event.title, style: theme.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600)),
                    if (event.description != null && event.description!.isNotEmpty)
                      Text(event.description!, style: theme.textTheme.bodySmall),
                    Text(
                      '${_labelFor(event.type)} · ${formatDateTime(event.date)}',
                      style: theme.textTheme.bodySmall?.copyWith(color: const Color(0xFF9E96B5)),
                    ),
                  ],
                ),
              ),
            ],
          ),
        );
      }).toList(growable: false),
    );
  }
}

/// 成就分区。
class _AchievementsTab extends ConsumerWidget {
  const _AchievementsTab({required this.gameId});

  final String gameId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final AsyncValue<List<Achievement>> achievementsAsync = ref.watch(achievementsProvider(gameId));
    return achievementsAsync.when(
      loading: () => const _TabLoading(),
      error: (Object error, StackTrace stackTrace) => _TabError(
        onRetry: () => ref.invalidate(achievementsProvider(gameId)),
      ),
      data: (List<Achievement> achievements) {
        if (achievements.isEmpty) return const _EmptyText(text: '暂无成就数据');
        final ApiClient api = ref.read(apiClientProvider);
        final ThemeData theme = Theme.of(context);
        return Column(
          children: achievements.map((Achievement a) {
            // 成就图标是远端 CDN 地址（`https://…rawg.io/…`）→ 走 NAS 代理，手机网络才拉得动。
            final String? icon = a.iconUrl == null ? null : api.imageSource(a.iconUrl!);
            return Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: Row(
                children: <Widget>[
                  _AchievementIcon(iconUrl: icon),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: <Widget>[
                        Text(a.name, style: theme.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600)),
                        if (a.description != null && a.description!.isNotEmpty)
                          Text(a.description!, style: theme.textTheme.bodySmall),
                      ],
                    ),
                  ),
                  if (a.globalPercent != null)
                    Text(
                      '${a.globalPercent!.toStringAsFixed(1)}%',
                      style: theme.textTheme.bodySmall?.copyWith(color: const Color(0xFF9E96B5)),
                    ),
                ],
              ),
            );
          }).toList(growable: false),
        );
      },
    );
  }
}

class _AchievementIcon extends StatelessWidget {
  const _AchievementIcon({required this.iconUrl});

  final String? iconUrl;

  @override
  Widget build(BuildContext context) {
    const double size = 44;
    if (iconUrl == null || iconUrl!.isEmpty) {
      return const SizedBox(
        width: size,
        height: size,
        child: Icon(Icons.emoji_events_outlined, color: Color(0xFF9E96B5)),
      );
    }
    return ClipRRect(
      borderRadius: BorderRadius.circular(8),
      child: AuthedImage(
        imageUrl: iconUrl!,
        width: size,
        height: size,
        fit: BoxFit.cover,
        errorWidget: (BuildContext context, String url, Object error) => const SizedBox(
          width: size,
          height: size,
          child: Icon(Icons.emoji_events_outlined, color: Color(0xFF9E96B5)),
        ),
      ),
    );
  }
}

/// 评分 / 媒体评价分区。
///
/// 通关时长（HLTB）与价格已移到 `_InfoSection`（对齐 Web 顶部信息网格），
/// 此处只保留评分卡与媒体评价区块（对齐 Web 的 RatingsPanel + MediaReviewsPanel）。
class _RatingsTab extends StatelessWidget {
  const _RatingsTab({required this.detail});

  final GameDetail detail;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        if (detail.ratings.isNotEmpty) ...<Widget>[
          Text('评分', style: theme.textTheme.titleSmall),
          const SizedBox(height: 8),
          ...detail.ratings.map((Rating r) => _RatingCard(rating: r)),
          const SizedBox(height: 16),
        ] else ...<Widget>[
          const _EmptyText(text: '暂无评分数据'),
          const SizedBox(height: 8),
        ],
        _MediaReviewsSection(gameId: detail.id),
      ],
    );
  }
}

/// 媒体评价区块（「评分」tab 内）—— 对齐 Web `MediaReviewsPanel`。
///
/// 标题 + 条数/抓取时间 + 综合分 + 各家媒体评分列表；空态按后端 `status`
/// （failed / unsupported / empty / 从未抓取）给不同中文说明；加载中与失败重试复用
/// 既有 `_TabLoading` / `_TabError` 风格。
class _MediaReviewsSection extends ConsumerWidget {
  const _MediaReviewsSection({required this.gameId});

  final String gameId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final AsyncValue<MediaReviewsResult> reviewsAsync =
        ref.watch(mediaReviewsProvider(gameId));
    final ThemeData theme = Theme.of(context);

    return reviewsAsync.when(
      loading: () => const _TabLoading(),
      error: (Object error, StackTrace stackTrace) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text('媒体评价', style: theme.textTheme.titleSmall),
          _TabError(onRetry: () => ref.invalidate(mediaReviewsProvider(gameId))),
        ],
      ),
      data: (MediaReviewsResult result) {
        final List<MediaReview> reviews = result.reviews;
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Row(
              children: <Widget>[
                Text('媒体评价', style: theme.textTheme.titleSmall),
                const SizedBox(width: 8),
                if (reviews.isNotEmpty)
                  Text(
                    '共 ${reviews.length} 条',
                    style: theme.textTheme.bodySmall?.copyWith(color: const Color(0xFF9E96B5)),
                  ),
                const Spacer(),
                if (result.summary.fetchedAtTime != null)
                  Text(
                    '抓取于 ${formatDateTime(result.summary.fetchedAtTime)}',
                    style: theme.textTheme.bodySmall?.copyWith(color: const Color(0xFF9E96B5)),
                  ),
              ],
            ),
            const SizedBox(height: 8),
            if (reviews.isEmpty)
              _ReviewsEmptyState(summary: result.summary)
            else ...<Widget>[
              if (result.hasScores) ...<Widget>[
                _AverageScoreBadge(text: result.averageScoreText),
                const SizedBox(height: 8),
              ],
              ...reviews.map((MediaReview r) => _MediaReviewCard(review: r)),
            ],
          ],
        );
      },
    );
  }
}

/// 综合分（所有有分数条目的算术平均）。
class _AverageScoreBadge extends StatelessWidget {
  const _AverageScoreBadge({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(
        color: const Color(0xFF1B1826),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Text(
        '综合分：$text',
        style: theme.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600),
      ),
    );
  }
}

/// 单条媒体评价卡片：媒体名 + 评分芯片（颜色与 Web `metacriticTone` 一致）+
/// 结论/正文 + 平台/作者/发布时间。
class _MediaReviewCard extends StatelessWidget {
  const _MediaReviewCard({required this.review});

  final MediaReview review;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final double? score = review.score;
    final Color color = score == null
        ? const Color(0xFF9E96B5)
        : GameCard.metacriticColor(score.toInt());
    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Expanded(
                  child: Text(
                    review.outlet ?? '媒体',
                    style: theme.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600),
                  ),
                ),
                if (score != null)
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                    decoration: BoxDecoration(
                      color: color.withOpacity(0.16),
                      borderRadius: BorderRadius.circular(6),
                      border: Border.all(color: color.withOpacity(0.5)),
                    ),
                    child: Text(
                      review.scoreText,
                      style: TextStyle(color: color, fontWeight: FontWeight.bold),
                    ),
                  ),
              ],
            ),
            if (review.verdict != null && review.verdict!.isNotEmpty) ...<Widget>[
              const SizedBox(height: 6),
              Text(review.verdict!, style: theme.textTheme.bodyMedium?.copyWith(fontStyle: FontStyle.italic)),
            ],
            if (review.text != null && review.text!.isNotEmpty) ...<Widget>[
              const SizedBox(height: 6),
              Text(review.text!, style: theme.textTheme.bodySmall),
            ],
            _buildMeta(theme),
          ],
        ),
      ),
    );
  }

  Widget _buildMeta(ThemeData theme) {
    final List<String> parts = <String>[
      if (review.platform != null && review.platform!.isNotEmpty) '平台 ${review.platform}',
      if (review.author != null && review.author!.isNotEmpty) '作者 ${review.author}',
      if (review.publishedAt != null && review.publishedAt!.isNotEmpty) review.publishedAt!,
    ];
    if (parts.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(top: 6),
      child: Text(
        parts.join(' · '),
        style: theme.textTheme.bodySmall?.copyWith(color: const Color(0xFF9E96B5)),
      ),
    );
  }
}

/// 媒体评价空态：按后端 `summary.status` 分不同说明（与 Web `EmptyState` 对齐）。
class _ReviewsEmptyState extends StatelessWidget {
  const _ReviewsEmptyState({required this.summary});

  final MediaReviewsSummary summary;

  @override
  Widget build(BuildContext context) {
    final String text;
    switch (summary.status) {
      case 'failed':
        final String reason =
            (summary.error != null && summary.error!.isNotEmpty) ? summary.error! : '未知原因';
        text = '媒体评价抓取失败：$reason\n（数据源站点不可达、需要代理或被限流，已抓到的评价不会被清空。）';
        break;
      case 'unsupported':
        text = '未找到该游戏在媒体评价站的对应条目。';
        break;
      case 'empty':
        text = '该游戏的媒体评价数据源没有收录评价内容。';
        break;
      case null:
        text = '还没有抓取过媒体评价，点右上角刷新获取。';
        break;
      default:
        text = '暂无媒体评价';
    }
    return _EmptyText(text: text);
  }
}

class _RatingCard extends StatelessWidget {
  const _RatingCard({required this.rating});

  final Rating rating;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final int? score = rating.metascore;
    final Color color = score == null ? const Color(0xFF9E96B5) : GameCard.metacriticColor(score);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Row(
          children: <Widget>[
            Container(
              width: 52,
              height: 52,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: color.withOpacity(0.16),
                borderRadius: BorderRadius.circular(10),
                border: Border.all(color: color.withOpacity(0.5)),
              ),
              child: Text(
                score?.toString() ?? '—',
                style: TextStyle(color: color, fontSize: 20, fontWeight: FontWeight.bold),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(rating.ratingClass ?? 'Metacritic', style: theme.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600)),
                  Text(
                    '评论家 ${rating.criticCount ?? 0} · 用户评分 ${rating.userScore ?? '—'} (${rating.userCount ?? 0} 人)',
                    style: theme.textTheme.bodySmall?.copyWith(color: const Color(0xFF9E96B5)),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _PriceCard extends StatelessWidget {
  const _PriceCard({required this.price});

  final Price price;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final bool discounted = (price.discountPercent ?? 0) > 0;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Row(
          children: <Widget>[
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text('Steam', style: theme.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600)),
                  if (price.lastUpdated != null)
                    Text('更新于 ${price.lastUpdated}', style: theme.textTheme.bodySmall?.copyWith(color: const Color(0xFF9E96B5))),
                ],
              ),
            ),
            if (discounted)
              Container(
                margin: const EdgeInsets.only(right: 10),
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                decoration: BoxDecoration(
                  color: const Color(0xFF6CCF59).withOpacity(0.2),
                  borderRadius: BorderRadius.circular(6),
                ),
                child: Text(
                  '-${price.discountPercent!.toInt()}%',
                  style: const TextStyle(color: Color(0xFF6CCF59), fontWeight: FontWeight.bold),
                ),
              ),
            Text(
              _priceText(price),
              style: theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.bold),
            ),
          ],
        ),
      ),
    );
  }

  String _priceText(Price price) {
    final String currency = price.currency?.isNotEmpty == true ? '${price.currency} ' : '';
    final double? current = price.currentPrice;
    if (current == null) return '价格未知';
    final String text = '$currency${_trim(current)}';
    if ((price.discountPercent ?? 0) > 0 && price.initialPrice != null) {
      return '$text  (原价 $currency${_trim(price.initialPrice!)})';
    }
    return text;
  }

  static String _trim(double v) => v % 1 == 0 ? v.toInt().toString() : v.toStringAsFixed(2);
}

/// 通用小组件。
class _MiniCard extends StatelessWidget {
  const _MiniCard({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
      decoration: BoxDecoration(
        color: const Color(0xFF1B1826),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Text(
        '$label：$value',
        style: theme.textTheme.bodyMedium,
      ),
    );
  }
}

class _TabLoading extends StatelessWidget {
  const _TabLoading();

  @override
  Widget build(BuildContext context) {
    return const Center(
      child: Padding(
        padding: EdgeInsets.symmetric(vertical: 32),
        child: CircularProgressIndicator(color: Color(0xFF00E5FF)),
      ),
    );
  }
}

class _TabError extends StatelessWidget {
  const _TabError({required this.onRetry});

  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: FilledButton.icon(
        onPressed: onRetry,
        icon: const Icon(Icons.refresh),
        label: const Text('重试'),
      ),
    );
  }
}

class _EmptyText extends StatelessWidget {
  const _EmptyText({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 32),
      child: Center(
        child: Text(text, style: const TextStyle(color: Color(0xFF9E96B5))),
      ),
    );
  }
}