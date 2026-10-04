// 卡片点击热区（用户报障 ③）：整张卡片任意位置都应能进详情页。
//
// 回归点在这里：多海报时海报区上有一层「手势吸收层」（GestureDetector, opaque）。
// 它此前是空 onTap，会把落在海报上的点击吃掉 —— 于是只有卡片下方文字能进详情。
// 本测试直接点海报区，要求 onTap 被调用；同时要求**横向拖拽不触发 onTap**
// （滑动切图不能误进详情），以及**不注册长按**（长按要留给自定义排序的
// LongPressDraggable，抢了会导致拖拽时灵时不灵）。

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:screenplay/models/models.dart';
import 'package:screenplay/widgets/game_card.dart';

GameSummary _game() => const GameSummary(
      id: 'g1',
      name: '测试游戏',
      platform: 'PC',
      posterUrl: null,
      mediaCount: 0,
      durationSeconds: 0,
      durationText: '',
      metacriticScore: null,
      firstPlayedAt: null,
      lastPlayedAt: null,
    );

Widget _host(GameCard card) => ProviderScope(
      child: MaterialApp(
        home: Scaffold(
          body: Center(
            child: SizedBox(width: 320, height: 460, child: card),
          ),
        ),
      ),
    );

void main() {
  group('GameCard 点击热区（整卡可点）', () {
    testWidgets('单海报：点海报区进详情', (WidgetTester tester) async {
      int taps = 0;
      await tester.pumpWidget(_host(GameCard(
        game: _game(),
        posterUrl: null,
        onTap: () => taps++,
      )));

      final Rect card = tester.getRect(find.byType(Card));
      // 海报区 = 卡片上部（下方是名称/徽章信息行）。
      await tester.tapAt(Offset(card.center.dx, card.top + card.height * 0.25));
      expect(taps, 1);
    });

    testWidgets('点下方信息行也能进详情', (WidgetTester tester) async {
      int taps = 0;
      await tester.pumpWidget(_host(GameCard(
        game: _game(),
        posterUrl: null,
        onTap: () => taps++,
      )));

      final Rect card = tester.getRect(find.byType(Card));
      await tester.tapAt(Offset(card.center.dx, card.bottom - 12));
      expect(taps, 1);
    });

    testWidgets('多海报：手势吸收层把海报区点击转交 onTap，且不抢长按',
        (WidgetTester tester) async {
      int taps = 0;
      await tester.pumpWidget(_host(GameCard(
        game: _game(),
        posterUrl: null,
        posterUrls: const <String>['https://example.invalid/a.jpg', 'https://example.invalid/b.jpg'],
        onTap: () => taps++,
      )));
      await tester.pump(const Duration(milliseconds: 50));

      // 吸收层就是海报区那层不透明 GestureDetector：必须有 onTap（转交卡片回调），
      // 且**不能**有 onLongPress（长按要留给自定义排序的 LongPressDraggable）。
      final Finder absorber = find.byWidgetPredicate(
        (Widget w) => w is GestureDetector && w.onTap != null && w.behavior == HitTestBehavior.opaque,
      );
      expect(absorber, findsWidgets);
      expect(
        tester.widgetList<GestureDetector>(absorber).where((GestureDetector g) => g.onLongPress != null),
        isEmpty,
        reason: '海报区的点击吸收层不能注册长按手势，否则与 LongPressDraggable 抢手势',
      );

      final Rect card = tester.getRect(find.byType(Card));
      await tester.tapAt(Offset(card.center.dx, card.top + card.height * 0.25));
      expect(taps, 1, reason: '点海报区必须进详情（修复前这层是空 onTap，点击被吞掉）');
    });

    testWidgets('多海报：横向滑动切图不触发进详情', (WidgetTester tester) async {
      int taps = 0;
      await tester.pumpWidget(_host(GameCard(
        game: _game(),
        posterUrl: null,
        posterUrls: const <String>['https://example.invalid/a.jpg', 'https://example.invalid/b.jpg'],
        onTap: () => taps++,
      )));
      await tester.pump(const Duration(milliseconds: 50));

      final Rect card = tester.getRect(find.byType(Card));
      final Offset poster = Offset(card.center.dx, card.top + card.height * 0.25);
      await tester.dragFrom(poster, const Offset(-260, 0));
      await tester.pumpAndSettle();

      expect(taps, 0, reason: '滑动切海报不能误进详情页');
    });
  });
}