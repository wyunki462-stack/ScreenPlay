/**
 * Interface language switching.
 *
 * `zh-CN` is the default and the source dictionary; `en` mirrors it. Switching
 * is a state update, so the whole tree re-renders immediately — no page reload.
 *
 * Persistence is two-layered:
 *   - `localStorage` gives an instant, flash-free start on the next visit;
 *   - the backend `ui.language` setting keeps the choice across browsers and
 *     survives a container restart (it lives in the SQLite data volume).
 * The stored value wins over the browser default, so a returning user never
 * sees the wrong language flash before the request completes.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { zh } from "./zh";
import { en } from "./en";

export type Lang = "zh-CN" | "en";

export const LANGS: Array<{ value: Lang; labelKey: string }> = [
  { value: "zh-CN", labelKey: "lang.zh" },
  { value: "en", labelKey: "lang.en" },
];

const DICTS: Record<Lang, Record<string, string>> = { "zh-CN": zh, en };

const STORAGE_KEY = "screenplay.lang";
export const DEFAULT_LANG: Lang = "zh-CN";

function isLang(v: unknown): v is Lang {
  return v === "zh-CN" || v === "en";
}

/** Read the cached choice; the backend value is fetched afterwards. */
function readCachedLang(): Lang {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (isLang(v)) return v;
  } catch {
    // Private mode / storage disabled — the default is fine.
  }
  return DEFAULT_LANG;
}

export type Translate = (key: string, vars?: Record<string, string | number>) => string;

interface I18nContextValue {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: Translate;
}

const I18nContext = createContext<I18nContextValue>({
  lang: DEFAULT_LANG,
  setLang: () => {},
  t: (key) => zh[key] ?? key,
});

/** Replace `{name}` placeholders with the supplied values. */
function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}

/**
 * Language currently in effect, mirrored outside React so non-component modules
 * (the fetch client's error messages, for example) can translate too.
 */
let activeLang: Lang = readCachedLang();

/** Translate without a hook. For modules that are not React components. */
export function translateNow(key: string, vars?: Record<string, string | number>): string {
  const value = DICTS[activeLang][key] ?? zh[key] ?? key;
  return interpolate(value, vars);
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>(readCachedLang);

  // Mirror the choice into the backend so other browsers (and a reloaded
  // container) keep it. Failures are non-fatal: localStorage already has it.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/settings/preferences");
        if (!res.ok) return;
        const data = (await res.json()) as { language?: string };
        if (!cancelled && isLang(data.language) && data.language !== readCachedLang()) {
          setLangState(data.language);
          try {
            localStorage.setItem(STORAGE_KEY, data.language);
          } catch {
            /* ignore */
          }
        }
      } catch {
        // Offline or signed out — fall back to the cached/default language.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* ignore */
    }
    void fetch("/api/settings/preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ language: next }),
    }).catch(() => {
      /* the local copy is authoritative for this browser */
    });
  }, []);

  // Keep <html lang> in sync so the browser picks the right fonts/hyphenation,
  // and mirror the choice for translateNow().
  useEffect(() => {
    activeLang = lang;
    document.documentElement.lang = lang;
  }, [lang]);

  const t = useCallback<Translate>(
    (key, vars) => {
      const value = DICTS[lang][key] ?? zh[key] ?? key;
      return interpolate(value, vars);
    },
    [lang],
  );

  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** `const { t, lang, setLang } = useI18n();` */
export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}

/**
 * Convenience for components that only translate. Equivalent to `useI18n().t`,
 * kept separate so the dependency is obvious at the call site.
 */
export function useT(): Translate {
  return useContext(I18nContext).t;
}