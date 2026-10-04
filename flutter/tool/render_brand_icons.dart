// 把品牌图标渲染成 PNG，供人工 / 文档核对「三端视觉一致」（用户报障 ④）。
//
// 用法（在 flutter/ 目录下）：
//   flutter test tool/render_brand_icons.dart
// 产物（覆盖写入）：
//   docs/brand-mark-192.png     —— App 内 [BrandMark]（页内标记，字形占 20/36，与 Web 页眉同比例）
//   docs/brand-launcher-192.png —— 应用图标几何（等同 web/public/favicon.svg：36 单位方块 + rx=8 +
//                                   对角渐变 + translate(11.33333 11.33333) scale(0.555556) 的字形）
//
// 纸面几何的唯一真源仍是 `scripts/brand-icons.mjs`（它断言 favicon 并生成
// `lib/widgets/brand_glyph.dart` 与安卓 VectorDrawable）；这里只是把同一套常量画出来看一眼。
//
// 注意：不放在 test/ 下，避免 `flutter test` 每次都写文件、也避免增加「跳过」计数。

import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:screenplay/widgets/brand_glyph.dart';
import 'package:screenplay/widgets/brand_mark.dart';

/// 与 `web/public/favicon.svg` 同几何：36 单位方块 + rx=8 + 对角渐变 + 变换后的字形。
class _FaviconGeometryPainter extends CustomPainter {
  const _FaviconGeometryPainter();

  @override
  void paint(Canvas canvas, Size size) {
    final double s = size.width / kBrandBoxSize;
    canvas.save();
    canvas.scale(s);
    final Rect box = Rect.fromLTWH(0, 0, kBrandBoxSize, kBrandBoxSize);
    canvas.drawRRect(
      RRect.fromRectAndRadius(box, const Radius.circular(kBrandCornerRadius)),
      Paint()
        ..shader = const LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: <Color>[Color(kBrandGradientStart), Color(kBrandGradientEnd)],
        ).createShader(box),
    );
    canvas.translate(kBrandGlyphOffset, kBrandGlyphOffset);
    canvas.scale(kBrandGlyphScale);
    canvas.drawPath(
      buildBrandGlyphPath(),
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = kBrandStrokeWidth
        ..strokeCap = StrokeCap.round
        ..strokeJoin = StrokeJoin.round
        ..color = const Color(0xFFFFFFFF),
    );
    canvas.restore();
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}

Future<void> _shot(WidgetTester tester, GlobalKey key, String path) async {
  final RenderRepaintBoundary boundary =
      key.currentContext!.findRenderObject()! as RenderRepaintBoundary;
  final ui.Image image = await boundary.toImage(pixelRatio: 1);
  final ByteData? data = await image.toByteData(format: ui.ImageByteFormat.png);
  File(path).writeAsBytesSync(data!.buffer.asUint8List());
}

void main() {
  testWidgets('渲染品牌图标 PNG（页内标记 + 应用图标几何）', (WidgetTester tester) async {
    final GlobalKey inApp = GlobalKey();
    final GlobalKey launcher = GlobalKey();
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        backgroundColor: const Color(0xFF111827),
        body: Center(
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: <Widget>[
              RepaintBoundary(key: inApp, child: const BrandMark(size: 192, shadow: true)),
              const SizedBox(width: 24),
              RepaintBoundary(
                key: launcher,
                child: const SizedBox(
                  width: 192,
                  height: 192,
                  child: CustomPaint(painter: _FaviconGeometryPainter()),
                ),
              ),
            ],
          ),
        ),
      ),
    ));
    await tester.pumpAndSettle();
    // toImage 需要真实光栅线程：必须放在 runAsync 里，否则测试会挂住。
    await tester.runAsync(() async {
      await _shot(tester, inApp, 'docs/brand-mark-192.png');
      await _shot(tester, launcher, 'docs/brand-launcher-192.png');
    });
  });
}