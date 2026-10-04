// ScreenPlay — 带会话凭证的网络图片。
//
// 背景：`CachedNetworkImage` 自己持有 dart:io 的 HttpClient，**不经过** ApiClient
// 里那条给所有 Dio 请求补 `Authorization: Bearer <token>` + `Cookie` 的拦截器。
// Linux 后端默认 `AUTH_MODE=system`（鉴权开启），而 `/api/media/*`、`/api/media/proxy`、
// `/api/posters/*` 这些图片端点都吃全局会话守卫 ⇒ 无凭证一律 401。
// 现象就是「App 连 Linux 后端后大部分海报不显示、只剩彩色渐变占位」；
// Windows 桌面端 `AUTH_DISABLED=1` 无凭证放行，所以问题只在 Linux 后端暴露。

import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/api_client.dart';
import '../core/image_cache.dart';

/// 与 [CachedNetworkImage] 同参的会话鉴权版本（除 `httpHeaders` 由本组件统一补上，
/// 以及默认的淡入淡出为 0 —— 与改造前各处显式设置保持一致）。
///
/// 注意 `placeholder` / `errorWidget` 的类型必须沿用 cached_network_image 自己的
/// `(BuildContext, String url, Object error)` 签名（`PlaceholderWidgetBuilder` /
/// `LoadingErrorWidgetBuilder`），不能用 Flutter 的 `ImageErrorWidgetBuilder`
/// —— 后者第二参是 error、第三参是 StackTrace，签名不同。
class AuthedImage extends ConsumerWidget {
  const AuthedImage({
    super.key,
    required this.imageUrl,
    this.cacheKey,
    this.placeholder,
    this.errorWidget,
    this.fit,
    this.alignment = Alignment.center,
    this.width,
    this.height,
  });

  final String imageUrl;

  /// 磁盘缓存键；缺省用 [imageUrl]（与改造前各处的写法一致）。
  final String? cacheKey;
  final PlaceholderWidgetBuilder? placeholder;
  final LoadingErrorWidgetBuilder? errorWidget;
  final BoxFit? fit;
  final Alignment alignment;
  final double? width;
  final double? height;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // watch（而非 read）：登录 / 登出后 token 变化，组件随之重建并带上新凭证。
    final Map<String, String> headers =
        ref.watch(apiClientProvider).imageHeaders;

    return CachedNetworkImage(
      imageUrl: imageUrl,
      cacheKey: cacheKey ?? imageUrl,
      cacheManager: screenplayImageCache,
      httpHeaders: headers.isEmpty ? null : headers,
      fit: fit,
      alignment: alignment,
      width: width,
      height: height,
      placeholder: placeholder,
      errorWidget: errorWidget,
      fadeInDuration: Duration.zero,
      fadeOutDuration: Duration.zero,
      placeholderFadeInDuration: Duration.zero,
    );
  }
}