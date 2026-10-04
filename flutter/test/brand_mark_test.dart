// 品牌图标一致性测试 —— 锁住「三端视觉一致」（④）。
//
// 唯一真源：`web/public/favicon.svg`（Web favicon / Windows 安装包图标 / 安卓自适应图标 /
// App 内 [BrandMark] 全部由 `node scripts/brand-icons.mjs` 从它生成）。这里断言生成出来的
// Dart 常量、字形路径、安卓资源仍然与真源同源，防止有人手改单端导致三端不一致。

import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:screenplay/widgets/brand_glyph.dart';
import 'package:screenplay/widgets/brand_mark.dart';

void main() {
  group('品牌常量与 web/public/favicon.svg 一致', () {
    test('方块尺寸 / 圆角 / 字形 transform / 描边宽度', () {
      expect(kBrandBoxSize, 36); // viewBox="0 0 36 36"
      expect(kBrandCornerRadius, 8); // <rect rx="8">
      expect(kBrandGlyphOffset, 11.33333); // translate(11.33333 11.33333)
      expect(kBrandGlyphScale, 0.555556); // scale(0.555556)
      expect(kBrandStrokeWidth, 2); // stroke-width="2"
    });

    test('渐变两端与 Web 品牌块一致（violet-600 → cyan-500）', () {
      expect(kBrandGradientStart, 0xFF7C3AED); // from-violet-600 → #7c3aed
      expect(kBrandGradientEnd, 0xFF06B6D4); // to-cyan-500  → #06b6d4
    });
  });

  group('字形几何', () {
    test('包围盒落在 24 单位 glyph 空间内', () {
      final Rect bounds = buildBrandGlyphPath().getBounds();
      // 手柄轮廓 x∈[2,22]、y∈[5,19]；曲线控制点也在这个范围内。
      expect(bounds.left, closeTo(2.0, 0.01));
      expect(bounds.top, closeTo(5.0, 0.01));
      expect(bounds.right, closeTo(22.0, 0.01));
      expect(bounds.bottom, closeTo(19.0, 0.01));
    });

    test('按 favicon 的 transform 映射后（含描边）完全在 36 方块内', () {
      // 这一条守的是「应用图标」那一侧：favicon.svg / Windows 图标 / 安卓自适应图标
      // 都由 scripts/brand-icons.mjs 按同一 transform 从字形生成。
      final Rect bounds = buildBrandGlyphPath().getBounds();
      const double halfStroke = kBrandStrokeWidth * kBrandGlyphScale / 2;
      final Rect mapped = Rect.fromLTRB(
        kBrandGlyphOffset + bounds.left * kBrandGlyphScale - halfStroke,
        kBrandGlyphOffset + bounds.top * kBrandGlyphScale - halfStroke,
        kBrandGlyphOffset + bounds.right * kBrandGlyphScale + halfStroke,
        kBrandGlyphOffset + bounds.bottom * kBrandGlyphScale + halfStroke,
      );

      expect(mapped.left, greaterThanOrEqualTo(0));
      expect(mapped.top, greaterThanOrEqualTo(0));
      expect(mapped.right, lessThanOrEqualTo(kBrandBoxSize));
      expect(mapped.bottom, lessThanOrEqualTo(kBrandBoxSize));
      // favicon 里字形占方块约 1/3（20/24 的字形映射到 36 单位方块）。
      expect(mapped.width, closeTo(12.22, 0.05));
      expect(mapped.center.dx, closeTo(kBrandBoxSize / 2, 0.05));
    });

    test('App 内标记（BrandMark）用 Web 页眉的比例 20/36', () {
      // Web 页眉：h-9 w-9(36px) 方块里放 h-5 w-5(20px) 的 Gamepad2
      // ⇒ 字形框 = 方块边长 × 20/36，居中，描边随字形框缩放。
      expect(kBrandMarkGlyphRatio, closeTo(20 / 36, 1e-9));
      expect(kBrandGlyphViewBox, 24);

      const double size = 36;
      const double glyphBox = size * kBrandMarkGlyphRatio;
      const double glyphScale = glyphBox / kBrandGlyphViewBox;
      final Rect bounds = buildBrandGlyphPath().getBounds();
      final Rect painted = Rect.fromLTRB(
        (size - glyphBox) / 2 + bounds.left * glyphScale,
        (size - glyphBox) / 2 + bounds.top * glyphScale,
        (size - glyphBox) / 2 + bounds.right * glyphScale,
        (size - glyphBox) / 2 + bounds.bottom * glyphScale,
      );

      expect(painted.left, greaterThanOrEqualTo(0));
      expect(painted.top, greaterThanOrEqualTo(0));
      expect(painted.right, lessThanOrEqualTo(size));
      expect(painted.bottom, lessThanOrEqualTo(size));
      expect(painted.center.dx, closeTo(size / 2, 0.01));
      expect(painted.center.dy, closeTo(size / 2, 0.01));
      expect(painted.width, closeTo(glyphBox * 20 / 24, 0.01)); // 20px 框里的墨迹
    });
  });

  group('BrandMark 小部件', () {
    testWidgets('默认 36（favicon 同尺寸）', (WidgetTester tester) async {
      await tester.pumpWidget(const MaterialApp(
        home: Scaffold(body: Center(child: BrandMark())),
      ));

      expect(find.byType(BrandMark), findsOneWidget);
      expect(tester.getSize(find.byType(BrandMark)), const Size(36, 36));
      expect(tester.takeException(), isNull);
    });

    testWidgets('给定边长就渲染成正方形（AppBar 32 / 登录页 64 都用得到）',
        (WidgetTester tester) async {
      for (final double size in <double>[20, 32, 48, 64]) {
        await tester.pumpWidget(MaterialApp(
          home: Scaffold(body: ListView(children: <Widget>[
            Center(child: BrandMark(size: size, shadow: true)),
          ])),
        ));
        expect(tester.getSize(find.byType(BrandMark)), Size(size, size),
            reason: 'ListView（AppBar / 登录页）里也必须保持正方形');
      }
      expect(tester.takeException(), isNull);
    });
  });

  group('安卓自适应图标资源同源', () {
    File res(String name) => File('android/app/src/main/res/$name');

    test('mipmap-anydpi-v26/ic_launcher.xml 指向品牌 drawable', () {
      final String xml = res('mipmap-anydpi-v26/ic_launcher.xml').readAsStringSync();
      expect(xml.contains('@drawable/ic_launcher_background'), isTrue);
      expect(xml.contains('@drawable/ic_launcher_foreground'), isTrue);
      expect(xml.contains('<monochrome'), isTrue);
      // 旧的手写紫色三角必须已经被替换掉。
      expect(xml.contains('@color/ic_launcher_background'), isFalse);
    });

    test('前景矢量用的是品牌字形（同一段 Gamepad2 pathData）', () {
      final String xml =
          res('drawable/ic_launcher_foreground.xml').readAsStringSync();
      expect(xml.contains('android:translateX="40.66666"'), isTrue);
      expect(xml.contains('1.111112'), isTrue);
      expect(xml.contains('M17.32 5H6.68'), isTrue,
          reason: '与 favicon.svg 的 Gamepad2 轮廓逐字相同');
      expect(xml.contains('#FFFFFFFF'), isTrue);
      expect(xml.contains('#8B5CF6'), isFalse, reason: '旧紫色三角应已移除');
    });

    test('背景矢量是品牌渐变（#7C3AED → #06B6D4）', () {
      final String xml =
          res('drawable/ic_launcher_background.xml').readAsStringSync();
      expect(xml.contains('#FF7C3AED'), isTrue);
      expect(xml.contains('#FF06B6D4'), isTrue);
      expect(xml.contains('android:type="linear"'), isTrue);
    });
  });
}