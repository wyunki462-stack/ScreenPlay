import { Link, Route, Routes } from "react-router-dom";
import { Gamepad2, Languages, LogOut, User } from "lucide-react";
import Home from "./pages/Home";
import GameDetail from "./pages/GameDetail";
import Settings from "./pages/Settings";
import Login from "./pages/Login";
import { useAuthSession, useLogout } from "./api/auth";
import { useI18n } from "./i18n";

export default function App() {
  const { data: session, isPending } = useAuthSession();
  const logout = useLogout();
  const { t, lang, setLang } = useI18n();

  // Hold the shell back until we know whether a login is required: rendering the
  // gallery first would fire a burst of 401s against every protected endpoint.
  if (isPending) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-950 text-sm text-zinc-500">
        {t("app.checkingSession")}
      </div>
    );
  }

  // Either auth is off (AUTH_DISABLED=1) or the user is signed in.
  if (session?.enabled && !session.authenticated) {
    return <Login />;
  }

  return (
    <div className="flex min-h-screen flex-col bg-zinc-950 text-zinc-100">
      <header className="sticky top-0 z-40 border-b border-zinc-800/80 bg-zinc-950/80 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-7xl items-center gap-3 px-4 sm:px-6">
          <Link to="/" className="flex items-center gap-2.5 rounded-lg transition-opacity hover:opacity-90">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-violet-600 to-cyan-500 shadow-lg shadow-violet-900/40">
              <Gamepad2 className="h-5 w-5 text-white" />
            </span>
            <span className="flex flex-col leading-tight">
              <span className="text-sm font-bold tracking-wide text-white">{t("app.name")}</span>
              <span className="text-xs text-zinc-400">{t("app.tagline")}</span>
            </span>
          </Link>
          <nav className="ml-auto flex items-center gap-1 text-sm">
            <Link
              to="/"
              className="rounded-md px-3 py-1.5 text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-white"
            >
              {t("nav.gallery")}
            </Link>
            <Link
              to="/settings"
              className="rounded-md px-3 py-1.5 text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-white"
            >
              {t("nav.settings")}
            </Link>

            {/* Quick language toggle — the full option also lives in Settings. */}
            <button
              onClick={() => setLang(lang === "zh-CN" ? "en" : "zh-CN")}
              title={t("lang.label")}
              className="ml-1 flex items-center gap-1 rounded-md px-2 py-1.5 text-xs text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-white"
            >
              <Languages className="h-3.5 w-3.5" />
              {lang === "zh-CN" ? "中" : "EN"}
            </button>

            {session?.authenticated && session.user && (
              <span className="ml-1 flex items-center gap-2 border-l border-zinc-800 pl-3">
                <span
                  className="flex items-center gap-1.5 text-xs text-zinc-400"
                  title={
                    session.user.provider === "system"
                      ? t("nav.loggedInViaSystem")
                      : t("nav.loggedInViaLocal")
                  }
                >
                  <User className="h-3.5 w-3.5" />
                  {session.user.displayName || session.user.username}
                </span>
                <button
                  onClick={() => logout.mutate()}
                  disabled={logout.isPending}
                  title={t("nav.logout")}
                  className="rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-white disabled:opacity-50"
                >
                  <LogOut className="h-4 w-4" />
                </button>
              </span>
            )}
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/game/:id" element={<GameDetail />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </main>

      <footer className="border-t border-zinc-800/80 py-6 text-center text-xs text-zinc-500">
        {t("app.footer")}
      </footer>
    </div>
  );
}