// 游戏卡片：海报区（16:9，可在 slideshow 模式下左右滑动/自动轮播）+ 名称 + 时长 +
// 颜色编码的 Metacritic 徽章。
//
// 1.3.2 变化（安卓端，与 Web 端逻辑对齐）：
//  - 海报区固定 16:9（[GameCard.posterAspectRatio]，等同 Web 端卡片的 `aspect-video`）：
//    横版海报完整入画、竖版海报居中裁切，不再是原先按 2:3 假设拉出来的长条。
//  - 轮播开关来自后端 `posterMode`（[GameSummary.slideshowEnabled]），与 Web 端
//    `mode={game.posterMode ?? "static"}` 同源：只有 slideshow 才建可滑动的 [PageView]
//    并自动翻页；static 只显示封面（Linux/Web 端一改，移动端刷新即生效）。
//  - 自动翻页 3500ms（= Web 端 useRotationTimer 默认值），按住时暂停、手动切图后静默
//    2 个间隔；左上角显示 `n/总数` 计数徽章（= Web 端首页卡片，不显示圆点指示器）。
//  - 删掉了 1.3.1 的「手势吸收层」：那层 `HitTestBehavior.opaque` 的 GestureDetector 是
//    Stack 最上层，会终止命中测试 ⇒ PageView 永远收不到指针事件、左右滑动切图其实是死的。
//    整卡点击改由外层 Card > InkWell 承担（见 _PosterSlideshow.build 注释）。
//  - 数据来源与 Web 端一致：由列表页传入 `api.cardPosterSources(game)`（封面 + 后端
//    `cardPosters()` 给出的轮播集合）。卡片的 postersProvider 预取只在调用方没给列表时
//    作为兜底保留。
//  - 低功耗：仅当 preloadAllowedProvider == true（前台且非快速滚动）时才 watch
//    postersProvider；自动翻页用单次链式定时器，离屏/暂停/退后台就不再续期。

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/api_client.dart';
import '../core/app_lifecycle.dart';
import '../models/models.dart';
import '../providers/api_providers.dart';
import 'authed_image.dart';

class GameCard extends StatelessWidget {
  const GameCard({
    super.key,
    required this.game,
    required this.posterUrl,
    required this.onTap,
    this.posterUrls = const <String>[],
    this.allowPosterPrefetch = false,
  });

  final GameSummary game;

  /// 已拼好的绝对海报地址（null → 占位渐变）。轮播不可用时的唯一回退图。
  final String? posterUrl;
  final VoidCallback onTap;

  /// 轮播用的**已解析为绝对地址**的海报列表（空列表 → 卡片自己按需拉取或者回退）。
  final List<String> posterUrls;

  /// 是否允许该卡片发起海报请求（前台且非快速滚动、且在可见预取窗口内时为 true）。
  final bool allowPosterPrefetch;

  /// 海报区宽高比：16:9（与 Web 端卡片海报区的 `aspect-video` 一致）。
  ///
  /// 横版海报正好铺满；竖版海报按 BoxFit.cover 居中裁切，不拉伸变形。
  /// 网格的 childAspectRatio 由 home_screen 按这个比例反推（见 _childAspectRatioFor）。
  static const double posterAspectRatio = 16 / 9;

  /// Metacritic 评分颜色：≥75 绿 / 50~74 黄 / <50 红。
  static Color metacriticColor(int score) {
    if (score >= 75) return const Color(0xFF6CCF59);
    if (score >= 50) return const Color(0xFFF5C542);
    return const Color(0xFFFC6255);
  }

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    return Card(
      clipBehavior: Clip.antiAlias,
      // 只保留水平外边距：GridView 的 mainAxisSpacing 已经负责竖直间隔。若这里再留
      // 竖直 margin，同一行的卡片会凭空变矮，长标题更容易把底部信息行挤到溢出。
      margin: const EdgeInsets.symmetric(horizontal: 4),
      child: InkWell(
        onTap: onTap,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            // 海报区：优先跟随格子高度（Flexible），比例固定 16:9（= Web 端 aspect-video）。
            // 万一格子比「海报 + 信息行」的下限还矮，海报收缩而不是底部文字溢出。
            Flexible(
              child: AspectRatio(
                aspectRatio: posterAspectRatio,
                child: _PosterSlideshow(
                  game: game,
                  posterUrl: posterUrl,
                  posterUrls: posterUrls,
                  allowPosterPrefetch: allowPosterPrefetch,
                  onTap: onTap,
                ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(10, 8, 10, 10),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(
                    game.name,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: theme.textTheme.titleSmall?.copyWith(
                      fontWeight: FontWeight.w600,
                      height: 1.2,
                    ),
                  ),
                  const SizedBox(height: 6),
                  Row(
                    children: <Widget>[
                      const Icon(Icons.schedule, size: 14, color: Color(0xFF9E96B5)),
                      const SizedBox(width: 4),
                      Expanded(
                        child: Text(
                          game.durationText.isNotEmpty ? game.durationText : '时长未知',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: theme.textTheme.bodySmall?.copyWith(
                            color: const Color(0xFF9E96B5),
                            height: 1.1,
                          ),
                        ),
                      ),
                      if (game.metacriticScore != null) _MetacriticBadge(score: game.metacriticScore!),
                    ],
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

/// 海报轮播区：多张海报可左右滑动 + 页码指示点。
class _PosterSlideshow extends ConsumerStatefulWidget {
  const _PosterSlideshow({
    required this.game,
    required this.posterUrl,
    required this.posterUrls,
    required this.allowPosterPrefetch,
    required this.onTap,
  });

  final GameSummary game;
  final String? posterUrl;
  final List<String> posterUrls;
  final bool allowPosterPrefetch;

  /// 卡片的进详情页回调（海报区点击转交用）。
  final VoidCallback onTap;

  @override
  ConsumerState<_PosterSlideshow> createState() => _PosterSlideshowState();
}

class _PosterSlideshowState extends ConsumerState<_PosterSlideshow> {
  /// 自动翻页间隔：与 Web 端 useRotationTimer 默认值一致
  /// （web/src/lib/hooks.ts:38-57，intervalMs = 3500）。
  static const Duration _kRotationInterval = Duration(milliseconds: 3500);

  /// 手动切图后要跳过的自动翻页次数。
  ///
  /// 与 Web 端一致：手动切换时 `resumeAt = Date.now() + intervalMs * 2`
  /// （web/src/components/PosterCarousel.tsx:87），即静默约 2 个间隔后恢复自动轮播。
  /// 这里刻意用「跳过 N 次 tick」而不是记绝对时间戳：`DateTime.now()` 取真实墙钟，
  /// widget test 的假时钟推进不会让它前进，绝对时间戳会让静默期在测试里永不结束
  /// （也会在设备休眠/唤醒后行为古怪）。
  static const int _kManualSkipTicks = 1;

  /// 单次翻页动画时长。
  static const Duration _kAdvanceDuration = Duration(milliseconds: 320);

  final PageController _controller = PageController();
  int _page = 0;

  /// 当前渲染出的海报张数（build 里记录，供定时器判定）。
  int _count = 0;

  /// 自动翻页定时器：**单次链式**而非 periodic —— 离屏、暂停、退后台时不再续期，
  /// 避免列表里每张轮播卡都挂着长跑定时器（低功耗优先）。
  Timer? _timer;

  /// 手指是否还按在海报区上（按住不翻页；与 Web 端 hover 暂停同义）。
  bool _pressed = false;

  /// 手动切图后还需跳过几次自动翻页（0 = 恢复正常轮播）。
  int _skipTicks = 0;

  /// 是否正由自动轮播驱动翻页（用于区分「手动滑动」与「自动翻页」）。
  bool _advancing = false;

  /// 屏幕矩形（build 里缓存，定时器回调里不查 MediaQuery）。
  Rect _viewport = Rect.zero;

  @override
  void initState() {
    super.initState();
    _schedule();
  }

  @override
  void dispose() {
    _timer?.cancel();
    _timer = null;
    _controller.dispose();
    super.dispose();
  }

  /// 海报列表 / 轮播状态刷新后：
  ///  - 轮播被关掉（posterMode 变回 static）或海报集合变了 → 停表并回到第 1 张；
  ///  - 仍轮播 → 续一次定时器，页码夹回合法范围。
  @override
  void didUpdateWidget(covariant _PosterSlideshow oldWidget) {
    super.didUpdateWidget(oldWidget);
    final bool setChanged = oldWidget.game.posterMode != widget.game.posterMode ||
        oldWidget.posterUrls.join('|') != widget.posterUrls.join('|');
    if (setChanged) {
      _timer?.cancel();
      _timer = null;
      _skipTicks = 0;
      _page = 0;
      if (_controller.hasClients) _controller.jumpToPage(0);
      _schedule();
      return;
    }
    if (!_controller.hasClients) return;
    final int page = _controller.page?.round() ?? _page;
    if (page != _page) setState(() => _page = page);
  }

  /// 现在是否应该轮播：slideshow 模式 + 至少两张海报 + 前台且非快速滚动。
  bool get _shouldRotate =>
      widget.game.slideshowEnabled && _count > 1 && ref.read(preloadAllowedProvider);

  /// 排一次自动翻页。不带 [delay] 且已有定时器在跑时不重置倒计时。
  void _schedule([Duration? delay]) {
    if (!mounted) return;
    if (_timer != null && delay == null) return;
    _timer?.cancel();
    _timer = null;
    if (!_shouldRotate) return; // 不轮播就不挂定时器（零额外唤醒）
    _timer = Timer(delay ?? _kRotationInterval, _onTick);
  }

  void _onTick() {
    _timer = null;
    if (!mounted || !_shouldRotate) return;
    if (_pressed) {
      _schedule(); // 手指按住：只续期，不翻页
      return;
    }
    if (_skipTicks > 0) {
      _skipTicks--; // 手动切图后的静默期：这一拍不翻页
      _schedule();
      return;
    }
    if (!_isOnScreen()) {
      _schedule(); // 卡片滚出屏幕：只续期，不做无用动画
      return;
    }
    _advance();
  }

  /// 自动翻到下一张（到尾则回到第 1 张，与 Web 端 `(i + 1) % count` 一致）。
  Future<void> _advance() async {
    if (!mounted) return;
    final int count = _count;
    if (count <= 1 || !_controller.hasClients) {
      _schedule();
      return;
    }
    final int next = (_page + 1) % count;
    _advancing = true;
    try {
      await _controller.animateToPage(
        next,
        duration: _kAdvanceDuration,
        curve: Curves.easeOut,
      );
    } finally {
      _advancing = false;
    }
    _schedule();
  }

  /// 卡片是否与屏幕相交（屏幕外不做翻页动画）。
  bool _isOnScreen() {
    final RenderObject? object = context.findRenderObject();
    if (object is! RenderBox || !object.attached || !object.hasSize) return false;
    final Rect self = object.localToGlobal(Offset.zero) & object.size;
    return self.overlaps(_viewport);
  }

  /// 海报优先级（需求语义，不可随意调换）：
  ///   1. inSlideshow == true 的海报（用户勾选了「加入幻灯片」的）；
  ///   2. 其余里 isSelected / isCover 的（当前选中 / 封面）；
  ///   3. 再其余按 sortOrder / createdAt 稳定排列，最后回退到列表第一张。
  /// 排序稳定，保证轮播顺序在不同刷新之间不会乱跳。
  static List<Poster> _prioritize(List<Poster> posters) {
    int weight(Poster p) {
      if (p.inSlideshow) return 0;
      if (p.isSelected || p.isCover) return 1;
      return 2;
    }

    final List<Poster> sorted = <Poster>[...posters];
    sorted.sort((Poster a, Poster b) {
      final int byWeight = weight(a).compareTo(weight(b));
      if (byWeight != 0) return byWeight;
      final int byOrder = a.sortOrder.compareTo(b.sortOrder);
      if (byOrder != 0) return byOrder;
      final int byCreated = (a.createdAt?.millisecondsSinceEpoch ?? 0)
          .compareTo(b.createdAt?.millisecondsSinceEpoch ?? 0);
      if (byCreated != 0) return byCreated;
      return a.id.compareTo(b.id);
    });
    return sorted;
  }

  /// 把 Poster 的相对地址拼成绝对地址；列表缩略图统一取 thumbnail 档（小、快）。
  /// 远端 CDN 绝对地址（rawg/steamstatic）走 `imageSource` → 后端 `/api/media/proxy`。
  List<String> _resolve(List<Poster> posters) {
    final ApiClient api = ref.read(apiClientProvider);
    final List<String> urls = <String>[];
    for (final Poster poster in _prioritize(posters)) {
      final String? thumb = poster.thumbUrl;
      final String raw = (thumb != null && thumb.isNotEmpty) ? thumb : poster.url;
      if (raw.isEmpty) continue;
      final String absolute = api.cardImageSource(raw);
      if (absolute.isNotEmpty && !urls.contains(absolute)) urls.add(absolute);
    }
    return urls;
  }

  @override
  Widget build(BuildContext context) {
    // 屏幕矩形缓存给定时器用（定时器回调里不查 MediaQuery）。
    _viewport = Offset.zero & MediaQuery.sizeOf(context);

    // 调用方（列表）已预先解析好海报时才直接用；否则仅当允许预取时自己去拉。
    final bool mayWatch = widget.posterUrls.isEmpty && widget.allowPosterPrefetch &&
        ref.watch(preloadAllowedProvider);

    // 条件式 watch：条件为 false 时该调用根本不执行 → 不建立依赖，离屏卡片零请求。
    // 这也是「超出可见范围的离屏卡片不发起海报请求」的实现方式（是否进入可见范围的
    // 判定在 home_screen，卡片只是在被允许时才订阅）。
    final AsyncValue<List<Poster>>? postersAsync =
        mayWatch ? ref.watch(postersProvider(widget.game.id)) : null;

    final List<String> urls = widget.posterUrls.isNotEmpty
        ? widget.posterUrls
        : (postersAsync?.valueOrNull != null ? _resolve(postersAsync!.valueOrNull!) : const <String>[]);
    _count = urls.length;

    // 轮播开关来自后端 posterMode（与 Web 端 `mode={game.posterMode ?? "static"}` 同源）：
    // 只有 slideshow 才建可滑动的 PageView + 自动翻页；static 只显示封面。
    final bool slideshow = widget.game.slideshowEnabled && urls.length > 1;

    // 保证「该轮播时总有一个待触发的定时器」；已在跑的倒计时不重置。
    if (_timer == null && _shouldRotate) _schedule();

    if (!slideshow) {
      // 静态卡片（或轮播关掉 / 只有一张）：外观与单图时完全一致（封面 + 渐变兜底）。
      return _Poster(
        posterUrl: urls.isNotEmpty ? urls.first : widget.posterUrl,
        name: widget.game.name,
      );
    }

    final int page = _page.clamp(0, urls.length - 1);
    return Stack(
      fit: StackFit.expand,
      children: <Widget>[
        // 按住即暂停自动翻页（= Web 端 hover 暂停）；Listener 只旁观、不参与手势竞技场，
        // 所以左右滑动照旧交给 PageView。
        //
        // 这里**不能**再放 1.3.1 那层 `HitTestBehavior.opaque` 的 GestureDetector：它是
        // Stack 的最上层且 opaque ⇒ 命中测试到此终止 ⇒ PageView 收不到指针事件，滑动切图
        // 实际是死的。整卡点击由外层 Card > InkWell(onTap) 兜住（Tap 与 PageView 的横向
        // Drag 在手势竞技场里按方向区分，互不打架）。
        Listener(
          onPointerDown: (_) => _pressed = true,
          onPointerUp: (_) => _pressed = false,
          onPointerCancel: (_) => _pressed = false,
          child: PageView.builder(
            controller: _controller,
            itemCount: urls.length,
            onPageChanged: (int index) {
              if (!mounted) return;
              setState(() => _page = index);
              if (_advancing) return; // 自动翻页已自带节奏，不再叠加静默期
              // 手动切图 → 静默 2 个间隔后恢复自动翻页（Web: resumeAt = now + interval*2），
              // 并把倒计时从这一刻重新计起（用户刚翻到的那张至少能看满一个间隔）。
              _skipTicks = _kManualSkipTicks;
              _timer?.cancel();
              _timer = null;
              _schedule();
            },
            itemBuilder: (BuildContext context, int index) => _Poster(
              posterUrl: urls[index],
              name: widget.game.name,
            ),
          ),
        ),
        // 计数徽章：左上角 `当前张/总张`（与 Web 端首页卡片的 PosterCarousel 计数一致，
        // Web 首页卡片 showDots=false ⇒ 这里也不放圆点指示器）。
        Positioned(
          left: 6,
          top: 6,
          child: DecoratedBox(
            decoration: BoxDecoration(
              color: const Color(0x99000000),
              borderRadius: BorderRadius.circular(999),
            ),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
              child: Text(
                '${page + 1}/${urls.length}',
                style: const TextStyle(
                  color: Color(0xE6FFFFFF),
                  fontSize: 10,
                  fontWeight: FontWeight.w500,
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }
}

/// 海报区域：CachedNetworkImage（走 screenplayImageCache 三级缓存），
/// 加载中/失败显示紫→青渐变占位与首字母。
///
/// 为什么显式传 cacheManager：Flutter 默认 CacheManager 只有 200 条 / 30 天，
/// 列表滚过大量海报后会反复回源；统一走 core/image_cache.dart 的单例（600 条磁盘、
/// 80 MiB 内存上限），已加载图片优先命中本地缓存。
class _Poster extends StatelessWidget {
  const _Poster({required this.posterUrl, required this.name});

  final String? posterUrl;
  final String name;

  @override
  Widget build(BuildContext context) {
    final Widget fallback = _GradientPlaceholder(text: name);
    if (posterUrl == null || posterUrl!.isEmpty) return fallback;
    return AuthedImage(
      imageUrl: posterUrl!,
      cacheKey: posterUrl!,
      fit: BoxFit.cover,
      placeholder: (BuildContext context, String url) => fallback,
      errorWidget: (BuildContext context, String url, Object error) => fallback,
      // 淡入淡出由 AuthedImage 统一为 Duration.zero（快速滚动时逐帧动画会拖慢帧率）。
    );
  }
}

/// 渐变占位（紫罗兰 → 青色），居中显示游戏名首字符。
class _GradientPlaceholder extends StatelessWidget {
  const _GradientPlaceholder({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    final String initial = text.isNotEmpty ? text.substring(0, 1).toUpperCase() : '?';
    return DecoratedBox(
      decoration: const BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: <Color>[Color(0xFF2A2148), Color(0xFF006B84)],
        ),
      ),
      child: Center(
        child: Text(
          initial,
          style: const TextStyle(
            fontSize: 42,
            fontWeight: FontWeight.bold,
            color: Color(0xCCFFFFFF),
          ),
        ),
      ),
    );
  }
}

/// Metacritic 徽章（圆角小色块 + 分数）。
class _MetacriticBadge extends StatelessWidget {
  const _MetacriticBadge({required this.score});

  final int score;

  @override
  Widget build(BuildContext context) {
    final Color color = GameCard.metacriticColor(score);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
      decoration: BoxDecoration(
        color: color.withOpacity(0.18),
        borderRadius: BorderRadius.circular(6),
        border: Border.all(color: color.withOpacity(0.55)),
      ),
      child: Text(
        '$score',
        style: TextStyle(
          color: color,
          fontSize: 13,
          fontWeight: FontWeight.bold,
        ),
      ),
    );
  }
}