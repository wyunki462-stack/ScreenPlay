// ScreenPlay 品牌标记 —— 页面里的「同一枚图标」，与 Web 页眉品牌块逐像素同源。
//
// 真源：`web/public/favicon.svg`（App 图标 / Windows 图标 / 安卓图标都由
// `node scripts/brand-icons.mjs` 从它生成，几何常量在 `widgets/brand_glyph.dart`）。
//
// 与 Web 的对应关系（`web/src/App.tsx:52-56` 页眉品牌块、`web/src/pages/Login.tsx:36-37`）：
//   <span class="h-9 w-9 rounded-lg bg-gradient-to-br from-violet-600 to-cyan-500">
//     <Gamepad2 class="h-5 w-5 text-white" />
//   —— 36px 圆角方块（rounded-lg = 8px）+ 对角渐变 #7C3AED→#06B6D4 + 20px 白色 Gamepad2。
//   所以本组件的字形占位比例是 20/36（而不是 favicon 里 36 单位几何的 ~31%）：
//   Web 端自己就是这么分工的 —— **应用图标用 favicon.svg，页眉用 20/36 的 Gamepad2**。
//   App 端照抄同一套分工：launcher 图标 == Web favicon == Windows 图标 == 安卓图标，
//   AppBar 左上角标记 == Web 页眉标记。字形本身（Gamepad2 path + stroke-width 2）
//   完全来自 favicon 真源，没有另画。

import 'package:flutter/material.dart';

import 'brand_glyph.dart';

/// 字形在标记内的占位比例 —— 对齐 Web 页眉：`h-9 w-9`(36px) 里放 `h-5 w-5`(20px)。
const double kBrandMarkGlyphRatio = 20 / 36;

/// Gamepad2 字形自身的 viewBox 边长（lucide 图标集与 favicon 都是 24）。
const double kBrandGlyphViewBox = 24;

/// 品牌方块（渐变底 + 白色字形）。
class BrandMark extends StatelessWidget {
  const BrandMark({super.key, this.size = 36, this.shadow = false});

  /// 方块边长（Web 页眉是 36）。
  final double size;

  /// 是否加投影：登录 / 连接页等大尺寸场景更立体；AppBar 里不需要。
  final bool shadow;

  @override
  Widget build(BuildContext context) {
    final double scale = size / kBrandBoxSize;
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(kBrandCornerRadius * scale),
        gradient: const LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: <Color>[Color(kBrandGradientStart), Color(kBrandGradientEnd)],
        ),
        boxShadow: shadow
            ? <BoxShadow>[
                BoxShadow(
                  color: const Color(0xFF2E1065).withOpacity(0.45),
                  blurRadius: 10 * scale,
                  offset: Offset(0, 4 * scale),
                ),
              ]
            : null,
      ),
      child: const CustomPaint(painter: _BrandGlyphPainter()),
    );
  }
}

/// 画白色 Gamepad2 字形：字形框占方块 [kBrandMarkGlyphRatio]，居中，描边随比例缩放
/// （对齐 Web 页眉里 `h-5 w-5` 的 Gamepad2：lucide 默认 stroke-width = 2 / 24 单位）。
class _BrandGlyphPainter extends CustomPainter {
  const _BrandGlyphPainter();

  @override
  void paint(Canvas canvas, Size size) {
    if (size.isEmpty) return;
    final double glyphBox = size.width * kBrandMarkGlyphRatio;
    final double glyphScale = glyphBox / kBrandGlyphViewBox;
    final Paint paint = Paint()
      ..style = PaintingStyle.stroke
      ..color = const Color(0xFFFFFFFF)
      ..strokeWidth = kBrandStrokeWidth
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round;

    canvas.save();
    // 居中放置 24 单位的字形 viewBox，再按 viewBox → 字形框缩放。
    canvas.translate((size.width - glyphBox) / 2, (size.height - glyphBox) / 2);
    canvas.scale(glyphScale, glyphScale);
    canvas.drawPath(buildBrandGlyphPath(), paint);
    canvas.restore();
  }

  @override
  bool shouldRepaint(covariant _BrandGlyphPainter oldDelegate) => false;
}