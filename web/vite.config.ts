import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
// The dev server proxies `/api` to the backend. The target is overridable via
// the `VITE_API_BASE` env var (e.g. VITE_API_BASE=http://<backend-host>:3000).
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiTarget = env.VITE_API_BASE?.trim() || "http://localhost:3000";

  // `--mode desktop` (npm run build:desktop) writes the single-machine desktop
  // bundle: `web/.env.desktop` sets VITE_SCREENPLAY_TARGET=desktop, which
  // `src/lib/platform.ts` exposes as IS_DESKTOP_TARGET. As of 1.3.3 the desktop
  // artifact is the *same* app as the server build — no module is swapped out —
  // and the flag now only picks the output directory (the Tauri shell and the
  // loader serve `web/dist-desktop` same-origin).
  const desktop = env.VITE_SCREENPLAY_TARGET === "desktop";

  return {
    plugins: [react()],
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