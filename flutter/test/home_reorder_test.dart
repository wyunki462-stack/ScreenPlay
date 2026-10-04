// 自定义拖拽排序（用户报障 ②）回归测试。
//
// 覆盖：
//  1. 松手落在**卡片矩形内** → 立即乐观重排 + PUT 的邻居语义与 Web 端一致；
//  2. 松手落在**格子间隙**（手指没压在任何卡片上）→ 仍按「离手指最近的一格」重排
//     （修复前这类落点会静默失效 = 用户报的「卡片可拖动但松手后位置不更新」）；
//  3. 服务端顺序刷新回来**不回弹**（持久化生效）。
//
// 后端语义见 backend/src/games/games.service.ts:1492-1542：
//   afterId  = 落点**上方**的卡（the card above the drop point）；
//   beforeId = 落点**下方**的卡（the card below the drop point）。
// Web 端调用同源：web/src/pages/Home.tsx:176
//   reorder.mutate({ gameId, beforeId: below?.id ?? null, afterId: above?.id ?? null })

import 'dart:async';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:screenplay/core/api_client.dart';
import 'package:screenplay/models/models.dart';
import 'package:screenplay/screens/home_screen.dart';

/// 假后端：内存里维护「服务端顺序」，PUT 语义与真实后端一致（把 gameId 移到落点）。
class _FakeApi extends ApiClient {
  _FakeApi(this.order) : super(baseUrl: 'http://test.invalid');

  List<GameSummary> order;
  final List<Map<String, String?>> calls = <Map<String, String?>>[];

  @override
  List<String> cardPosterSources(GameSummary game) => game.posters;

  @override
  Future<Stats> stats() async => const Stats(
        totalGames: 6,
        totalMedia: 0,
        totalImages: 0,
        totalVideos: 0,
        totalSizeBytes: 0,
        totalPlayTimeSeconds: 0,
        platforms: <String, int>{},
      );

  @override
  Future<List<GameSummary>> games(GameFilter filter) async =>
      List<GameSummary>.of(order);

  /// 详情页不在本测试范围内：给一个永不完成的 Future，免得真的发 HTTP
  /// （测试环境所有请求都会被判 400，日志会刷一堆 DioException）。
  /// reorderGamesProvider 成功后会 invalidate gameDetailProvider，这里必须兜住。
  @override
  Future<GameDetail> game(String id) => Completer<GameDetail>().future;

  @override
  Future<void> reorderGames({
    required String gameId,
    String? beforeId,
    String? afterId,
  }) async {
    calls.add(<String, String?>{
      'gameId': gameId,
      'beforeId': beforeId,
      'afterId': afterId,
    });
    final List<GameSummary> next = List<GameSummary>.of(order);
    final int from = next.indexWhere((GameSummary g) => g.id == gameId);
    if (from < 0) return;
    final GameSummary moving = next.removeAt(from);
    int at = next.length;
    if (beforeId != null) {
      final int i = next.indexWhere((GameSummary g) => g.id == beforeId);
      if (i >= 0) at = i;
    } else if (afterId != null) {
      final int i = next.indexWhere((GameSummary g) => g.id == afterId);
      if (i >= 0) at = i + 1;
    }
    next.insert(at.clamp(0, next.length), moving);
    order = next;
  }
}

/// 卡片标题用「游戏A…游戏F」：海报占位图会把**首字**放大显示（'游'），
/// 若标题取 'A' 会与占位字重名导致 finder 命中两个控件。
GameSummary _game(String id, String name) => GameSummary(
      id: id,
      name: name,
      platform: 'PC',
      posterUrl: null,
      posters: <String>['http://test.invalid/api/media/$id/poster'],
      mediaCount: 1,
      durationSeconds: 60,
      durationText: '1 分钟',
      metacriticScore: null,
      firstPlayedAt: null,
      lastPlayedAt: null,
    );

/// 某张卡片的矩形（含卡片外沿，等于网格格子的高度）。
Rect _cardRect(WidgetTester tester, String title) => tester.getRect(
      find.ancestor(of: find.text(title), matching: find.byType(Card)),
    );

List<String> _ids(_FakeApi api) =>
    api.order.map((GameSummary g) => g.id).toList();

Future<_FakeApi> _pumpHome(WidgetTester tester) async {
  // 放大逻辑分辨率：6 张卡片（4 列 → 2 行）全部进入视口，GridView 才会构建它们。
  tester.view.physicalSize = const Size(1000, 1600);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
  final _FakeApi api = _FakeApi(<GameSummary>[
    _game('g1', '游戏A'),
    _game('g2', '游戏B'),
    _game('g3', '游戏C'),
    _game('g4', '游戏D'),
    _game('g5', '游戏E'),
    _game('g6', '游戏F'),
  ]);
  await tester.pumpWidget(
    ProviderScope(
      overrides: <Override>[apiClientProvider.overrideWithValue(api)],
      child: const MaterialApp(home: HomeScreen()),
    ),
  );
  await tester.pumpAndSettle();
  // 只有「自定义排序」模式允许长按拖拽（其余模式是服务端排序）。
  await tester.tap(find.byType(DropdownButtonFormField<String>).first);
  await tester.pumpAndSettle();
  await tester.tap(find.text('自定义排序').last);
  await tester.pumpAndSettle();
  return api;
}

/// 长按 [from] 再拖到 [to] 松手。
Future<void> _dragTo(WidgetTester tester, Offset from, Offset to) async {
  final TestGesture gesture = await tester.startGesture(from);
  await tester.pump(kLongPressTimeout + const Duration(milliseconds: 50));
  await gesture.moveTo(to);
  await tester.pump();
  await gesture.up();
  // 跟手卡片挂在 Overlay 上，up() 之后再走一帧才会消失（否则后续 _cardRect 会同时
  // 命中「列表里的卡」和「跟手卡片」两个 Card）。
  await tester.pump();
}

void main() {
  testWidgets('松手在卡片矩形内：立即重排，PUT 邻居语义与 Web 端一致',
      (WidgetTester tester) async {
    final _FakeApi api = await _pumpHome(tester);

    // 落在「游戏C」的右半 → 插到 C 之后（Web: clientX >= rect.center → "after"）。
    await _dragTo(
      tester,
      _cardRect(tester, '游戏A').center,
      _cardRect(tester, '游戏C').center + const Offset(12, 0),
    );

    // 乐观重排：不等网络返回，UI 立刻变（A 落到 C 右边）。
    expect(_cardRect(tester, '游戏A').left,
        greaterThan(_cardRect(tester, '游戏C').left),
        reason: '松手后卡片必须立即落到 C 之后（乐观更新）');

    await tester.pumpAndSettle();
    expect(api.calls, hasLength(1));
    expect(api.calls.single['gameId'], 'g1');
    expect(api.calls.single['afterId'], 'g3',
        reason: 'afterId = 落点上方的卡（Web: after?.id ?? null）');
    expect(api.calls.single['beforeId'], 'g4',
        reason: 'beforeId = 落点下方的卡（Web: below?.id ?? null）');

    // 服务端顺序回来刷新后不回弹（持久化）。
    await tester.pumpAndSettle();
    expect(_ids(api), <String>['g2', 'g3', 'g1', 'g4', 'g5', 'g6']);
    expect(_cardRect(tester, '游戏B').left,
        lessThan(_cardRect(tester, '游戏A').left));
    expect(_cardRect(tester, '游戏A').left,
        lessThan(_cardRect(tester, '游戏D').left));
  });

  testWidgets('松手在两行之间的间隙：按离手指最近的一格重排（修复前静默不生效）',
      (WidgetTester tester) async {
    final _FakeApi api = await _pumpHome(tester);

    final Rect first = _cardRect(tester, '游戏A'); // 第 0 行第 0 列
    // 行间隙中点（取右半 → 插到第 0 格之后）。
    final Offset gap = Offset(first.center.dx + 20, first.bottom + 6);
    await _dragTo(tester, _cardRect(tester, '游戏F').center, gap);
    await tester.pumpAndSettle();

    expect(api.calls, hasLength(1),
        reason: '落在格子间隙也必须提交排序 —— 这就是「松手后位置不更新」的现场');
    expect(api.calls.single['gameId'], 'g6');
    expect(api.calls.single['afterId'], 'g1');
    expect(api.calls.single['beforeId'], 'g2');
    expect(_ids(api), <String>['g1', 'g6', 'g2', 'g3', 'g4', 'g5']);
  });

  testWidgets('首页卡片海报区 16:9（与 Web 端 aspect-video 一致）',
      (WidgetTester tester) async {
    await _pumpHome(tester);
    final Size poster = tester.getSize(find.byType(AspectRatio).first);
    expect(poster.width / poster.height, closeTo(16 / 9, 0.01),
        reason: '海报区必须是 16:9（Web game_card: aspect-video），不是长条 2:3');
  });
}