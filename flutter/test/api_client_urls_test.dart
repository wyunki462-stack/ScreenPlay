// 取图地址 / 鉴权头的单元测试 —— 锁住「连 Linux 后端后大部分海报不显示」的两个根因。
//
// 根因 A：Linux 后端默认开鉴权，而图片端点（/api/media/*、/api/media/proxy、/api/posters/*）
//         都在全局会话守卫之下。`CachedNetworkImage` 用自己那套 dart:io HttpClient，
//         **不经过** ApiClient 里给 Dio 补 Bearer/Cookie 的拦截器 ⇒ 无凭证一律 401，
//         卡片只剩渐变占位。实测（127.0.0.1:3007）：
//           /api/media/proxy?url=…   带 Cookie 200 image/jpeg 52,927 B / 不带 401
//           /api/media/<id>/thumbnail 带 Cookie 200 image/webp   6,018 B / 不带 401
//         所以图片请求必须带上和业务请求同一套凭证（`imageHeaders`）。
//
// 根因 B：远端 CDN 海报（https://media.rawg.io/… 等）在手机网络下根本拉不下来。
//         Web 端所有远端图都被后端 `/api/media/proxy?url=…` 抓取并落磁盘缓存，
//         App 端必须走同一条路（`imageSource`），且卡片 tile 要把 4K 的 /preview
//         换成 /thumbnail（`cardImageSource`，与 Web `cardFrame()` 同规则）。

import 'package:flutter_test/flutter_test.dart';
import 'package:screenplay/core/api_client.dart';
import 'package:screenplay/models/models.dart';

const String _base = 'http://192.168.1.10:3000';

void main() {
  final ApiClient api = ApiClient(baseUrl: _base);

  group('resolve', () {
    test('相对地址补上 baseUrl', () {
      expect(api.resolve('/api/games'), '$_base/api/games');
      expect(api.resolve('api/games'), '$_base/api/games');
    });

    test('绝对地址原样通过', () {
      expect(api.resolve('https://media.rawg.io/a.jpg'),
          'https://media.rawg.io/a.jpg');
      expect(api.resolve(''), '');
    });
  });

  group('imageSource（远端图走后端代理）', () {
    test('后端已代理的相对地址只补前缀，不二次代理', () {
      // 列表接口给的 posterUrl / posters[] 就是这个形状。
      const String raw =
          '/api/media/proxy?url=https%3A%2F%2Fmedia.rawg.io%2Fmedia%2Fgames%2F1.jpg';
      expect(api.imageSource(raw), '$_base$raw');
    });

    test('媒体 rendition 相对地址补前缀', () {
      expect(api.imageSource('/api/media/abc/thumbnail'),
          '$_base/api/media/abc/thumbnail');
      expect(api.imageSource('/api/posters/p1/image'),
          '$_base/api/posters/p1/image');
    });

    test('远端 CDN 绝对地址改走后端代理（percent-encode）', () {
      expect(
        api.imageSource('https://media.rawg.io/media/games/86f/x.jpg'),
        '$_base/api/media/proxy?url=https%3A%2F%2Fmedia.rawg.io%2Fmedia%2Fgames%2F86f%2Fx.jpg',
      );
      expect(
        api.imageSource('https://cdn.cloudflare.steamstatic.com/steamcommunity/a.jpg'),
        '$_base/api/media/proxy?url=https%3A%2F%2Fcdn.cloudflare.steamstatic.com%2Fsteamcommunity%2Fa.jpg',
      );
    });

    test('已经指向本服务端的绝对地址不再包一层代理', () {
      expect(api.imageSource('$_base/api/media/abc/preview'),
          '$_base/api/media/abc/preview');
    });

    test('空串原样返回（避免请求空 URL）', () {
      expect(api.imageSource(''), '');
    });
  });

  group('cardImageSource（卡片封面档：preview → thumbnail）', () {
    test('媒体 preview 被换成 thumbnail（与 Web cardFrame() 同规则）', () {
      expect(api.cardImageSource('/api/media/abc/preview'),
          '$_base/api/media/abc/thumbnail');
    });

    test('已是绝对地址的 /preview 不改写 —— 与 Web cardFrame() 规则逐字一致', () {
      // Web 的正则是 /^\/api\/media\/([^/]+)\/preview$/，只命中服务端下发的相对路径。
      // 后端返回的 posterUrl / posters[] 也都是相对路径，所以实际链路都走上面那条分支；
      // 这条断言用来防止有人把它误当成「通用 URL 重写器」。
      expect(api.cardImageSource('$_base/api/media/abc/preview'),
          '$_base/api/media/abc/preview');
    });

    test('只改媒体 rendition，上传海报与远端图按原规则处理', () {
      expect(api.cardImageSource('/api/posters/p1/image'),
          '$_base/api/posters/p1/image');
      expect(api.cardImageSource('/api/media/proxy?url=https%3A%2F%2Fcdn%2Fa.jpg'),
          '$_base/api/media/proxy?url=https%3A%2F%2Fcdn%2Fa.jpg');
      expect(api.cardImageSource('https://media.rawg.io/a.jpg'),
          '$_base/api/media/proxy?url=https%3A%2F%2Fmedia.rawg.io%2Fa.jpg');
    });

    test('近似但不匹配的路径不动（防止误改）', () {
      expect(api.cardImageSource('/api/media/abc/preview/'),
          '$_base/api/media/abc/preview/');
      expect(api.cardImageSource('/api/media/preview'),
          '$_base/api/media/preview');
    });
  });

  group('cardPosterSources（卡片轮播集合，与 Web cardPosters() 对齐）', () {
    test('封面优先、去重、逐条归一化', () {
      const GameSummary game = GameSummary(
        id: 'g',
        name: '游戏',
        platform: 'PC',
        posterUrl: '/api/media/cover/preview',
        mediaCount: 0,
        durationSeconds: 0,
        durationText: '',
        metacriticScore: null,
        firstPlayedAt: null,
        lastPlayedAt: null,
        posters: <String>[
          '/api/media/cover/preview', // 与封面重复 → 去重
          'https://media.rawg.io/p2.jpg', // 远端 → 代理
          '', // 空串 → 丢弃
          '/api/posters/p3/image',
        ],
      );

      expect(api.cardPosterSources(game), <String>[
        '$_base/api/media/cover/thumbnail',
        '$_base/api/media/proxy?url=https%3A%2F%2Fmedia.rawg.io%2Fp2.jpg',
        '$_base/api/posters/p3/image',
      ]);
    });

    test('没有任何海报时返回空表（卡片走渐变占位）', () {
      const GameSummary game = GameSummary(
        id: 'g',
        name: '游戏',
        platform: 'PC',
        posterUrl: null,
        mediaCount: 0,
        durationSeconds: 0,
        durationText: '',
        metacriticScore: null,
        firstPlayedAt: null,
        lastPlayedAt: null,
      );
      expect(api.cardPosterSources(game), isEmpty);
    });
  });

  group('imageHeaders（图片请求凭证）', () {
    test('无 token → 空表（Windows 桌面端 AUTH_DISABLED=1，不传也能取图）', () {
      expect(api.imageHeaders, isEmpty);
      expect(ApiClient(baseUrl: _base, authToken: '').imageHeaders, isEmpty);
    });

    test('有 token → 同时带 Bearer 与 Cookie（与 Dio 拦截器一致）', () {
      final ApiClient authed = ApiClient(baseUrl: _base, authToken: 'tok-123');
      expect(authed.imageHeaders['Authorization'], 'Bearer tok-123');
      expect(authed.imageHeaders['Cookie'], 'screenplay_session=tok-123');
    });

    test('登录 / 登出后动态切换', () {
      final ApiClient client = ApiClient(baseUrl: _base);
      expect(client.imageHeaders, isEmpty);

      client.setAuthToken('tok-456');
      expect(client.imageHeaders['Authorization'], 'Bearer tok-456');

      client.setAuthToken(null);
      expect(client.imageHeaders, isEmpty);
    });
  });
}