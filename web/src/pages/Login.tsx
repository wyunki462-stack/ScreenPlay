import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  CheckCircle2,
  Gamepad2,
  Loader2,
  LogIn,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { useAuthSession, useLogin, useSetup } from "../api/auth";
import { Button } from "../components/ui/Button";
import { useI18n } from "../i18n";

/** Same rule the backend enforces, mirrored for instant client-side feedback. */
const USERNAME_RE = /^[A-Za-z0-9._-]{2,32}$/;
const MIN_PASSWORD_LENGTH = 8;

type FieldErrors = { username?: string; password?: string; confirm?: string };

/**
 * Local login screen.
 *
 * Credentials are checked by the backend against the NAS host accounts (or the
 * app-local account when the host user database is not mounted). No third-party
 * identity service is involved, and the app works entirely offline.
 *
 * When the server has no local account yet (`needsSetup`), this screen becomes
 * a first-run "create account" form instead, so a fresh install can be used
 * before any account exists.
 */
export default function Login() {
  const { data: session } = useAuthSession();
  const login = useLogin();
  const setup = useSetup();
  const navigate = useNavigate();
  const { t, lang, setLang } = useI18n();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);

  const [setupUsername, setSetupUsername] = useState("");
  const [setupPassword, setSetupPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [created, setCreated] = useState(false);

  const needsSetup = !!session?.needsSetup;
  const systemUsers = session?.users ?? [];
  const usingSystem = session?.provider === "system";

  const toggleLang = () => setLang(lang === "zh-CN" ? "en" : "zh-CN");

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) return;
    login.mutate({ username: username.trim(), password, remember });
  };

  const submitSetup = (e: React.FormEvent) => {
    e.preventDefault();
    const errors: FieldErrors = {};
    if (!USERNAME_RE.test(setupUsername.trim())) errors.username = t("setup.errUsername");
    if (setupPassword.length < MIN_PASSWORD_LENGTH) errors.password = t("setup.errPassword");
    if (confirm !== setupPassword) errors.confirm = t("setup.errConfirm");
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;
    setup.mutate(
      { username: setupUsername.trim(), password: setupPassword },
      { onSuccess: () => setCreated(true) },
    );
  };

  const inputClass =
    "rounded-md border border-zinc-700 bg-zinc-800/60 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-sky-600 focus:outline-none";
  const fieldErrorClass =
    "flex items-start gap-1.5 rounded-md border border-red-900/60 bg-red-950/40 px-2.5 py-2 text-xs text-red-300";

  const cardClass = "flex flex-col gap-4 rounded-xl border border-zinc-800 bg-zinc-900 p-5 shadow-2xl";

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-950 px-4 text-zinc-100">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-3">
          <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-violet-600 to-cyan-500 shadow-lg shadow-violet-900/40">
            <Gamepad2 className="h-6 w-6 text-white" />
          </span>
          <div className="text-center">
            <h1 className="text-lg font-bold tracking-wide text-white">ScreenPlay</h1>
            <p className="text-xs text-zinc-400">{t(needsSetup ? "app.tagline" : "login.title")}</p>
          </div>
        </div>

        {needsSetup ? (
          created ? (
            <div className={cardClass}>
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-400" />
                <h2 className="text-sm font-semibold text-white">{t("setup.done")}</h2>
              </div>
              <p className="text-xs leading-relaxed text-zinc-400">{t("setup.doneHint")}</p>
              <Button type="button" onClick={() => navigate("/settings")}>
                {t("setup.goSettings")}
              </Button>
              <Button type="button" variant="secondary" onClick={() => navigate("/")}>
                {t("setup.goHome")}
              </Button>
            </div>
          ) : (
            <form onSubmit={submitSetup} className={cardClass}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold text-white">{t("setup.title")}</h2>
                  <p className="mt-1 text-[11px] leading-relaxed text-zinc-400">{t("setup.intro")}</p>
                </div>
                <button
                  type="button"
                  onClick={toggleLang}
                  className="shrink-0 text-[11px] font-normal text-zinc-500 transition-colors hover:text-zinc-300"
                >
                  {t(lang === "zh-CN" ? "lang.en" : "lang.zh")}
                </button>
              </div>

              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-zinc-300">{t("setup.username")}</span>
                <input
                  value={setupUsername}
                  onChange={(e) => {
                    setSetupUsername(e.target.value);
                    setFieldErrors((prev) => ({ ...prev, username: undefined }));
                  }}
                  autoFocus
                  autoComplete="username"
                  className={inputClass}
                />
              </label>
              {fieldErrors.username && (
                <p className={fieldErrorClass}>
                  <TriangleAlert className="mt-px h-3.5 w-3.5 shrink-0" />
                  <span>{fieldErrors.username}</span>
                </p>
              )}

              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-zinc-300">{t("setup.password")}</span>
                <input
                  type="password"
                  value={setupPassword}
                  onChange={(e) => {
                    setSetupPassword(e.target.value);
                    setFieldErrors((prev) => ({ ...prev, password: undefined }));
                  }}
                  autoComplete="new-password"
                  className={inputClass}
                />
              </label>
              {fieldErrors.password && (
                <p className={fieldErrorClass}>
                  <TriangleAlert className="mt-px h-3.5 w-3.5 shrink-0" />
                  <span>{fieldErrors.password}</span>
                </p>
              )}

              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-zinc-300">{t("setup.confirm")}</span>
                <input
                  type="password"
                  value={confirm}
                  onChange={(e) => {
                    setConfirm(e.target.value);
                    setFieldErrors((prev) => ({ ...prev, confirm: undefined }));
                  }}
                  autoComplete="new-password"
                  className={inputClass}
                />
              </label>
              {fieldErrors.confirm && (
                <p className={fieldErrorClass}>
                  <TriangleAlert className="mt-px h-3.5 w-3.5 shrink-0" />
                  <span>{fieldErrors.confirm}</span>
                </p>
              )}

              {setup.isError && (
                <p className={fieldErrorClass}>
                  <TriangleAlert className="mt-px h-3.5 w-3.5 shrink-0" />
                  <span>{(setup.error as Error).message}</span>
                </p>
              )}

              <Button
                type="submit"
                disabled={setup.isPending || !setupUsername || !setupPassword || !confirm}
              >
                {setup.isPending ? (
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                ) : (
                  <ShieldCheck className="mr-1.5 h-4 w-4" />
                )}
                {t(setup.isPending ? "setup.creating" : "setup.submit")}
              </Button>

              <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-zinc-500">
                <ShieldCheck className="mt-px h-3.5 w-3.5 shrink-0" />
                <span>{t("setup.hint")}</span>
              </p>
            </form>
          )
        ) : (
          <form
            onSubmit={submit}
            className="flex flex-col gap-4 rounded-xl border border-zinc-800 bg-zinc-900 p-5 shadow-2xl"
          >
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-zinc-300">{t("login.username")}</span>
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                autoFocus
                list={systemUsers.length ? "nas-users" : undefined}
                placeholder={t(usingSystem ? "login.usernamePlaceholderSystem" : "login.usernamePlaceholderLocal")}
                className="rounded-md border border-zinc-700 bg-zinc-800/60 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-sky-600 focus:outline-none"
              />
            </label>
            {systemUsers.length > 0 && (
              <datalist id="nas-users">
                {systemUsers.map((u) => (
                  <option key={u.username} value={u.username}>
                    {u.gecos || u.username}
                  </option>
                ))}
              </datalist>
            )}

            <label className="flex flex-col gap-1.5">
              <span className="flex items-center justify-between text-xs font-medium text-zinc-300">
              {t("login.password")}
              <button
                type="button"
                onClick={toggleLang}
                className="text-[11px] font-normal text-zinc-500 transition-colors hover:text-zinc-300"
              >
                {t(lang === "zh-CN" ? "lang.en" : "lang.zh")}
              </button>
            </span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                className="rounded-md border border-zinc-700 bg-zinc-800/60 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-sky-600 focus:outline-none"
              />
            </label>

            <label className="flex items-center gap-2 text-xs text-zinc-400">
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-zinc-600 bg-zinc-800"
              />
              {t("login.remember")}
            </label>

            {login.isError && (
              <p className="flex items-start gap-1.5 rounded-md border border-red-900/60 bg-red-950/40 px-2.5 py-2 text-xs text-red-300">
                <TriangleAlert className="mt-px h-3.5 w-3.5 shrink-0" />
                <span>{(login.error as Error).message}</span>
              </p>
            )}

            <Button type="submit" disabled={login.isPending || !username || !password}>
              {login.isPending ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <LogIn className="mr-1.5 h-4 w-4" />
              )}
              {t("login.submit")}
            </Button>

            <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-zinc-500">
              <ShieldCheck className="mt-px h-3.5 w-3.5 shrink-0" />
              <span>
                {usingSystem
                  ? t("login.hintSystem")
                  : `${t("login.hintLocal")}${session?.reason ? ` (${session.reason})` : ""}`}
              </span>
            </p>
          </form>
        )}

        <p className="mt-4 text-center text-[11px] text-zinc-600">
          {t("login.footer")}
        </p>
      </div>
    </div>
  );
}