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
    // Local phone access management only; never proxy the remote claim bridge via Vite.
    "^/remote/(pair|status|enable|disable|revoke)$": { target, changeOrigin: true },
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
 * What an entry imports statically loads before the first paint, so it keeps a budget of its own:
 * the entry and every chunk it pulls in, about 1,930 kB minified for the main entry, which
 * `build.rolldownOptions` keeps in one file. Dialogs, sheets and views the first screen doesn't
 * show load after it (`lazyPart`), each chunk of those within `LAZY_CHUNK_BUDGET_KB`: above Shiki's
 * largest language grammars (emacs-lisp and cpp, about 790 kB each) and the ghostty-web terminal
 * (about 640 kB), each loaded only when a code block or terminal needs it.
 */
const INITIAL_BUDGET_KB = 2050;
const LAZY_CHUNK_BUDGET_KB = 1000;
const entryBudget: Plugin = {
  name: "gram-entry-budget",
  apply: "build",
  generateBundle(_options, bundle) {
    const chunks = new Map(
      Object.values(bundle).flatMap((each) =>
        each.type === "chunk" ? [[each.fileName, each]] : [],
      ),
    );
    const initial = new Set<string>();
    for (const entry of chunks.values()) {
      if (!entry.isEntry) continue;
      const start = initial.size;
      const visit = (fileName: string) => {
        if (initial.has(fileName)) return;
        initial.add(fileName);
        for (const imported of chunks.get(fileName)?.imports ?? []) visit(imported);
      };
      visit(entry.fileName);
      const files = [...initial].slice(start);
      const kb =
        files.reduce((sum, fileName) => {
          const chunk = chunks.get(fileName);
          return sum + (chunk === undefined ? 0 : Buffer.byteLength(chunk.code));
        }, 0) / 1000;
      if (kb > INITIAL_BUDGET_KB)
        this.warn(
          `entry ${entry.fileName} loads ${kb.toFixed(0)} kB before first paint (${files.length} files), over its ${INITIAL_BUDGET_KB} kB budget`,
        );
    }
    for (const chunk of chunks.values()) {
      if (initial.has(chunk.fileName)) continue;
      const kb = Buffer.byteLength(chunk.code) / 1000;
      if (kb > LAZY_CHUNK_BUDGET_KB)
        this.warn(
          `lazily loaded chunk ${chunk.fileName} is ${kb.toFixed(0)} kB, over its ${LAZY_CHUNK_BUDGET_KB} kB budget`,
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
    // Vite's one limit for every chunk, set to the first paint's: `entryBudget` above holds that
    // load and each lazily loaded chunk to budgets of their own.
    chunkSizeWarningLimit: INITIAL_BUDGET_KB,
    // The React Compiler's Babel pass is most of every build by design; the timing notice it
    // triggers on each build says nothing new.
    rolldownOptions: {
      checks: { pluginTimings: false },
      output: {
        codeSplitting: {
          // Everything the entry imports statically, in one file. Left to itself the bundler cut
          // it into some 230 chunks shared with the parts loaded later, and the first paint
          // waited on every request: over HTTP/1.1, which the app's own server speaks, a few
          // hundred small files took longer than the bytes in them. What loads later stays in
          // chunks of its own, reusing this one's modules. `main.tsx` is bundled in it too, so it
          // starts without a top-level `await` (see there).
          groups: [{ name: "initial", tags: ["$initial"] }],
        },
      },
    },
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
