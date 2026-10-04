// 游戏卡片：海报轮播（左右滑动）+ 名称 + 时长 + 颜色编码的 Metacritic 徽章。
//
// 1.3.1 变化（安卓端）：
//  - 海报区由「单张静态图」升级为 [PageView] 多张轮播 —— 用户可左右滑动切上一张/下一张，
//    底部叠加页码指示点。滑动由 PageView 的横向拖拽手势消费，不会误触发卡片点击（见
//    _PosterSlideshow 内「手势吸收层」注释）。
//  - 数据来源与 Web 端一致：由列表页传入 `api.cardPosterSources(game)`（封面 + 后端
//    `cardPosters()` 给出的轮播集合）。卡片的 postersProvider 预取只在调用方没给列表时
//    作为兜底保留。
//  - 低功耗：仅当 preloadAllowedProvider == true（前台且非快速滚动）时才 watch
//    postersProvider；否则只用调用方传入的列表，绝不额外发起海报请求。
//  - 整卡可点：海报区那层「手势吸收层」现在把点击转交给卡片的 onTap（此前它会吞掉
//    点击，导致只有下方文字区域能进详情页）。

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
            // 海报区：优先跟随格子高度（Flexible），比例由 AspectRatio 维持 2:3；
            // 万一格子比「海报 + 信息行」的下限还矮，海报收缩而不是底部文字溢出。
            Flexible(
              child: _PosterSlideshow(
                game: game,
                posterUrl: posterUrl,
                posterUrls: posterUrls,
                allowPosterPrefetch: allowPosterPrefetch,
                // 整卡可点：海报区的手势吸收层把点击转交给这里（见 _PosterSlideshow）。
                onTap: onTap,
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
  final PageController _controller = PageController();
  int _page = 0;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  /// 海报列表刷新后，若当前页已越界（例如张数变少），把页码夹回合法范围，
  /// 避免指示点显示到不存在的页。
  @override
  void didUpdateWidget(covariant _PosterSlideshow oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!_controller.hasClients) return;
    final int page = _controller.page?.round() ?? _page;
    if (page != _page) setState(() => _page = page);
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

    if (urls.length <= 1) {
      // 无轮播内容：外观与改动前完全一致（单张图 + 渐变占位兜底）。
      return _Poster(
        posterUrl: urls.isNotEmpty ? urls.first : widget.posterUrl,
        name: widget.game.name,
      );
    }

    final int page = _page.clamp(0, urls.length - 1);
    return Stack(
      fit: StackFit.expand,
      children: <Widget>[
        PageView.builder(
          controller: _controller,
          itemCount: urls.length,
          onPageChanged: (int index) => setState(() => _page = index),
          itemBuilder: (BuildContext context, int index) => _Poster(
            posterUrl: urls[index],
            name: widget.game.name,
          ),
        ),
        // 页码指示点（选中高亮）。
        Positioned(
          left: 0,
          right: 0,
          bottom: 6,
          child: _PageDots(count: urls.length, current: page),
        ),
        // 手势吸收层：把落在海报区上的点击转交给卡片自己的 onTap。
        //
        // 为什么必须加这一层：外层 Card > InkWell(onTap) 与内层 PageView 都注册了手势识别器。
        // 若海报区没有自己的点击识别器，用户「点」海报（非滑动）会在手势竞技场里被外层
        // InkWell 命中；这里显式注册一个 onTap 反而更稳：由它独占海报区的点击并调用
        // widget.onTap（= 进详情页），横向拖拽方向不同，PageView 仍会各自胜出，滑动切图
        // 不受影响。
        //
        // 这里**只**注册 onTap，不注册长按：长按拖拽由外层（自定义排序模式下的）
        // LongPressDraggable 负责，若这张吸收层也抢长按，会与 LongPressDraggable 竞争同一个
        // 长按手势、导致拖拽时灵时不灵。
        Positioned.fill(
          child: GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTap: widget.onTap,
          ),
        ),
      ],
    );
  }
}

/// 页码指示点：小圆点，当前页高亮放大。
class _PageDots extends StatelessWidget {
  const _PageDots({required this.count, required this.current});

  final int count;
  final int current;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: List<Widget>.generate(count, (int index) {
        final bool active = index == current;
        return AnimatedContainer(
          duration: const Duration(milliseconds: 150),
          margin: const EdgeInsets.symmetric(horizontal: 3),
          width: active ? 16 : 6,
          height: 6,
          decoration: BoxDecoration(
            color: active ? const Color(0xFF00E5FF) : const Color(0x99FFFFFF),
            borderRadius: BorderRadius.circular(3),
            boxShadow: const <BoxShadow>[
              BoxShadow(color: Color(0x66000000), blurRadius: 2),
            ],
          ),
        );
      }),
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