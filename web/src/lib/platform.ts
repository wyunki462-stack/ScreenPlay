/**
 * Which target this bundle is built for.
 *
 * `desktop` is set by the desktop build: `npm run build:desktop` in `web/` runs
 * `vite build --mode desktop`, which loads `web/.env.desktop` and with it
 * `VITE_SCREENPLAY_TARGET=desktop`. The desktop shell ships the very same web
 * app as a single-machine install — same routes, same cards, same text — and
 * differs only in where the bundle lands (`web/dist-desktop`, served
 * same-origin by the Tauri shell).
 *
 * Up to 1.3.2 the flag also *stripped* UI from that artifact: `--mode desktop`
 * aliased `ChangePasswordCard.tsx` to an empty stub, so the change-password card
 * was absent from the desktop bundle. 1.3.3 removed that裁剪 — a single-machine
 * install can run a local account too, so the settings page must offer the same
 * card as Web/Linux. The flag is kept for target detection (and any future
 * platform-specific difference).
 *
 * A plain `vite build`, the dev server and the Linux container build are the
 * `server` target.
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