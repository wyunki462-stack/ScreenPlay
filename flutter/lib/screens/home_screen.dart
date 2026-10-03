// 首页：统计栏 + 搜索 + 过滤（排序 / 平台）+ 游戏网格。
//
// 1.3.1 变化（安卓端）：
//  - 网格响应式列数：竖屏手机固定一行 2 个（宽 < 600），600~899 三个，≥ 900 四个；
//    childAspectRatio 由格子宽高反推（见 _childAspectRatioFor 的算式注释），不再用固定 0.56。
//  - 排序下拉新增「自定义排序」(value = 'custom'，后端 GET /api/games?sort=custom)。
//    仅在该模式下开启长按拖拽排序（LongPressDraggable + DragTarget），拖完立刻本地
//    乐观重排，再调 reorderGamesProvider.run(...) 同步服务端；失败回滚 + 中文 SnackBar。
//  - 低功耗：监听滚动速度写 fastScrollingProvider，只有 preloadAllowedProvider（前台且
//    非快速滚动）为真且卡片进入邻近可见范围时才允许卡片预取海报。

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/api_client.dart';
import '../core/app_lifecycle.dart';
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
  // 后端允许值：custom|name|created|duration|mediaCount|metacritic。选它才允许长按拖拽。
  MapEntry<String, String>('custom', '自定义排序'),
];

/// 网格外边距 / 间距（与既有观感保持一致：spacing 12）。
const double _kGridPadding = 16;
const double _kGridSpacing = 12;

/// 「快速滚动」判定阈值：滚动速度（逻辑像素 / 秒）。
///
/// 取值依据：安卓一屏高约 800~900 逻辑像素，正常浏览大约 0.5~0.8 秒滚过一屏
/// （≈1100~1800 px/s）。阈值取中间偏上，既能识别「甩动式」快速滚动，又不会因为
/// 用户慢慢拖动网格就误判成快速滚动（误判会让海报预取被无谓关掉）。
const double _kFastScrollVelocity = 1400;

/// 停止滚动后多久把 fastScrollingProvider 复位为 false。
/// 300ms 与需求一致，且足够跨过相邻滚动通知的间隙（避免抖动式反复 true/false）。
const Duration _kFastScrollResetDelay = Duration(milliseconds: 300);

/// 可见范围预取缓冲：以「格子行」为单位，向上/下各多预取 1 行。
/// 1 行 ≈ 一屏的 1/3~1/2，足以在手指滑动到位前把海报请求发出去，又不会把离屏很远的
/// 卡片全拉起来。
const int _kPreloadRowBuffer = 1;

class _HomeScreenState extends ConsumerState<HomeScreen> {
  final TextEditingController _searchController = TextEditingController();
  final ScrollController _scrollController = ScrollController();
  Timer? _debounce;
  Timer? _fastScrollReset;

  String _search = '';
  String _sort = 'name';
  String _platform = ''; // 空字符串 → 全部平台

  // ---- 自定义排序（拖拽）相关 -------------------------------------------------

  /// 乐观本地顺序覆盖：拖完立刻按此顺序渲染，等 provider 成功后清空以回到服务端顺序。
  /// 为什么需要：PUT 是异步的，等响应回来再刷新会有一段「手指已抬起但卡片没动」的空窗。
  List<GameSummary>? _customOrder;

  /// 拖拽项开始拖动时在**当时渲染顺序**中的下标（拖拽期间顺序不会变，可安全复用）。
  int? _draggedIndex;

  /// 本次渲染的列表顺序（拖拽落点与插入指示都以它为准，避免与服务端新顺序错位）。
  List<GameSummary> _renderedOrder = const <GameSummary>[];

  /// 目标插入点：命中的格子下标 + 指针是否落在该格右半（决定插入位置与指示条方向）。
  int? _hoverIndex;
  bool _hoverRightHalf = false;

  // ---- 网格几何（由 LayoutBuilder 记录，供可见范围预取计算） --------------------
  /// 每行的高度步进 = 格子高 + 行间距（用于把滚动偏移换算成行号）。
  double _rowExtent = 0;
  int _columns = 2;
  double _viewportHeight = 0;
  double _scrollOffset = 0;
  /// 上一次滚动更新的像素位置与时间戳——用于估算滚动速度（3.24.5 的 ScrollMetrics
  /// 没有 oldPixels，只能自己维护）。
  double _lastScrollPixels = 0;
  final Stopwatch _scrollClock = Stopwatch();
  int _lastScrollElapsedMicros = 0;

  @override
  void dispose() {
    _debounce?.cancel();
    _fastScrollReset?.cancel();
    _scrollController.dispose();
    _searchController.dispose();
    super.dispose();
  }

  void _onSearchChanged(String value) {
    // 300ms 防抖，避免每个字符都触发请求。
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 300), () {
      if (!mounted) return;
      // 过滤条件变了，本地自定义顺序不再有意义（服务端返回的顺序已变）。
      _clearCustomOrderOverride();
      setState(() => _search = value.trim());
    });
  }

  /// 依据当前 UI 状态构造过滤条件；metacritic 排序时默认降序。
  GameFilter _filter() => GameFilter(
        search: _search,
        platform: _platform.isEmpty ? null : _platform,
        sort: _sort,
        order: _sort == 'metacritic' ? 'desc' : 'asc',
      );

  /// 清掉本地自定义顺序覆盖（不改 UI，调用方负责 setState）。
  /// 触发时机：排序/平台/搜索变化、拖拽开始、同步成功后。
  void _clearCustomOrderOverride() {
    _customOrder = null;
  }

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
    // 前台且非快速滚动 → 允许卡片预取海报；否则卡片只显示单张 posterUrl，不发请求。
    final bool preloadAllowed = ref.watch(preloadAllowedProvider);

    return Scaffold(
      appBar: AppBar(
        title: const Text('ScreenPlay'),
        actions: <Widget>[
          if (_sort == 'custom')
            // 自定义排序只在拖拽模式下有「顺序会被同步」的语义，这里给一个显式提示。
            Padding(
              padding: const EdgeInsets.only(right: 4),
              child: Tooltip(
                message: '长按卡片拖动可调整顺序（自动同步到服务端）',
                child: Icon(
                  Icons.drag_indicator,
                  color: preloadAllowed ? const Color(0xFF00E5FF) : const Color(0xFF9E96B5),
                ),
              ),
            ),
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
          Expanded(child: _buildGameGrid(preloadAllowed)),
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
        if (value == null) return;
        // 排序切换 → 服务端顺序已变，本地覆盖必须失效，否则会盖住新顺序。
        _clearCustomOrderOverride();
        setState(() => _sort = value);
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
      onChanged: (String? value) {
        _clearCustomOrderOverride();
        setState(() => _platform = value ?? '');
      },
    );
  }

  Widget _buildGameGrid(bool preloadAllowed) {
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
        // 乐观本地覆盖顺序优先（拖拽后立刻生效）；服务端回来并清空覆盖后自然回到它。
        final List<GameSummary> ordered = _applyCustomOrder(games);
        // 拖拽落点/指示条一律以「本次渲染顺序」为坐标系，避免与服务端新顺序错位。
        _renderedOrder = ordered;
        final bool draggable = _sort == 'custom';
        final ApiClient api = ref.read(apiClientProvider);

        return LayoutBuilder(
          builder: (BuildContext context, BoxConstraints constraints) {
            // 依据可用宽度决定列数（竖屏 2 列，与需求一致）。
            final int columns = _columnsForWidth(constraints.maxWidth);
            final double usableWidth = constraints.maxWidth - _kGridPadding * 2;
            final int gaps = columns - 1;
            final double idealCellWidth = (usableWidth - _kGridSpacing * gaps) / columns;
            // 水平 margin 由 GameCard 自己留（左右各 4），算宽高比时要扣掉，
            // 否则会按偏大的宽度算出「偏高」的格子，海报区跟着被拉长。
            final double posterWidth = (idealCellWidth - 8).clamp(80.0, 600.0);
            _columns = columns;

            final double aspectRatio = _childAspectRatioFor(context, posterWidth);
            final double cellHeight = idealCellWidth / aspectRatio;
            _rowExtent = cellHeight + _kGridSpacing;
            _viewportHeight = constraints.maxHeight;

            return NotificationListener<ScrollNotification>(
              onNotification: _onScrollNotification,
              child: GridView.builder(
                controller: _scrollController,
                padding: const EdgeInsets.all(_kGridPadding),
                gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
                  crossAxisCount: columns,
                  mainAxisSpacing: _kGridSpacing,
                  crossAxisSpacing: _kGridSpacing,
                  childAspectRatio: aspectRatio,
                ),
                itemCount: ordered.length,
                itemBuilder: (BuildContext context, int index) {
                  final GameSummary game = ordered[index];
                  final String? poster =
                      game.posterUrl == null ? null : api.resolve(game.posterUrl!);

                  // 可见范围 + 缓冲：只有落在「可见行 ± 1 行」内且允许预取时，
                  // 才把卡片标记为可预取（卡片内部才会去 watch postersProvider）。
                  final bool inPreloadWindow =
                      preloadAllowed && _inPreloadWindow(index);

                  final Widget card = GameCard(
                    game: game,
                    posterUrl: poster,
                    onTap: () => _openGame(game),
                    allowPosterPrefetch: inPreloadWindow,
                  );

                  if (!draggable) return card;
                  return _buildDraggableCell(
                    context: context,
                    card: card,
                    game: game,
                    index: index,
                    cellWidth: idealCellWidth,
                    cellHeight: cellHeight,
                  );
                },
              ),
            );
          },
        );
      },
    );
  }

  // ---------------------------------------------------------------------------
  // 网格几何 / 宽高比
  // ---------------------------------------------------------------------------

  /// 当前宽度 → 列数（需求：<600 → 2；600~899 → 3；≥900 → 4）。
  static int _columnsForWidth(double width) {
    if (width >= 900) return 4;
    if (width >= 600) return 3;
    return 2;
  }

  /// childAspectRatio = 格子宽 / 格子高。
  ///
  /// 格子高 = 海报高 + 信息行高；海报固定 2:3 ⇒ 海报高 = 海报宽 × 1.5；
  /// 海报宽 ≈ 格子宽（Card 只留水平 margin，不影响高度）。
  /// 信息行 = 标题最多 2 行 + 6 间距 + 底部行 + 上下 padding。
  /// 用当前 [TextScaler] 估算字号，末尾再留 6 逻辑像素余量；最后夹在
  /// [_kMinAspectRatio, _kMaxAspectRatio]：
  ///  - 下限 0.40：极端窄屏（如 320dp 且 2 列，cell≈139）不让格子再扁，宁可海报收缩；
  ///  - 上限 0.62：宽屏下不让卡片被拉得过高，保持接近原观感（原来是 0.56）。
  static double _childAspectRatioFor(BuildContext context, double cellWidth) {
    final TextScaler scaler = MediaQuery.textScalerOf(context);
    final double scale = scaler.scale(14) / 14;
    final double titleLine = 15.0 * 1.2 * scale; // titleSmall 约 14~15
    final double bodyLine = 12.0 * 1.1 * scale; // bodySmall 约 12
    final double infoHeight = 8 + titleLine * 2 + 6 + bodyLine + 10 + 6; // 8/10 padding + 6 余量
    final double cellHeight = cellWidth * 1.5 + infoHeight;
    return (cellWidth / cellHeight).clamp(_kMinAspectRatio, _kMaxAspectRatio);
  }

  static const double _kMinAspectRatio = 0.40;
  static const double _kMaxAspectRatio = 0.62;

  /// 第 [index] 个格子是否落在预取窗口内。
  ///
  /// 计算方式（基于已知格子尺寸 + 滚动偏移，无需 GlobalKey / 逐项测量）：
  ///  - 行号 = index ~/ 列数；第 r 行顶部（内容坐标）= GridView 的 padding(16) + r × _rowExtent，
  ///    其中 _rowExtent = 格子高 + 行间距 12；
  ///  - 可见纵向区间 = [_scrollOffset - 16, _scrollOffset + _viewportHeight]；
  ///  - 预取窗口在此基础上向上/下各放宽 [_kPreloadRowBuffer] 行。
  bool _inPreloadWindow(int index) {
    if (_rowExtent <= 0 || _viewportHeight <= 0 || _columns <= 0) return false;
    final int row = index ~/ _columns;
    final double rowTop = _kGridPadding + row * _rowExtent;
    final double rowBottom = rowTop + _rowExtent;
    final double windowTop =
        _scrollOffset - _kGridPadding - _kPreloadRowBuffer * _rowExtent;
    final double windowBottom =
        _scrollOffset + _viewportHeight + _kPreloadRowBuffer * _rowExtent;
    return rowBottom >= windowTop && rowTop <= windowBottom;
  }

  /// 滚动通知 → 记录偏移 + 写快速滚动状态。
  bool _onScrollNotification(ScrollNotification notification) {
    if (notification.metrics.axis != Axis.vertical) return false;
    _scrollOffset = notification.metrics.pixels;
    _viewportHeight = notification.metrics.viewportDimension;

    if (notification is ScrollUpdateNotification) {
      // 用「两次通知的像素差 / 时间差」估算速度（逻辑像素/秒）。3.24.5 的
      // ScrollUpdateNotification 没有 duration 字段，因此用 Stopwatch 自己计时。
      final double delta = notification.metrics.pixels - _lastScrollPixels;
      final int elapsed = _scrollClock.elapsedMicroseconds;
      final int micros = elapsed - _lastScrollElapsedMicros;
      _lastScrollPixels = notification.metrics.pixels;
      _lastScrollElapsedMicros = elapsed;
      if (micros > 0) {
        final double velocity = delta / (micros / 1000000);
        _setFastScrolling(velocity.abs() > _kFastScrollVelocity);
      }
    }
    if (notification is ScrollEndNotification || notification is ScrollStartNotification) {
      // 停止 / 刚开始：先复位（开始滚动时若速度没超阈值就保持 false）。
      _scrollClock..reset()..start();
      _lastScrollElapsedMicros = 0;
      _lastScrollPixels = notification.metrics.pixels;
      _scheduleFastScrollReset();
    }
    return false; // 不拦截，GridView 自己的滚动照常。
  }

  void _setFastScrolling(bool fast) {
    if (ref.read(fastScrollingProvider) == fast) return;
    if (!fast) {
      _fastScrollReset?.cancel();
    }
    ref.read(fastScrollingProvider.notifier).state = fast;
  }

  void _scheduleFastScrollReset() {
    _fastScrollReset?.cancel();
    _fastScrollReset = Timer(_kFastScrollResetDelay, () {
      if (mounted) _setFastScrolling(false);
    });
  }

  // ---------------------------------------------------------------------------
  // 自定义顺序：乐观覆盖 + 拖拽落点计算
  // ---------------------------------------------------------------------------

  /// 把服务端列表按本地乐观顺序重排；不在本地顺序里的新条目按服务端顺序追加在末尾。
  List<GameSummary> _applyCustomOrder(List<GameSummary> games) {
    final List<GameSummary>? override = _customOrder;
    if (override == null || override.isEmpty) return games;
    final Map<String, GameSummary> byId = <String, GameSummary>{
      for (final GameSummary g in games) g.id: g,
    };
    final List<GameSummary> merged = <GameSummary>[
      for (final GameSummary g in override)
        if (byId.containsKey(g.id)) byId[g.id]!,
    ];
    final Set<String> placed = merged.map((GameSummary g) => g.id).toSet();
    for (final GameSummary g in games) {
      if (!placed.contains(g.id)) merged.add(g);
    }
    return merged;
  }

  /// 计算「逻辑插入下标」：拖拽项从原位置移除后，应插到列表的哪个下标。
  ///
  /// why：命中格子的下标是**移除前**的坐标系。若拖拽项在命中格之前（draggedIndex < target），
  /// 移除后其后的所有条目下标都减 1，故目标下标也要减 1。
  static int insertionIndex({
    required int draggedIndex,
    required int hoverIndex,
    required bool rightHalf,
  }) {
    int target = rightHalf ? hoverIndex + 1 : hoverIndex;
    if (draggedIndex < target) target -= 1;
    return target < 0 ? 0 : target;
  }

  /// 插入指示条应画在命中格的哪一侧。
  /// 与 [insertionIndex] 的结果保持一致，保证「指示条在哪，卡片就落在哪」。
  static bool _indicatorOnRight({
    required int draggedIndex,
    required int hoverIndex,
    required bool rightHalf,
  }) {
    return hoverIndex >= draggedIndex ? !rightHalf : rightHalf;
  }

  /// 命中卡片是否需要显示插入指示条；需要时返回 true = 画在右边缘。
  bool? _indicatorSideFor(int index) {
    final int? hover = _hoverIndex;
    final int? dragged = _draggedIndex;
    if (hover == null || dragged == null || hover != index) return null;
    return _indicatorOnRight(
      draggedIndex: dragged,
      hoverIndex: hover,
      rightHalf: _hoverRightHalf,
    );
  }

  Widget _buildDraggableCell({
    required BuildContext context,
    required Widget card,
    required GameSummary game,
    required int index,
    required double cellWidth,
    required double cellHeight,
  }) {
    final bool? indicatorRight = _indicatorSideFor(index);

    return DragTarget<String>(
      // 命中判定：只接受「不是自己」的拖拽项。
      onWillAcceptWithDetails: (DragTargetDetails<String> details) {
        if (details.data == game.id) return false;
        final RenderBox? box = context.findRenderObject() as RenderBox?;
        bool rightHalf = false;
        if (box != null && box.hasSize) {
          final Offset local = box.globalToLocal(details.offset);
          rightHalf = local.dx > box.size.width / 2;
        }
        setState(() {
          _hoverIndex = index;
          _hoverRightHalf = rightHalf;
        });
        return true;
      },
      onLeave: (String? data) {
        if (_hoverIndex == index) setState(() => _hoverIndex = null);
      },
      onAcceptWithDetails: (DragTargetDetails<String> details) {
        final int? hover = _hoverIndex;
        final bool rightHalf = _hoverRightHalf;
        setState(() => _hoverIndex = null);
        if (hover == null) return;
        _onReorder(gameId: details.data, hoverIndex: hover, rightHalf: rightHalf);
      },
      builder: (BuildContext context, List<String?> candidate, List<dynamic> rejected) {
        final Widget content = Stack(
          fit: StackFit.expand,
          children: <Widget>[
            card,
            if (indicatorRight != null)
              // 插入指示：一条竖直高亮条，贴命中格左/右边缘（参考 web 端观感）。
              Align(
                alignment: indicatorRight ? Alignment.centerRight : Alignment.centerLeft,
                child: Container(
                  width: 3,
                  margin: const EdgeInsets.symmetric(vertical: 4),
                  decoration: BoxDecoration(
                    color: const Color(0xFF00E5FF),
                    borderRadius: BorderRadius.circular(2),
                    boxShadow: const <BoxShadow>[
                      BoxShadow(color: Color(0x8800E5FF), blurRadius: 6),
                    ],
                  ),
                ),
              ),
          ],
        );

        return LongPressDraggable<String>(
          data: game.id,
          // 拖拽开始：记录下标 + 清掉本地覆盖，并进入「拖拽态」渲染。
          onDragStarted: () {
            setState(() {
              _draggedIndex = index;
              // 清掉本地覆盖：让命中坐标系回到「服务端顺序 = 当前渲染顺序」，与 _onReorder 的基线一致。
              _clearCustomOrderOverride();
            });
          },
          onDragEnd: (DraggableDetails details) {
            setState(() {
              _draggedIndex = null;
              _hoverIndex = null;
            });
          },
          onDraggableCanceled: (Velocity velocity, Offset offset) {
            if (!mounted) return;
            setState(() {
              _draggedIndex = null;
              _hoverIndex = null;
            });
          },
          feedback: _DragFeedback(
            width: cellWidth,
            height: cellHeight,
            child: card,
          ),
          // 原位置半透明占位，让用户看到「卡片已经被拿起来」。
          childWhenDragging: Opacity(opacity: 0.35, child: card),
          child: content,
        );
      },
    );
  }

  /// 拖拽落点 → 本地乐观重排 + 调 reorderGamesProvider 同步；失败回滚 + 中文提示。
  Future<void> _onReorder({
    required String gameId,
    required int hoverIndex,
    required bool rightHalf,
  }) async {
    // 拖拽期间覆盖已被清空 → 渲染顺序即服务端顺序，就是本地重排的基线。
    final List<GameSummary> base = _customOrder ?? _renderedOrder;
    if (base.isEmpty) return;
    final int draggedIndex = base.indexWhere((GameSummary g) => g.id == gameId);
    if (draggedIndex < 0) return;

    final int target = insertionIndex(
      draggedIndex: draggedIndex,
      hoverIndex: hoverIndex,
      rightHalf: rightHalf,
    );
    if (target == draggedIndex) return; // 原地落回，不发请求。

    final List<GameSummary> snapshot = <GameSummary>[...base];

    // 1) 本地乐观重排（立刻刷新 UI）。
    final List<GameSummary> next = <GameSummary>[...base];
    final GameSummary moving = next.removeAt(draggedIndex);
    final int insertAt = target.clamp(0, next.length);
    next.insert(insertAt, moving);

    // 2) 后端语义（见 backend/src/games/games.service.ts:1492-1550 的注释）：
    //    afterId = 结果里排在拖动卡片**上方/之前**的邻居（"the card above the drop point"）；
    //    beforeId = 结果里排在拖动卡片**下方/之后**的邻居（"the card below the drop point"）。
    //    即命名与「视觉上下」相反、与 Web 端一致（web/src/pages/Home.tsx:176：
    //    reorder.mutate({ gameId, beforeId: below?.id ?? null, afterId: above?.id ?? null })）。
    //    ⚠️ 传反会让后端 mid = floor((after+before)/2) 后恒有 mid <= after ⇒ 无限递归 renumber（500）。
    //    到列表头/尾时对应邻居传 null。
    final String? aboveId = insertAt > 0 ? next[insertAt - 1].id : null; // 结果里在它前面
    final String? belowId =
        insertAt < next.length - 1 ? next[insertAt + 1].id : null; // 结果里在它后面

    setState(() => _customOrder = next);

    try {
      await ref.read(reorderGamesProvider.notifier).run(
            gameId: gameId,
            beforeId: belowId,
            afterId: aboveId,
          );
      // 成功后 provider 层已失效 gamesProvider；清空覆盖让服务端顺序接管。
      if (!mounted) return;
      setState(_clearCustomOrderOverride);
    } catch (_) {
      // 失败：回滚到拖拽前的本地快照，并用中文提示用户。
      if (!mounted) return;
      setState(() => _customOrder = snapshot.isEmpty ? null : snapshot);
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('排序同步失败')),
      );
    }
  }

  static String _friendlyError(Object error) {
    if (error is ApiException) return error.message;
    return '无法连接后端，请在设置中检查服务器地址。';
  }
}

/// 拖拽跟手卡片：略放大 + 阴影，保证「拿起来了」的观感。
class _DragFeedback extends StatelessWidget {
  const _DragFeedback({required this.width, required this.height, required this.child});

  final double width;
  final double height;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Transform.scale(
      scale: 1.04,
      child: SizedBox(
        width: width,
        height: height,
        child: Material(
          color: Colors.transparent,
          elevation: 12,
          borderRadius: BorderRadius.circular(12),
          child: child,
        ),
      ),
    );
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