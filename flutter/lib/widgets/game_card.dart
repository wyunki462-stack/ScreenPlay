// 游戏卡片：海报（渐变占位兜底）+ 名称 + 时长 + 颜色编码的 Metacritic 徽章。

import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';

import '../models/models.dart';

class GameCard extends StatelessWidget {
  const GameCard({
    super.key,
    required this.game,
    required this.posterUrl,
    required this.onTap,
  });

  final GameSummary game;

  /// 已拼好的绝对海报地址（null → 占位渐变）。
  final String? posterUrl;
  final VoidCallback onTap;

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
      child: InkWell(
        onTap: onTap,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            // 海报区（2:3 比例）。
            AspectRatio(
              aspectRatio: 2 / 3,
              child: _Poster(posterUrl: posterUrl, name: game.name),
            ),
            Padding(
              padding: const EdgeInsets.all(10),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(
                    game.name,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: theme.textTheme.titleSmall?.copyWith(
                      fontWeight: FontWeight.w600,
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

/// 海报区域：CachedNetworkImage，加载中/失败显示紫→青渐变占位与首字母。
class _Poster extends StatelessWidget {
  const _Poster({required this.posterUrl, required this.name});

  final String? posterUrl;
  final String name;

  @override
  Widget build(BuildContext context) {
    final Widget fallback = _GradientPlaceholder(text: name);
    if (posterUrl == null || posterUrl!.isEmpty) return fallback;
    return CachedNetworkImage(
      imageUrl: posterUrl!,
      fit: BoxFit.cover,
      placeholder: (BuildContext context, String url) => fallback,
      errorWidget: (BuildContext context, String url, Object error) => fallback,
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