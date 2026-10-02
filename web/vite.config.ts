import { fileURLToPath } from "node:url";

import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
// The dev server proxies `/api` to the backend. The target is overridable via
// the `VITE_API_BASE` env var (e.g. VITE_API_BASE=http://<backend-host>:3000).
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiTarget = env.VITE_API_BASE?.trim() || "http://localhost:3000";

  // `--mode desktop` (npm run build:desktop) is the single-machine desktop
  // bundle: `web/.env.desktop` sets VITE_SCREENPLAY_TARGET=desktop, which
  // `src/lib/platform.ts` exposes as IS_DESKTOP_TARGET. Server-only UI must not
  // be *hidden* in that artifact but absent, hence the module alias below (see
  // the stub's docblock).
  const desktop = env.VITE_SCREENPLAY_TARGET === "desktop";

  return {
    plugins: [react()],
    resolve: desktop
      ? {
          alias: [
            {
              // The regex must swallow the whole specifier: with a regexp
              // `find`, rollup replaces just the matched text inside the
              // importee, so a tail-only match would concatenate the stub's
              // absolute path onto the importer's relative prefix.
              find: /^.*\/ChangePasswordCard$/,
              replacement: fileURLToPath(
                new URL("./src/components/ChangePasswordCard.desktop-stub.tsx", import.meta.url),
              ),
            },
          ],
        }
      : undefined,
    server: {
      port: 5173,
      proxy: {
        "/api": {
          target: apiTarget,
          changeOrigin: true,
        },
      },
    },
    build: {
      outDir: desktop ? "dist-desktop" : "dist",
      sourcemap: false,
    },
  };
});