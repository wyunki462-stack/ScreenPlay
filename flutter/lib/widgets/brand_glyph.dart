// GENERATED FILE — 请勿手改。
// 由 `node scripts/brand-icons.mjs` 从 `web/public/favicon.svg` 生成。
//
// 为什么不手写：品牌图标是「三端同一份几何」（Web favicon / Windows gen-icons.mjs /
// 安卓自适应图标 / App 内 <BrandMark> 小部件），任何一处手抖都会让三端看上去不一样。
// 生成器每次都会逐字断言真源里的品牌常量，改图标时只能改真源 + 重新生成。
//
// 几何说明：字形写在 24 单位的 glyph 空间里，favicon.svg 用
// `transform="translate(11.33333 11.33333) scale(0.555556)"`
// 把它放进 36 单位的品牌方块。本文件保存的是 **glyph 空间的原始坐标**
// （与 SVG `<g>` 内那些数字逐字相同），应用时由 [BrandMark] 施加同一个变换。

import 'dart:ui';

/// 品牌方块边长（favicon viewBox 边长）。
const double kBrandBoxSize = 36;

/// 品牌方块圆角半径。
const double kBrandCornerRadius = 8;

/// 字形（24 单位 glyph 空间）在方块内的缩放系数与偏移。
const double kBrandGlyphScale = 0.555556;
const double kBrandGlyphOffset = 11.33333;

/// 字形描边宽度（glyph 空间）。
const double kBrandStrokeWidth = 2;

/// 品牌渐变两端（#7c3aed → #06b6d4，对角 左上 → 右下）。
const int kBrandGradientStart = 0xFF7C3AED;
const int kBrandGradientEnd = 0xFF06B6D4;

/// 字形（Gamepad2）路径 —— 4 个功能键圆点 + 手柄轮廓，全部为描边（无填充）。
///
/// 对应 SVG：`M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.15…`
Path buildBrandGlyphPath() => Path()
  ..moveTo(6, 11)
  ..lineTo(10, 11)
  ..moveTo(8, 9)
  ..lineTo(8, 13)
  ..moveTo(15, 12)
  ..lineTo(15.01, 12)
  ..moveTo(18, 10)
  ..lineTo(18.01, 10)
  ..moveTo(17.32, 5)
  ..lineTo(6.68, 5)
  ..arcToPoint(const Offset(2.702, 8.59),
      radius: const Radius.circular(4),
      largeArc: false,
      clockwise: false)
  ..cubicTo(2.696, 8.642, 2.692, 8.691, 2.685, 8.742)
  ..cubicTo(2.604, 9.416, 2, 14.456, 2, 16)
  ..arcToPoint(const Offset(5, 19),
      radius: const Radius.circular(3),
      largeArc: false,
      clockwise: false)
  ..cubicTo(6, 19, 6.5, 18.5, 7, 18)
  ..lineTo(8.414, 16.586)
  ..arcToPoint(const Offset(9.828, 16),
      radius: const Radius.circular(2),
      largeArc: false,
      clockwise: true)
  ..lineTo(14.172, 16)
  ..arcToPoint(const Offset(15.586, 16.586),
      radius: const Radius.circular(2),
      largeArc: false,
      clockwise: true)
  ..lineTo(17, 18)
  ..cubicTo(17.5, 18.5, 18, 19, 19, 19)
  ..arcToPoint(const Offset(22, 16),
      radius: const Radius.circular(3),
      largeArc: false,
      clockwise: false)
  ..cubicTo(22, 14.455, 21.396, 9.416, 21.315, 8.742)
  ..cubicTo(21.308, 8.692, 21.304, 8.642, 21.298, 8.591)
  ..arcToPoint(const Offset(17.32, 5),
      radius: const Radius.circular(4),
      largeArc: false,
      clockwise: false)
  ..close();
