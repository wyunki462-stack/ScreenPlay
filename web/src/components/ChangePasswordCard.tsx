import { useState, type ChangeEvent, type FormEvent } from "react";
import { Lock } from "lucide-react";

import { useChangePassword, type AuthSession } from "../api/auth";
import { useI18n } from "../i18n";
import { Button } from "./ui/Button";
import { Card, CardContent, CardHeader } from "./ui/Card";
import { Field } from "./ui/Field";
import { PASSWORD_I18N } from "./ChangePasswordCard.i18n";

/** Local-account password form state. Kept apart from the API-key form. */
interface PasswordFormState {
  current: string;
  next: string;
  confirm: string;
}

const emptyPassword: PasswordFormState = { current: "", next: "", confirm: "" };

/**
 * The backend answers with a stable `code` plus a Chinese message. The UI shows
 * its own localized text keyed by the code, and only falls back to the server
 * message for a code this build does not know yet — otherwise the English page
 * would suddenly print Chinese.
 */
const PW_CODE_KEY: Record<string, string> = {
  wrong_current: "settings.password.errWrongCurrent",
  not_local: "settings.password.errNotLocal",
  blank: "settings.password.errBlank",
  too_short: "settings.password.errTooShort",
  too_long: "settings.password.errTooLong",
  same: "settings.password.errSame",
  unauthenticated: "settings.password.unauth",
};

export interface ChangePasswordCardProps {
  session: AuthSession | null | undefined;
}

/**
 * Change-password card for app-local accounts. The form only makes sense for
 * such an account: NAS system accounts are verified against the host shadow
 * file, which this app cannot write, and with auth disabled there is nothing to
 * protect. Both cases show an explanation instead of a dead form.
 *
 * Desktop builds replace this whole module with
 * `ChangePasswordCard.desktop-stub.tsx` (see `web/src/lib/platform.ts`): the
 * single-machine install has no login screen and its password is managed by the
 * launcher, so neither the card, nor this code, nor its text ships in that
 * artifact.
 */
export default function ChangePasswordCard({ session }: ChangePasswordCardProps) {
  // The card owns its strings (`ChangePasswordCard.i18n.ts`) so that a build
  // which drops the card drops them too; this local `t` shadows the global
  // translator and only falls back to it for keys the card does not define.
  const { t: globalT, lang } = useI18n();
  const t = (key: string) =>
    PASSWORD_I18N[lang]?.[key] ?? PASSWORD_I18N["zh-CN"][key] ?? globalT(key);
  const changePassword = useChangePassword();
  const [pw, setPw] = useState<PasswordFormState>(emptyPassword);
  const [pwMessage, setPwMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  /** Who may change a password right now (local accounts only). */
  const pwAvailable = !!session?.authenticated && session.user?.provider === "local";

  const setPwField = (key: keyof PasswordFormState) => (e: ChangeEvent<HTMLInputElement>) => {
    setPwMessage(null);
    setPw((f) => ({ ...f, [key]: e.target.value }));
  };

  /**
   * Validate locally first so an obvious mistake never costs a round trip, then
   * let the backend be the authority. Success/failure is shown inline; a thrown
   * ApiError (e.g. the session expired) is surfaced with its own message.
   */
  const onChangePassword = (e: FormEvent) => {
    e.preventDefault();
    setPwMessage(null);
    if (!pw.current) {
      setPwMessage({ kind: "error", text: t("settings.password.errCurrent") });
      return;
    }
    if (pw.next.length < 4) {
      setPwMessage({ kind: "error", text: t("settings.password.errTooShort") });
      return;
    }
    if (pw.next !== pw.confirm) {
      setPwMessage({ kind: "error", text: t("settings.password.errMismatch") });
      return;
    }
    changePassword.mutate(
      { current: pw.current, next: pw.next },
      {
        onSuccess: (res) => {
          if (res.ok) {
            setPw(emptyPassword);
            setPwMessage({ kind: "ok", text: t("settings.password.success") });
          } else {
            const key = res.code ? PW_CODE_KEY[res.code] : undefined;
            setPwMessage({
              kind: "error",
              text: key ? t(key) : (res.error ?? t("settings.password.failed")),
            });
          }
        },
        onError: (err) => {
          setPwMessage({ kind: "error", text: (err as Error).message || t("settings.password.failed") });
        },
      },
    );
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Lock className="h-4 w-4 text-zinc-400" />
          <span>{t("settings.password.title")}</span>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm leading-relaxed text-zinc-400">{t("settings.password.intro")}</p>

        {pwAvailable ? (
          <form className="space-y-4" onSubmit={onChangePassword}>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field
                label={t("settings.password.current")}
                value={pw.current}
                onChange={setPwField("current")}
                autoComplete="current-password"
              />
              <Field
                label={t("settings.password.next")}
                value={pw.next}
                onChange={setPwField("next")}
                autoComplete="new-password"
              />
              <Field
                label={t("settings.password.confirm")}
                value={pw.confirm}
                onChange={setPwField("confirm")}
                autoComplete="new-password"
              />
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="submit"
                data-testid="change-password"
                disabled={changePassword.isPending || !pw.current || !pw.next || !pw.confirm}
              >
                <Lock className="h-4 w-4" />
                {changePassword.isPending
                  ? t("settings.password.submitting")
                  : t("settings.password.submit")}
              </Button>
              {pwMessage && (
                <span
                  data-testid="password-result"
                  className={`text-sm ${pwMessage.kind === "ok" ? "text-emerald-400" : "text-rose-400"}`}
                >
                  {pwMessage.text}
                </span>
              )}
            </div>

            <p className="text-xs leading-relaxed text-zinc-500">{t("settings.password.hint")}</p>
          </form>
        ) : (
          <p className="text-sm text-zinc-500">
            {session?.authenticated
              ? t("settings.password.systemHint")
              : session?.enabled === false
                ? t("settings.password.disabled")
                : t("settings.password.unauth")}
          </p>
        )}
      </CardContent>
    </Card>
  );
}