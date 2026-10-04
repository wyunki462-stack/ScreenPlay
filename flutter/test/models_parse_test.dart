// 模型解析回归测试 —— 锁住「连 Linux 后端后详情页打不开」的根因。
//
// 后端 `GET /api/games/:id` 内嵌的 `achievements[]` 用的是 **snake_case**
// （id / game_id / external_id / icon_url / global_percent / dlc_app_id / sort_order），
// 而 `GET /api/achievements/:id` 返回的是 **camelCase**（gameId / iconUrl / globalPercent…）。
// 改造前 `Achievement.fromJson` 只读 `json['gameId'] as String`：
//   → 一行 null 就抛 `type 'Null' is not a subtype of type 'String'`；
//   → 而 `_parseList` 当时没有逐项容错，一行坏数据直接让整个 GameDetail 解析失败；
//   → 结果点任意卡片都是「加载详情失败」。Windows 端测试库没有成就数据，所以只在
//     Linux 后端暴露（Web 端不读这个内嵌数组，走 /api/achievements/:id，因此也不受影响）。
//
// 夹具来自真实 Linux 后端（127.0.0.1:3007：39 个游戏 / 1917 个媒体文件）。

import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:screenplay/models/models.dart';

List<dynamic> _loadList(String name) =>
    jsonDecode(File('test/fixtures/$name').readAsStringSync()) as List<dynamic>;

Map<String, dynamic> _loadMap(String name) =>
    jsonDecode(File('test/fixtures/$name').readAsStringSync())
        as Map<String, dynamic>;

void main() {
  group('GameSummary（列表）', () {
    test('真实列表夹具逐条解析，封面与轮播海报都在', () {
      final List<GameSummary> games = _loadList('games_list.json')
          .map((dynamic e) => GameSummary.fromJson(e as Map<String, dynamic>))
          .toList();

      expect(games, isNotEmpty);
      for (final GameSummary game in games) {
        expect(game.id, isNotEmpty, reason: '列表项必须有 id');
        expect(game.name, isNotEmpty, reason: '列表项必须有 name');
        expect(game.posterUrl, isNotNull);
      }
      // 后端列表接口本来就带 `posters[]`；改造前 App 丢掉了这个字段，卡片只能各自
      // 去拉 postersProvider（远端 CDN 直连），这才是「海报比 Web 少」的另一半原因。
      final Iterable<GameSummary> withPosters =
          games.where((GameSummary g) => g.posters.isNotEmpty);
      expect(withPosters, isNotEmpty,
          reason: '列表接口应带 posters[]（封面 ∪ 轮播集合）');
      expect(withPosters.first.posters.first, isNotEmpty);
    });

    test('缺 id / name 的行不再抛错（避免整页白屏）', () {
      final GameSummary game =
          GameSummary.fromJson(<String, dynamic>{'platform': 'PC'});
      expect(game.id, isEmpty);
      expect(game.name, isEmpty);
      expect(game.posters, isEmpty);
      expect(game.mediaCount, 0);
    });
  });

  group('GameDetail（详情）', () {
    test('三个真实详情夹具整体解析成功', () {
      for (final String name in <String>[
        'game_detail_0.json',
        'game_detail_1.json',
        'game_detail_2.json',
      ]) {
        final GameDetail detail = GameDetail.fromJson(_loadMap(name));
        expect(detail.id, isNotEmpty, reason: '$name 必须有 id');
        expect(detail.name, isNotEmpty, reason: '$name 必须有 name');
        expect(detail.ratings, isNotNull);
        expect(detail.prices, isNotNull);
        expect(detail.timeline, isNotNull);
      }
    });

    test('snake_case 的内嵌成就被正确读取（本次崩溃的现场）', () {
      final GameDetail detail = GameDetail.fromJson(_loadMap('game_detail_0.json'));

      expect(detail.achievements, isNotEmpty);
      final Achievement first = detail.achievements.first;
      expect(first.id, isNotEmpty); // 来自 id
      expect(first.gameId, isNotEmpty); // 来自 game_id ← 改造前这里抛 Null 异常
      expect(first.gameId, detail.id);
      expect(first.name, isNotEmpty);
    });

    test('详情里的 posters 与列表口径一致（封面 + 轮播）', () {
      final GameDetail detail = GameDetail.fromJson(_loadMap('game_detail_0.json'));
      expect(detail.posters, isNotEmpty);
      expect(detail.posterUrl, isNotNull);
    });

    test('一行坏数据不会拖垮整个详情（逐项容错）', () {
      final Map<String, dynamic> json = _loadMap('game_detail_0.json');
      final List<dynamic> rows =
          List<dynamic>.of(json['achievements'] as List<dynamic>);
      final int before = rows.length;

      // 混入完全没法解析的行：null / 数字 / 字符串 / 纯 list。
      rows.insertAll(0, <dynamic>[null, 42, 'not-an-object', <dynamic>[]]);
      json['achievements'] = rows;

      final GameDetail detail = GameDetail.fromJson(json); // 不抛即通过
      expect(detail.achievements.length, greaterThanOrEqualTo(before),
          reason: '合法行必须全部保留');
      expect(detail.id, isNotEmpty);
    });

    test('整个 achievements 字段缺失或类型错位时也不抛错', () {
      final Map<String, dynamic> json = _loadMap('game_detail_0.json');
      json.remove('achievements');
      expect(GameDetail.fromJson(json).achievements, isEmpty);

      json['achievements'] = 'oops';
      expect(GameDetail.fromJson(json).achievements, isEmpty);

      json['achievements'] = <dynamic>[];
      expect(GameDetail.fromJson(json).achievements, isEmpty);
    });
  });

  group('Achievement（两种字段风格）', () {
    test('camelCase（GET /api/achievements/:id）可解析', () {
      final List<dynamic> items =
          _loadMap('game_achievements_0.json')['items'] as List<dynamic>;
      expect(items, isNotEmpty);

      final List<Achievement> parsed = items
          .map((dynamic e) => Achievement.fromJson(e as Map<String, dynamic>))
          .toList();
      for (final Achievement a in parsed) {
        expect(a.id, isNotEmpty); // 来自 id
        expect(a.gameId, isNotEmpty); // 来自 gameId
      }
      expect(parsed.where((Achievement a) => a.globalPercent != null),
          isNotEmpty);
    });

    test('snake_case 与 camelCase 解出同一个成就', () {
      final Achievement camel = Achievement.fromJson(<String, dynamic>{
        'id': 'g:steam:ACH_1',
        'gameId': 'g',
        'name': '破冰者',
        'iconUrl': 'https://cdn.example/a.jpg',
        'globalPercent': 12.5,
      });
      final Achievement snake = Achievement.fromJson(<String, dynamic>{
        'id': 'g:steam:ACH_1',
        'game_id': 'g',
        'external_id': 'ACH_1',
        'name': '破冰者',
        'icon_url': 'https://cdn.example/a.jpg',
        'global_percent': 12.5,
      });

      expect(snake.id, camel.id);
      expect(snake.gameId, camel.gameId);
      expect(snake.name, camel.name);
      expect(snake.iconUrl, camel.iconUrl);
      expect(snake.globalPercent, camel.globalPercent);
    });

    test('数字型百分比如 12（int）也能读成 double', () {
      final Achievement a = Achievement.fromJson(<String, dynamic>{
        'id': 'g:steam:ACH_2',
        'game_id': 'g',
        'name': 'x',
        'global_percent': 12,
      });
      expect(a.globalPercent, 12.0);
    });
  });

  group('Media（详情页媒体列表）', () {
    test('真实媒体夹具解析成功且缩略图/预览路径可用', () {
      final List<Media> items = _loadList('game_media_0.json')
          .map((dynamic e) => Media.fromJson(e as Map<String, dynamic>))
          .toList();

      expect(items, isNotEmpty);
      for (final Media m in items) {
        expect(m.id, isNotEmpty);
        expect(m.thumbnailPath, startsWith('/api/media/'),
            reason: '缩略图 rendition 必须指向本服务端（走 /api/media/:id/thumbnail）');
        expect(m.previewPath, contains('/preview'));
        expect(m.gameId, isNotEmpty);
      }
    });
  });

  group('Poster（海报列表）', () {
    test('真实海报夹具解析成功', () {
      final List<Poster> posters = _loadList('game_posters_0.json')
          .map((dynamic e) => Poster.fromJson(e as Map<String, dynamic>))
          .toList();

      expect(posters, isNotEmpty);
      for (final Poster p in posters) {
        expect(p.id, isNotEmpty);
        expect(p.gameId, isNotEmpty);
      }
    });

    test('缺 id / gameId / url 的行不再抛错（与 GameSummary 同一原则）', () {
      final Poster p = Poster.fromJson(<String, dynamic>{
        'source': 'upload',
      });
      expect(p.id, '');
      expect(p.gameId, '');
      expect(p.url, '');
      expect(p.isCover, isFalse);
    });
  });
}