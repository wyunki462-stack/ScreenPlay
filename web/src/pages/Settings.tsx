import { useEffect, useState, type ChangeEvent, type FormEvent } from "react";
import {
  Clock,
  ExternalLink,
  KeyRound,
  Languages,
  Lock,
  MessageSquareQuote,
  RefreshCw,
  Save,
} from "lucide-react";
import {
  useBackfillDurations,
  useBackfillMediaReviews,
  useDurationCoverage,
  useMediaReviewsCoverage,
  useMetadataStatus,
  useRefreshAll,
  useSaveSettings,
  useSettings,
  useTestImage,
  useTestProxy,
  useTestRawg,
  useTestSteamAchievements,
} from "../api/hooks";
import { useAuthSession, useChangePassword } from "../api/auth";
import { Button } from "../components/ui/Button";
import { Card, CardContent, CardHeader } from "../components/ui/Card";
import { Input } from "../components/ui/Input";
import LibraryManager from "../components/LibraryManager";
import { LANGS, useI18n } from "../i18n";

interface FormState {
  rawgApiKey: string;
  rawgProxy: string;
  steamApiKey: string;
  steamdbKey: string;
}

const empty: FormState = {
  rawgApiKey: "",
  rawgProxy: "",
  steamApiKey: "",
  steamdbKey: "",
};

function Field({
  label,
  hint,
  value,
  onChange,
  placeholder,
  type = "password",
  autoComplete = "off",
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
  placeholder?: string;
  type?: string;
  autoComplete?: string;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm text-zinc-300">{label}</span>
      <Input
        type={type}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        autoComplete={autoComplete}
        spellCheck={false}
      />
      {hint ? <span className="block text-xs text-zinc-500">{hint}</span> : null}
    </label>
  );
}

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

export default function Settings() {
  const { t, lang, setLang } = useI18n();
  const { data, isLoading } = useSettings();
  const saveSettings = useSaveSettings();
  const refreshAll = useRefreshAll();
  const metadataStatus = useMetadataStatus();
  const backfill = useBackfillDurations();
  const coverage = useDurationCoverage();
  const reviewsBackfill = useBackfillMediaReviews();
  const reviewsCoverage = useMediaReviewsCoverage();
  const testRawg = useTestRawg();
  const testSteamAch = useTestSteamAchievements();
  const testImage = useTestImage();
  const testProxy = useTestProxy();

  const [form, setForm] = useState<FormState>(empty);
  const [saved, setSaved] = useState(false);

  // ---- Change password (local accounts only) ----
  const { data: session } = useAuthSession();
  const changePassword = useChangePassword();
  const [pw, setPw] = useState<PasswordFormState>(emptyPassword);
  const [pwMessage, setPwMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  /**
   * Who may change a password right now:
   *   - signed in as a local account → the form;
   *   - signed in as a NAS system account → its password lives on the NAS;
   *   - auth disabled, or not signed in → a plain explanation, never an error.
   */
  const pwAvailable = !!session?.authenticated && session.user?.provider === "local";

  useEffect(() => {
    if (data) {
      setForm({
        rawgApiKey: data.rawgApiKey ?? "",
        rawgProxy: data.rawgProxy ?? "",
        steamApiKey: data.steamApiKey ?? "",
        steamdbKey: data.steamdbKey ?? "",
      });
    }
  }, [data]);

  const set = (key: keyof FormState) => (e: ChangeEvent<HTMLInputElement>) => {
    setSaved(false);
    setForm((f) => ({ ...f, [key]: e.target.value }));
  };

  const onSave = () => {
    setSaved(false);
    saveSettings.mutate(form, {
      onSuccess: () => setSaved(true),
    });
  };

  const onScrapeAll = () => {
    setSaved(false);
    // Persist the latest key first so the backend scrape reads the newly-saved RAWG key.
    saveSettings.mutate(form, {
      onSuccess: () => {
        setSaved(true);
        refreshAll.mutate();
      },
    });
  };

  const onTestRawg = () => {
    setSaved(false);
    saveSettings.mutate(form, {
      onSuccess: () => {
        setSaved(true);
        testRawg.mutate();
      },
    });
  };

  /**
   * Save first, then test: the backend reads the key from stored settings, so
   * testing an unsaved key would diagnose the previous one and mislead.
   */
  const onTestSteamAchievements = () => {
    setSaved(false);
    saveSettings.mutate(form, {
      onSuccess: () => {
        setSaved(true);
        testSteamAch.mutate();
      },
    });
  };

  const onTestImage = () => {
    setSaved(false);
    saveSettings.mutate(form, {
      onSuccess: () => {
        setSaved(true);
        testImage.mutate();
      },
    });
  };

  /**
   * Diagnose the proxy itself. The field value is sent along so an unsaved or
   * invalid address is still diagnosed (the backend refuses to persist it).
   */
  const onTestProxy = () => {
    setSaved(false);
    testProxy.mutate(form.rawgProxy);
  };

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
    <div className="mx-auto max-w-2xl space-y-4">
      <div>
        <h1 className="text-xl font-bold text-white">{t("settings.title")}</h1>
        <p className="mt-1 text-sm text-zinc-400">
          {t("settings.introLead")}
          <strong className="text-zinc-200">RAWG API Key</strong>
          {t("settings.introRest")}
        </p>
      </div>

      {/*
        Interface language. It is React state, so picking a language re-renders
        the whole tree instantly — deliberately no window.location.reload().
      */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Languages className="h-4 w-4 text-zinc-400" />
            <span>{t("lang.label")}</span>
          </div>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-zinc-500">{t("lang.description")}</p>
          <div
            role="group"
            aria-label={t("lang.label")}
            className="flex shrink-0 overflow-hidden rounded-md border border-zinc-700"
          >
            {LANGS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setLang(option.value)}
                aria-pressed={lang === option.value}
                className={`px-3 py-1.5 text-xs transition-colors ${
                  lang === option.value
                    ? "bg-violet-600 text-white"
                    : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
                }`}
              >
                {t(option.labelKey)}
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Feature 2: media library management */}
      <LibraryManager />

      {/* Change password. The form only makes sense for an app-local account:
          NAS system accounts are verified against the host shadow file, which
          this app cannot write, and with auth disabled there is nothing to
          protect. Both cases show an explanation instead of a dead form. */}
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

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-zinc-400" />
            <span>{t("settings.apiKeys")}</span>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {isLoading ? (
            <p className="text-sm text-zinc-500">{t("action.loading")}</p>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <Field
                    label={t("settings.rawg.label")}
                    hint={t("settings.rawg.hint")}
                    value={form.rawgApiKey}
                    onChange={set("rawgApiKey")}
                    placeholder={t("settings.rawg.placeholder")}
                  />
                  <div className="mt-2 flex items-center gap-2">
                    <Button variant="outline" onClick={onTestRawg} disabled={testRawg.isPending || saveSettings.isPending}>
                      {testRawg.isPending ? t("settings.test.testing") : t("settings.test.connection")}
                    </Button>
                    {testRawg.data && (
                      <span className={`text-xs ${testRawg.data.ok ? "text-emerald-400" : "text-rose-400"}`}>
                        {testRawg.data.message}
                      </span>
                    )}
                  </div>
                </div>
                <div className="sm:col-span-2">
                  <Field
                    label={t("settings.proxy.label")}
                    hint={t("settings.proxy.hint")}
                    value={form.rawgProxy}
                    onChange={set("rawgProxy")}
                    placeholder={t("settings.proxy.placeholder")}
                    type="text"
                  />
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Button variant="outline" onClick={onTestImage} disabled={testImage.isPending || saveSettings.isPending}>
                      {testImage.isPending ? t("settings.test.testing") : t("settings.test.image")}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={onTestProxy}
                      disabled={testProxy.isPending || saveSettings.isPending}
                    >
                      {testProxy.isPending ? t("settings.test.diagnosing") : t("settings.test.proxy")}
                    </Button>
                  </div>
                  {testImage.data && (
                    <p className={`mt-2 text-xs ${testImage.data.ok ? "text-emerald-400" : "text-rose-400"}`}>
                      {testImage.data.message}
                    </p>
                  )}
                  {testProxy.data && (
                    <div className="mt-2 space-y-1 rounded-md border border-zinc-800 bg-zinc-900/60 p-2">
                      <p className={`text-xs ${testProxy.data.ok ? "text-emerald-400" : "text-rose-400"}`}>
                        {testProxy.data.message}
                      </p>
                      <p className="text-[11px] text-zinc-500">
                        {t("settings.proxy.gateway", {
                          host: testProxy.data.hostGateway ?? t("state.unknown"),
                        })}
                      </p>
                      <ul className="space-y-0.5">
                        {testProxy.data.candidates.map((c) => (
                          <li key={c.url} className="flex items-center gap-2 text-[11px]">
                            <span className={c.http || c.https ? "text-emerald-400" : "text-zinc-600"}>
                              {c.http ? "HTTP ✓" : c.https ? "HTTPS ✓" : "✗"}
                            </span>
                            <code className="text-zinc-400">{c.url}</code>
                            {(c.http || c.https) && c.url !== testProxy.data.validated ? (
                              <button
                                type="button"
                                className="text-sky-400 underline"
                                onClick={() => setForm((f) => ({ ...f, rawgProxy: c.url }))}
                              >
                                {t("settings.proxy.useThis")}
                              </button>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
                <Field
                  label={t("settings.steam.label")}
                  hint={t("settings.steam.hint")}
                  value={form.steamApiKey}
                  onChange={set("steamApiKey")}
                  placeholder={t("settings.steam.placeholder")}
                />
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="outline"
                    onClick={onTestSteamAchievements}
                    disabled={testSteamAch.isPending || saveSettings.isPending}
                  >
                    {testSteamAch.isPending
                      ? t("settings.test.testing")
                      : t("settings.test.steamAchievements")}
                  </Button>
                  {testSteamAch.data && (
                    <span
                      className={`text-xs ${testSteamAch.data.ok ? "text-emerald-400" : "text-rose-400"}`}
                    >
                      {testSteamAch.data.message}
                    </span>
                  )}
                </div>
                <Field
                  label={t("settings.steamdb.label")}
                  hint={t("settings.steamdb.hint")}
                  value={form.steamdbKey}
                  onChange={set("steamdbKey")}
                  placeholder={t("settings.steamdb.placeholder")}
                />
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button onClick={onSave} disabled={saveSettings.isPending}>
                  <Save className="h-4 w-4" />
                  {saveSettings.isPending ? t("settings.saving") : t("action.save")}
                </Button>
                <Button
                  variant="secondary"
                  onClick={onScrapeAll}
                  disabled={refreshAll.isPending || !!metadataStatus.data?.running}
                >
                  <RefreshCw className="h-4 w-4" />
                  {t("settings.scrapeAll")}
                </Button>
                {saved && <span className="text-sm text-emerald-400">{t("settings.saved")}</span>}
                {refreshAll.isSuccess && (
                  <span className="text-sm text-zinc-400">
                    {t("settings.scrapeStarted", { count: refreshAll.data?.total ?? 0 })}
                  </span>
                )}
              </div>

              {metadataStatus.data &&
              (metadataStatus.data.running || (metadataStatus.data.failed ?? 0) > 0) && (
                <div className="space-y-1.5">
                  {metadataStatus.data.running && (
                    <>
                      <div className="flex items-center justify-between text-xs text-zinc-400">
                        <span className="min-w-0 truncate">
                          {t("settings.scraping", {
                            name: metadataStatus.data.current ?? t("settings.preparing"),
                          })}
                        </span>
                        <span className="shrink-0 pl-2">
                          {metadataStatus.data.done} / {metadataStatus.data.total}
                        </span>
                      </div>
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
                        <div
                          className="h-full rounded-full bg-violet-500 transition-all duration-300"
                          style={{
                            width: `${
                              metadataStatus.data.total
                                ? Math.round((metadataStatus.data.done / metadataStatus.data.total) * 100)
                                : 0
                            }%`,
                          }}
                        />
                      </div>
                    </>
                  )}
                  {(metadataStatus.data.failed ?? 0) > 0 && (
                    <div className="rounded-lg border border-rose-900/50 bg-rose-950/30 px-3 py-2 text-xs text-rose-300">
                      {t("settings.scrapeFailed", { count: metadataStatus.data.failed ?? 0 })}
                    </div>
                  )}
                </div>
              )}

              {saveSettings.isError && (
                <p className="text-sm text-rose-400">
                  {t("settings.saveError", { message: (saveSettings.error as Error)?.message ?? "" })}
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* 需求3：存量游戏一键批量补全通关时长。放在「数据源」卡片之外，因为它是
          一次性的存量修复动作，和配置数据源不是一回事。 */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-zinc-400" />
            <span>{t("settings.duration.title")}</span>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm leading-relaxed text-zinc-400">{t("settings.duration.intro")}</p>

          {coverage.isLoading ? (
            <div className="text-sm text-zinc-500">{t("settings.duration.loading")}</div>
          ) : coverage.isError ? (
            <div className="rounded-lg border border-rose-900/50 bg-rose-950/30 px-3 py-2 text-xs text-rose-300">
              {t("settings.duration.coverageFailed")}
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <span className="rounded-full border border-zinc-700 bg-zinc-800/70 px-3 py-1 text-xs tabular-nums text-zinc-300">
                {t("settings.duration.coverage", {
                  have: coverage.data?.withDuration ?? 0,
                  total: coverage.data?.total ?? 0,
                })}
              </span>
              <span
                data-testid="duration-missing"
                className={`rounded-full border px-3 py-1 text-xs tabular-nums ${
                  (coverage.data?.missing ?? 0) > 0
                    ? "border-amber-800 bg-amber-950/40 text-amber-300"
                    : "border-emerald-900/60 bg-emerald-950/30 text-emerald-300"
                }`}
              >
                {t("settings.duration.missing", { count: coverage.data?.missing ?? 0 })}
              </span>
              {(coverage.data?.sources ?? []).map((s) => (
                <span key={s.source} className="text-xs text-zinc-500">
                  {t("settings.duration.source", { source: s.source, count: s.count })}
                </span>
              ))}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="secondary"
              data-testid="backfill-durations"
              onClick={() => backfill.mutate()}
              disabled={backfill.isPending || !!metadataStatus.data?.running}
            >
              <Clock className={`h-4 w-4 ${backfill.isPending ? "animate-spin" : ""}`} />
              {backfill.isPending ? t("settings.duration.starting") : t("settings.duration.run")}
            </Button>
            {backfill.isError && (
              <span className="text-sm text-rose-400">{t("settings.duration.failed")}</span>
            )}
            {backfill.isSuccess && !metadataStatus.data?.running && (
              <span data-testid="backfill-result" className="text-sm text-zinc-400">
                {t("settings.duration.started", { count: backfill.data?.total ?? 0 })}
              </span>
            )}
          </div>

          {metadataStatus.data?.running && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs text-zinc-400">
                <span className="min-w-0 truncate">
                  {t("settings.scraping", {
                    name: metadataStatus.data.current ?? t("settings.preparing"),
                  })}
                </span>
                <span className="shrink-0 pl-2 tabular-nums">
                  {metadataStatus.data.done} / {metadataStatus.data.total}
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
                <div
                  className="h-full rounded-full bg-violet-500 transition-all duration-300"
                  style={{
                    width: `${
                      metadataStatus.data.total
                        ? Math.round((metadataStatus.data.done / metadataStatus.data.total) * 100)
                        : 0
                    }%`,
                  }}
                />
              </div>
            </div>
          )}

          <p className="text-xs leading-relaxed text-zinc-500">{t("settings.duration.tip")}</p>
        </CardContent>
      </Card>

      {/* 媒体评价补全：与时长补全同构的存量修复动作。
          数据源需要逐游戏访问页面，所以这里和时长补全不同 —— 是同步返回结果的，
          按钮上直接显示「处理了几款 / 新增了几条 / 还缺几款」。 */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <MessageSquareQuote className="h-4 w-4 text-zinc-400" />
            <span>{t("settings.reviews.title")}</span>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm leading-relaxed text-zinc-400">{t("settings.reviews.intro")}</p>

          {reviewsCoverage.isLoading ? (
            <div className="text-sm text-zinc-500">{t("settings.reviews.loading")}</div>
          ) : reviewsCoverage.isError ? (
            <div className="rounded-lg border border-rose-900/50 bg-rose-950/30 px-3 py-2 text-xs text-rose-300">
              {t("settings.reviews.coverageFailed")}
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <span className="rounded-full border border-zinc-700 bg-zinc-800/70 px-3 py-1 text-xs tabular-nums text-zinc-300">
                {t("settings.reviews.coverage", {
                  have: reviewsCoverage.data?.withReviews ?? 0,
                  total: reviewsCoverage.data?.total ?? 0,
                })}
              </span>
              <span
                data-testid="reviews-awaiting"
                className={`rounded-full border px-3 py-1 text-xs tabular-nums ${
                  (reviewsCoverage.data?.awaiting ?? 0) > 0
                    ? "border-amber-800 bg-amber-950/40 text-amber-300"
                    : "border-emerald-900/60 bg-emerald-950/30 text-emerald-300"
                }`}
              >
                {t("settings.reviews.awaiting", { count: reviewsCoverage.data?.awaiting ?? 0 })}
              </span>
              {(reviewsCoverage.data?.failed ?? 0) > 0 && (
                <span className="rounded-full border border-rose-900/60 bg-rose-950/30 px-3 py-1 text-xs tabular-nums text-rose-300">
                  {t("settings.reviews.failedCount", { count: reviewsCoverage.data?.failed ?? 0 })}
                </span>
              )}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="secondary"
              data-testid="backfill-media-reviews"
              onClick={() => reviewsBackfill.mutate({ scope: "missing" })}
              disabled={reviewsBackfill.isPending}
            >
              <MessageSquareQuote className={`h-4 w-4 ${reviewsBackfill.isPending ? "animate-pulse" : ""}`} />
              {reviewsBackfill.isPending
                ? t("settings.reviews.running")
                : t("settings.reviews.run")}
            </Button>
            {/* 全量重抓：解析器修好之后，用它修复「抓过但没解析出评价」的存量数据。 */}
            <Button
              variant="ghost"
              data-testid="backfill-media-reviews-all"
              onClick={() => reviewsBackfill.mutate({ scope: "all" })}
              disabled={reviewsBackfill.isPending}
            >
              {t("settings.reviews.runAll", { count: reviewsCoverage.data?.total ?? 0 })}
            </Button>
            {reviewsBackfill.isError && (
              <span className="text-sm text-rose-400">{t("settings.reviews.failed")}</span>
            )}
          </div>

          {reviewsBackfill.isSuccess && (
            <div
              data-testid="reviews-backfill-result"
              className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-xs text-zinc-300"
            >
              {reviewsBackfill.data.processed === 0
                ? t("settings.reviews.resultEmpty")
                : t("settings.reviews.result", {
                    processed: reviewsBackfill.data.processed,
                    gained: reviewsBackfill.data.gained,
                    stored: reviewsBackfill.data.reviewsStored,
                    failed: reviewsBackfill.data.failed,
                    remaining: reviewsBackfill.data.remaining,
                  })}
            </div>
          )}

          <p className="text-xs leading-relaxed text-zinc-500">{t("settings.reviews.tip")}</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <ExternalLink className="h-4 w-4 text-zinc-400" />
            <span>{t("settings.howTo.title")}</span>
          </div>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-zinc-400">
          <div>
            <span className="text-zinc-300">{t("settings.howTo.rawgLabel")}</span>
            {t("settings.howTo.goTo")}{" "}
            <a
              href="https://rawg.io/apidocs"
              target="_blank"
              rel="noreferrer"
              className="text-violet-400 underline underline-offset-2 hover:text-violet-300"
            >
              rawg.io/apidocs
            </a>{" "}
            {t("settings.howTo.rawgText")}
          </div>
          <div>
            <span className="text-zinc-300">{t("settings.howTo.steamLabel")}</span>
            {t("settings.howTo.goTo")}{" "}
            <a
              href="https://steamcommunity.com/dev/apikey"
              target="_blank"
              rel="noreferrer"
              className="text-violet-400 underline underline-offset-2 hover:text-violet-300"
            >
              steamcommunity.com/dev/apikey
            </a>{" "}
            {t("settings.howTo.steamText")}
          </div>
          <div className="pt-1 text-xs text-zinc-500">{t("settings.howTo.tip")}</div>
        </CardContent>
      </Card>
    </div>
  );
}