// 展示用格式化工具。
// 时长按「天 / 小时 / 分钟 / 秒」组合为中文文本；文件大小转成 B/KB/MB/GB/TB。

import 'package:intl/intl.dart';

/// 秒 → 「3天12小时」风格的中文时长文本。
/// 规则：优先展示高位单位，最多带两个单位（如「3天12小时」「1小时30分钟」）。
String formatDuration(int totalSeconds) {
  if (totalSeconds < 0) totalSeconds = 0;
  if (totalSeconds < 60) return '$totalSeconds秒';

  const int secPerMin = 60;
  const int secPerHour = 3600;
  const int secPerDay = 86400;

  final int days = totalSeconds ~/ secPerDay;
  final int hours = (totalSeconds % secPerDay) ~/ secPerHour;
  final int minutes = (totalSeconds % secPerHour) ~/ secPerMin;

  final List<String> parts = <String>[];
  if (days > 0) parts.add('$days天');
  if (hours > 0) parts.add('$hours小时');
  if (parts.length < 2 && minutes > 0) parts.add('$minutes分钟');
  // 不足一天且不足一小时但仍有分钟时，上面的条件已覆盖；极端空缺返回秒。
  if (parts.isEmpty) parts.add('${totalSeconds % secPerMin}秒');

  return parts.join('');
}

/// 字节数 → 人类可读中文大小（1 位小数，如「10.0 MB」「1.5 GB」）。
String formatBytes(int bytes) {
  if (bytes < 0) bytes = 0;
  const List<String> units = <String>['B', 'KB', 'MB', 'GB', 'TB'];
  double value = bytes.toDouble();
  int unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return '${NumberFormat('0.0').format(value)} ${units[unitIndex]}';
}

/// DateTime → 「yyyy-MM-dd HH:mm」（本地时区）。
String formatDateTime(DateTime? dateTime, {String fallback = '—'}) {
  if (dateTime == null) return fallback;
  return DateFormat('yyyy-MM-dd HH:mm').format(dateTime.toLocal());
}

/// DateTime → 「yyyy-MM-dd」（日期，时长/发布时间使用）。
String formatDate(DateTime? dateTime, {String fallback = '—'}) {
  if (dateTime == null) return fallback;
  return DateFormat('yyyy-MM-dd').format(dateTime.toLocal());
}