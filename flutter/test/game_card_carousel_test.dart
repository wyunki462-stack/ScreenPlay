// 首页卡片轮播（用户报障 ③）回归测试：与 Web 端 PosterCarousel 行为对齐。
//
//  1. posterMode = static：只显示封面，不轮播、不可翻页（Web: rotating = false）；
//  2. posterMode = slideshow：可左右滑动切上一张/下一张（Web 箭头切换在触屏上的等价交互）；
//  3. 自动轮播间隔 3500ms（web/src/lib/hooks.ts:38-57 useRotationTimer 默认值）；
//  4. 手动切图后暂停 2 个间隔再恢复（Web: resumeAt.current = now + intervalMs * 2）。

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:screenplay/models/models.dart';
import 'package:screenplay/widgets/game_card.dart';

GameSummary _game({String mode = 'slideshow', int posterCount = 3}) => GameSummary(
      id: 'g1',
      name: '测试游戏',
      platform: 'PC',
      posterUrl: null,
      posters: <String>[
        for (int i = 0; i < posterCount; i++) 'http://test.invalid/p$i.jpg',
      ],
      posterMode: mode,
      mediaCount: 0,
      durationSeconds: 0,
      durationText: '',
      metacriticScore: null,
      firstPlayedAt: null,
      lastPlayedAt: null,
    );

Widget _host(Widget card) => ProviderScope(
      child: MaterialApp(
        home: Scaffold(
          body: Center(child: SizedBox(width: 320, height: 400, child: card)),
        ),
      ),
    );

Widget _card(GameSummary game) => GameCard(
      game: game,
      posterUrl: null,
      posterUrls: game.posters,
      onTap: () {},
    );

/// 计数器 `n/总张` 里的 n（与 Web 端 `{index + 1}/{count}` 一致）。
int _shownFrame(WidgetTester tester, int count) {
  final Finder counter = find.byWidgetPredicate(
    (Widget w) =>
        w is Text &&
        w.data != null &&
        RegExp('^\\d+/$count\$').hasMatch(w.data!),
  );
  expect(counter, findsOneWidget,
      reason: '卡片应显示「当前张/总张」计数徽章（与 Web 端一致）');
  return int.parse(tester.widget<Text>(counter).data!.split('/').first);
}

double _page(WidgetTester tester) {
  final PageView view = tester.widget<PageView>(find.byType(PageView));
  return view.controller!.page ?? 0;
}

void main() {
  testWidgets('static：只显示封面，不建轮播（数据同步：Web/Linux 关掉轮播即不轮播）',
      (WidgetTester tester) async {
    await tester.pumpWidget(_host(_card(_game(mode: 'static'))));
    await tester.pump(const Duration(milliseconds: 50));

    expect(find.byType(PageView), findsNothing,
        reason: 'posterMode=static 时不该有可翻页的轮播视图');
    expect(find.text('1/3'), findsNothing,
        reason: 'static 只展示封面，不显示轮播计数');
  });

  testWidgets('slideshow：可左右滑动切上一张/下一张', (WidgetTester tester) async {
    await tester.pumpWidget(_host(_card(_game())));
    await tester.pump(const Duration(milliseconds: 50));

    expect(find.byType(PageView), findsOneWidget);
    expect(_shownFrame(tester, 3), 1);

    final Rect poster = tester.getRect(find.byType(PageView));
    await tester.dragFrom(poster.center, const Offset(-260, 0));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 600));

    expect(_page(tester), closeTo(1, 0.05), reason: '左滑必须切到第 2 张');
    expect(_shownFrame(tester, 3), 2);
  });

  testWidgets('slideshow：每 3500ms 自动翻页（与 Web 端 intervalMs 一致）',
      (WidgetTester tester) async {
    await tester.pumpWidget(_host(_card(_game())));
    await tester.pump(const Duration(milliseconds: 50));
    expect(_shownFrame(tester, 3), 1);

    await tester.pump(const Duration(milliseconds: 3600));
    await tester.pump(const Duration(milliseconds: 400));
    expect(_shownFrame(tester, 3), 2, reason: '一个间隔后自动翻到第 2 张');

    await tester.pump(const Duration(milliseconds: 3500));
    await tester.pump(const Duration(milliseconds: 400));
    expect(_shownFrame(tester, 3), 3, reason: '再一个间隔到第 3 张');
  });

  testWidgets('手动切图后暂停 2 个间隔，不立刻被自动轮播抢走',
      (WidgetTester tester) async {
    await tester.pumpWidget(_host(_card(_game())));
    await tester.pump(const Duration(milliseconds: 50));

    final Rect poster = tester.getRect(find.byType(PageView));
    await tester.dragFrom(poster.center, const Offset(-260, 0));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 600));
    expect(_shownFrame(tester, 3), 2);

    // 静默期内（< 7s）不该自动翻页。
    await tester.pump(const Duration(milliseconds: 3600));
    await tester.pump(const Duration(milliseconds: 400));
    expect(_shownFrame(tester, 3), 2, reason: '手动切图后 2 个间隔内保持不动');

    // 静默期结束后恢复自动轮播。
    await tester.pump(const Duration(milliseconds: 3500));
    await tester.pump(const Duration(milliseconds: 400));
    expect(_shownFrame(tester, 3), 3);
  });

  testWidgets('slideshow：点海报区仍能进详情（1.3.1「整卡可点」不回归）',
      (WidgetTester tester) async {
    int taps = 0;
    final GameSummary game = _game();
    await tester.pumpWidget(_host(GameCard(
      game: game,
      posterUrl: null,
      posterUrls: game.posters,
      onTap: () => taps++,
    )));
    await tester.pump(const Duration(milliseconds: 50));

    await tester.tap(find.byType(PageView));
    await tester.pump();
    expect(taps, 1, reason: '轮播海报区点击必须仍由整卡 InkWell 收到');
  });

  testWidgets('海报区 16:9（与 Web 端 aspect-video 一致）', (WidgetTester tester) async {
    await tester.pumpWidget(_host(_card(_game())));
    await tester.pump(const Duration(milliseconds: 50));
    final Size poster = tester.getSize(find.byType(AspectRatio).first);
    expect(poster.width / poster.height, closeTo(16 / 9, 0.01));
  });
}