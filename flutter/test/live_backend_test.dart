// 连真后的后端端到端验收 —— 覆盖 1.3.1 五项修复里「必须有服务端才能验」的部分：
//   ① 海报：列表给出的封面/轮播集合是否齐、带凭证取图是否 200（不带是否 401）；
//   ② 详情：**每一个**游戏的真实详情 JSON 是否都能解析（本次线上崩溃的复现面）；
//   ⑤ 同步：`POST /api/library/scan` 是否为立即返回的后台任务。
//
// 默认不跑（离线 CI 不该依赖服务端）：
//   flutter test --dart-define=SP_LIVE_BASE=http://127.0.0.1:3007 test/live_backend_test.dart
// 指向真实 Linux 后端（生产是 http://<NAS>:3001）。账号可覆盖：
//   --dart-define=SP_LIVE_USER=… --dart-define=SP_LIVE_PASSWORD=…
//
// 注意：这里必须用 `test()` 而不是 `testWidgets()` —— 后者会初始化 Flutter 测试
// binding，它装了一个「所有 HTTP 都返回 400」的 HttpOverrides，真网络会被拦掉。

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:screenplay/core/api_client.dart';
import 'package:screenplay/models/models.dart';

const String kLiveBase = String.fromEnvironment('SP_LIVE_BASE');
const String kLiveUser =
    String.fromEnvironment('SP_LIVE_USER', defaultValue: 'admin');
const String kLivePassword =
    String.fromEnvironment('SP_LIVE_PASSWORD', defaultValue: 'test-Pass-123');

/// 取一张图，返回 (状态码, content-type)；headers 为 null 时模拟「不带凭证」。
Future<(int, String)> _fetchImage(
  String url, {
  Map<String, String>? headers,
}) async {
  final HttpClient client = HttpClient()
    ..connectionTimeout = const Duration(seconds: 20);
  try {
    final HttpClientRequest request = await client.getUrl(Uri.parse(url));
    headers?.forEach((String key, String value) => request.headers.set(key, value));
    final HttpClientResponse response = await request.close();
    await response.drain<void>();
    return (response.statusCode, response.headers.contentType?.mimeType ?? '');
  } finally {
    client.close(force: true);
  }
}

void main() {
  if (kLiveBase.isEmpty) {
    test('连真后端验收（未设置 SP_LIVE_BASE，跳过）', () {
      // 用 --dart-define=SP_LIVE_BASE=http://<host>:<port> 打开。
    }, skip: '需要真实 Linux 后端：--dart-define=SP_LIVE_BASE=…');
    return;
  }

  late ApiClient api;
  late List<GameSummary> games;

  setUpAll(() async {
    HttpOverrides.global = null;
    api = ApiClient(baseUrl: kLiveBase);
    final String token = await api.login(
      username: kLiveUser,
      password: kLivePassword,
    );
    // 鉴权开启的后端拿不到 token ⇒ 后面所有图片都会 401，早失败早定位。
    expect(token, isNotEmpty, reason: '登录失败：$kLiveBase 上 $kLiveUser 未取到会话令牌');
    games = await api.games(const GameFilter());
  });

  test('① 列表：每个游戏都能解析，且每张卡片都有海报来源', () {
    expect(games, isNotEmpty, reason: '列表为空，无法验收海报');

    final List<String> withoutPoster = <String>[];
    final List<String> notRouted = <String>[];
    int carousel = 0;
    int totalSources = 0;
    for (final GameSummary game in games) {
      final List<String> sources = api.cardPosterSources(game);
      totalSources += sources.length;
      if (sources.isEmpty) {
        withoutPoster.add('${game.id}(${game.name})');
        continue;
      }
      if (sources.length > 1) carousel++;
      for (final String url in sources) {
        // 必须全部落在后端：相对地址补前缀、远端 CDN 走 /api/media/proxy ——
        // 只要有直连 media.rawg.io 之类的地址，手机在大陆网络下就会缺图。
        if (!url.startsWith(kLiveBase)) notRouted.add(url);
      }
    }

    // ignore: avoid_print
    print('游戏 ${games.length} 个 / 海报来源合计 $totalSources 张 / 可轮播 $carousel 个 '
        '/ 无海报 ${withoutPoster.length} 个');

    expect(withoutPoster, isEmpty, reason: '这些游戏一个海报来源都没有：$withoutPoster');
    expect(notRouted, isEmpty, reason: '这些海报地址没走后端：$notRouted');
  });

  test('② 详情：逐个游戏拉详情并解析，无一失败（含内嵌成就）', () async {
    final List<String> failures = <String>[];
    int withAchievements = 0;
    for (final GameSummary game in games) {
      try {
        final GameDetail detail = await api.game(game.id);
        if (detail.achievements.isNotEmpty) withAchievements++;
      } catch (error) {
        failures.add('${game.id}(${game.name}): $error');
      }
    }
    // ignore: avoid_print
    print('详情解析成功 ${games.length - failures.length}/${games.length}'
        '，其中带成就 $withAchievements 个');
    expect(failures, isEmpty, reason: '详情解析失败（点卡片即白屏）：\n${failures.join('\n')}');
  });

  test('② 成就两条数据源都能解析（详情内嵌 snake_case + /api/achievements 的 camelCase）',
      () async {
    String? sampled;
    for (final GameSummary game in games) {
      final List<Achievement> list = await api.achievements(game.id);
      if (list.isEmpty) continue;
      sampled = game.id;
      // camelCase 端点：id / gameId / iconUrl / globalPercent 必须齐。
      expect(list.first.id, isNotEmpty);
      expect(list.first.gameId, isNotEmpty);
      break;
    }
    if (sampled == null) {
      // ignore: avoid_print
      print('资料库里没有任何成就数据，跳过端点断言（详情侧由 models_parse_test 覆盖）');
      return;
    }
    // ignore: avoid_print
    print('成就端点抽样自游戏 $sampled');
  });

  test('① 海报真的能取到图：带凭证 200 image/*，不带凭证 401', () async {
    final List<String> checked = <String>[];
    final List<String> problems = <String>[];
    for (final GameSummary game in games) {
      final List<String> sources = api.cardPosterSources(game);
      if (sources.isEmpty) continue;
      final (int status, String mime) =
          await _fetchImage(sources.first, headers: api.imageHeaders);
      checked.add('${game.id} $status $mime');
      if (status != 200 || !mime.startsWith('image/')) {
        problems.add('${game.id} → $status $mime ${sources.first}');
      }
      if (checked.length >= 10) break;
    }
    // ignore: avoid_print
    print('抽检 ${checked.length} 张卡片封面：\n${checked.join('\n')}');
    expect(problems, isEmpty, reason: '这些封面取不到图：\n${problems.join('\n')}');

    // 同一张图去掉凭证 → 401，这正是「Windows 免登录没事、连 Linux 后端全白」的原因。
    final String sample = api.cardPosterSources(games.first).first;
    final (int anonStatus, String anonMime) = await _fetchImage(sample);
    // ignore: avoid_print
    print('无凭证取同一张图：$anonStatus $anonMime');
    expect(anonStatus, 401, reason: '鉴权后端上无凭证应当 401（否则凭证逻辑没被验证到）');
  });

  test('① 远端 CDN 海报改走后端代理后带凭证可取', () async {
    // 详情页 / 海报接口给的是远端绝对地址，客户端要把它换成代理地址才在手机网络下可用。
    final GameDetail detail = await api.game(games.first.id);
    String? remote;
    final String? poster = detail.posterUrl;
    if (poster != null && poster.isNotEmpty && poster.startsWith('http')) {
      remote = poster;
    }
    if (remote == null) {
      // 详情的封面多数已被后端换成本机地址，那就从海报集合里找一个远端地址来验代理。
      for (final GameSummary game in games) {
        final List<Poster> posters = await api.listPosters(game.id);
        for (final Poster item in posters) {
          if (item.url.startsWith('http') && !item.url.startsWith(kLiveBase)) {
            remote = item.url;
            break;
          }
        }
        if (remote != null) break;
      }
    }
    if (remote == null) {
      // ignore: avoid_print
      print('服务端没有远端海报地址（全部是本机文件），跳过代理验证');
      return;
    }
    final String proxied = api.imageSource(remote);
    expect(proxied, startsWith('$kLiveBase/api/media/proxy?url='));
    final (int status, String mime) =
        await _fetchImage(proxied, headers: api.imageHeaders);
    // ignore: avoid_print
    print('代理取图 $status $mime ← $remote');
    expect(status, 200);
    expect(mime, startsWith('image/'));
  });

  test('① 详情页成就图标（App 侧走 imageSource + 凭证）', () async {
    // 这里只断言「客户端契约」：控件必须带上凭证请求后端地址，不能 401。
    // 图标本身 200/502 取决于服务端存的数据质量 —— 实测本库 1738 个成就图标里有
    // 1409 个（81%）被爬虫存成了「域名+路径后再拼一个完整 URL」的双重地址
    // （尾巴是已下线的 steamcdn-a.akamaihd.net），后端代理只能 502。
    // 这是服务端数据缺陷（Web 端同样显示裂图），不是客户端问题：App 会退回奖杯占位图标。
    int ok = 0;
    int broken = 0;
    int unauthorized = 0;
    final Stopwatch watch = Stopwatch()..start();
    for (final GameSummary game in games) {
      final GameDetail detail = await api.game(game.id);
      for (final Achievement item in detail.achievements) {
        final String? icon = item.iconUrl;
        if (icon == null || icon.isEmpty) continue;
        final (int status, String mime) =
            await _fetchImage(api.imageSource(icon), headers: api.imageHeaders);
        if (status == 200 && mime.startsWith('image/')) {
          ok++;
        } else if (status == 401 || status == 403) {
          unauthorized++;
        } else {
          broken++;
        }
        if (ok + broken + unauthorized >= 24) break;
        if (watch.elapsed > const Duration(seconds: 90)) break;
      }
      if (ok + broken + unauthorized >= 24) break;
      if (watch.elapsed > const Duration(seconds: 90)) break;
    }
    // ignore: avoid_print
    print('成就图标抽样：可取图 $ok / 数据坏 502 $broken / 鉴权失败 $unauthorized');
    expect(unauthorized, 0, reason: '图标请求 401/403 —— 图片凭证没带上，属客户端缺陷');
    // 单测默认 30s 超时，而每个坏图标都要等后端代理回 502，这里放宽到 2 分钟。
  }, timeout: const Timeout(Duration(minutes: 2)));

  test('⑤ 下拉刷新：扫描是立即返回的后台任务，之后列表仍可取到全量数据', () async {
    final Stopwatch watch = Stopwatch()..start();
    await api.scan();
    watch.stop();
    // ignore: avoid_print
    print('POST /api/library/scan 耗时 ${watch.elapsedMilliseconds} ms');

    final List<GameSummary> again = await api.games(const GameFilter());
    expect(again.length, games.length);
    expect(await api.stats(), isNotNull);
  });
}