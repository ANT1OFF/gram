import { fileURLToPath } from "node:url";
import { join } from "node:path";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig, type Connect, type Plugin, type ProxyOptions } from "vite";

import { bundledPackages } from "../../tools/notices/bundled-packages.mjs";

/**
 * Set by `scripts/dev.mjs`: the headless server's port. `/ws` and the `/?boot=<token>` navigation
 * are proxied to it, so the auth cookie is set on (and the socket dials) the Vite origin.
 */
const serverPort = process.env["GRAM_DEV_SERVER_PORT"];

/** Set by the Playwright run's `scripts/e2e-server.mjs`, which waits for it at `/__e2e`. */
const e2eToken = process.env["GRAM_E2E_TOKEN"];
const previewTemp = process.env["GRAM_PREVIEW_TEMP_DIR"];

const proxy = (port: string): Record<string, ProxyOptions> => {
  const target = `http://127.0.0.1:${port}`;
  // changeOrigin rewrites Host to the server's loopback host:port, which its allowlist requires.
  return {
    "/ws": { target, ws: true, changeOrigin: true },
    // Local authenticated pairing mint only; never proxy the remote claim bridge via Vite.
    "/remote/pair": { target, changeOrigin: true },
    "^/\\?boot=": { target, changeOrigin: true },
  };
};

/** Answers `/__e2e` with the run's token, so the e2e setup can tell this server from another. */
const e2eTokenEndpoint = (token: string): Plugin => {
  const answer: Connect.NextHandleFunction = (_req, res) => {
    res.setHeader("content-type", "text/plain");
    res.setHeader("cache-control", "no-store");
    res.end(token);
  };
  return {
    name: "gram-e2e-token",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__e2e", answer);
    },
    configurePreviewServer(server) {
      server.middlewares.use("/__e2e", answer);
    },
  };
};

/**
 * Entry chunks load before the first paint, so they keep a budget of their own (the main entry is
 * about 580 kB minified). Lazily loaded chunks get Vite's general limit below.
 */
const ENTRY_BUDGET_KB = 700;
const entryBudget: Plugin = {
  name: "gram-entry-budget",
  apply: "build",
  generateBundle(_options, bundle) {
    for (const chunk of Object.values(bundle)) {
      if (chunk.type !== "chunk" || !chunk.isEntry) continue;
      const kb = Buffer.byteLength(chunk.code) / 1000;
      if (kb > ENTRY_BUDGET_KB)
        this.warn(
          `entry chunk ${chunk.fileName} is ${kb.toFixed(0)} kB, over its ${ENTRY_BUDGET_KB} kB budget`,
        );
    }
  },
};

export default defineConfig({
  ...(previewTemp ? { cacheDir: join(previewTemp, "vite-cache"), envDir: false as const } : {}),
  plugins: [
    // Must run before the React plugin so generated route files are transformed too.
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
      ...(previewTemp ? { enableRouteGeneration: false, tmpDir: join(previewTemp, "router") } : {}),
    }),
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    tailwindcss(),
    // For the packaged app's third-party notices; see tools/notices.
    bundledPackages("web"),
    entryBudget,
    ...(e2eToken ? [e2eTokenEndpoint(e2eToken)] : []),
  ],
  build: {
    // Above Shiki's largest language grammars (emacs-lisp and cpp, about 790 kB each) and the
    // ghostty-web terminal (about 640 kB): each loads lazily, only when a code block or terminal
    // needs it, and the app reads them from disk. `entryBudget` above keeps the entry in check.
    chunkSizeWarningLimit: 1000,
    // The React Compiler's Babel pass is most of every build by design; the timing notice it
    // triggers on each build says nothing new.
    rolldownOptions: { checks: { pluginTimings: false } },
  },
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    port: 5173,
    strictPort: true,
    ...(serverPort ? { proxy: proxy(serverPort) } : {}),
  },
});
