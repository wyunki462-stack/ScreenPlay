/**
 * Translation dictionaries.
 *
 * Keys are flat, dot-separated strings so they stay greppable in the source
 * (`grep -rn "home.title" web/src`), and each feature area owns one namespace
 * file so translations can be added without touching a monolith.
 *
 * `zh-CN` is the source of truth: every key must exist there. `en` may lag, and
 * the runtime falls back to Chinese (then to the key itself) rather than showing
 * an empty string.
 */
import { commonZh } from './common';
import { homeZh } from './home';
import { detailZh } from './detail';
import { settingsZh } from './settings';
import { dialogsZh } from './dialogs';
import { mediaZh } from './media';

export const zh: Record<string, string> = {
  ...commonZh,
  ...homeZh,
  ...detailZh,
  ...settingsZh,
  ...dialogsZh,
  ...mediaZh,
};