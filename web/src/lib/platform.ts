/**
 * Which target this bundle is built for.
 *
 * `desktop` is set by the desktop build: `npm run build:desktop` in `web/` runs
 * `vite build --mode desktop`, which loads `web/.env.desktop` and with it
 * `VITE_SCREENPLAY_TARGET=desktop`. The desktop shell ships the very same web
 * app as a single-machine install, and a couple of things that only make sense
 * on a shared server must disappear from that artifact itself instead of merely
 * being hidden at runtime:
 *
 *   - the change-password card. The desktop build swaps
 *     `web/src/components/ChangePasswordCard.tsx` for
 *     `web/src/components/ChangePasswordCard.desktop-stub.tsx` through the
 *     alias in `web/vite.config.ts`, so the card's markup, mutation hook and
 *     text (`ChangePasswordCard.i18n.ts`, imported by the card alone) are not
 *     in the bundle at all. On top of that, `web/src/pages/Settings.tsx`
 *     refuses to render it when `IS_DESKTOP_TARGET` is true.
 *
 * A plain `vite build`, the dev server and the Linux container build are the
 * `server` target and keep every feature.
 */
export type ScreenplayTarget = "server" | "desktop";

/**
 * Read through a local alias: a bundler that cannot resolve `import.meta.env`
 * (the offline verify harness bundles this source graph with esbuild as iife)
 * then degrades to the `server` target instead of throwing at module load.
 */
const env = import.meta.env as Record<string, string | undefined> | undefined;

export const SCREENPLAY_TARGET: ScreenplayTarget =
  env?.VITE_SCREENPLAY_TARGET === "desktop" ? "desktop" : "server";

/** True only in the single-machine desktop build. */
export const IS_DESKTOP_TARGET = SCREENPLAY_TARGET === "desktop";