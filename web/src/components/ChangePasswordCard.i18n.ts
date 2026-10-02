/**
 * Strings of the change-password card.
 *
 * They live next to the card instead of in the shared `web/src/i18n/<lang>/settings.ts`
 * dictionaries on purpose: the desktop build swaps the card for a stub (see
 * `web/vite.config.ts`), and because this module is imported by the card and by
 * nothing else, its text drops out of that bundle together with the card — the
 * desktop artifact carries no `settings.password.*` string at all. Key names
 * keep the shared `settings.password.` prefix so they remain easy to compare
 * against the rest of the dictionary.
 *
 * `zh-CN` is the source of truth and `en` mirrors it, the same rule the main
 * dictionaries follow.
 */
export const PASSWORD_I18N: Record<"zh-CN" | "en", Record<string, string>> = {
  "zh-CN": {
    // 修改密码：本地账户的密码存在本机 SQLite 里，改完即生效
    "settings.password.title": "修改密码",
    "settings.password.intro":
      "本地账户（admin 等）的密码保存在本机数据库中，修改后立即生效、容器重启也依然有效 —— 不再需要从容器启动日志里翻初始密码。",
    "settings.password.current": "原密码",
    "settings.password.next": "新密码",
    "settings.password.confirm": "确认新密码",
    "settings.password.hint":
      "新密码至少 4 位。修改成功后，其它设备上的登录会失效，当前页面保持登录。",
    "settings.password.submit": "修改密码",
    "settings.password.submitting": "提交中…",
    "settings.password.success": "密码已修改 ✓ 请使用新密码登录。",
    "settings.password.failed": "修改失败，请重试。",
    "settings.password.errCurrent": "请输入原密码。",
    "settings.password.errTooShort": "新密码至少 4 位。",
    "settings.password.errMismatch": "两次输入的新密码不一致。",
    "settings.password.errWrongCurrent": "原密码不正确。",
    "settings.password.errNotLocal": "当前登录的是 NAS 系统账户，其密码由 NAS 管理。",
    "settings.password.errBlank": "新密码不能全为空格。",
    "settings.password.errTooLong": "新密码不能超过 128 位。",
    "settings.password.errSame": "新密码不能与原密码相同。",
    "settings.password.unauth": "需登录后才能修改密码。",
    "settings.password.disabled": "当前已关闭登录（AUTH_DISABLED=1），没有可修改的密码。",
    "settings.password.systemHint":
      "当前以 NAS 系统账户登录，其密码由 NAS 管理，请在本机系统账户设置中修改。",
  },
  en: {
    // Change password: the local account hash lives in the on-box SQLite database
    "settings.password.title": "Change password",
    "settings.password.intro":
      "The password of the local account (e.g. admin) is stored in this device's database. A change takes effect immediately and survives a container restart — you no longer need the initial password printed in the startup log.",
    "settings.password.current": "Current password",
    "settings.password.next": "New password",
    "settings.password.confirm": "Confirm new password",
    "settings.password.hint":
      "At least 4 characters. After a change, other devices are signed out while this page stays signed in.",
    "settings.password.submit": "Change password",
    "settings.password.submitting": "Submitting…",
    "settings.password.success": "Password changed ✓ Use the new one to sign in.",
    "settings.password.failed": "Could not change the password; please retry.",
    "settings.password.errCurrent": "Enter your current password.",
    "settings.password.errTooShort": "The new password must be at least 4 characters.",
    "settings.password.errMismatch": "The two new passwords do not match.",
    "settings.password.errWrongCurrent": "The current password is incorrect.",
    "settings.password.errNotLocal": "You are signed in with a NAS system account; its password is managed by the NAS.",
    "settings.password.errBlank": "The new password cannot be blank.",
    "settings.password.errTooLong": "The new password must be at most 128 characters.",
    "settings.password.errSame": "The new password must differ from the current one.",
    "settings.password.unauth": "You must be signed in to change the password.",
    "settings.password.disabled": "Sign-in is disabled (AUTH_DISABLED=1); there is no password to change.",
    "settings.password.systemHint":
      "You are signed in with a NAS system account; its password is managed by the NAS — change it in the host's user settings.",
  },
};