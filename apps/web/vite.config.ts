import { readFileSync } from "node:fs";
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
 * the entry and every chunk it pulls in, which `build.rolldownOptions` keeps in two files.
 * Dialogs, sheets and views the first screen doesn't show load after it (`lazyPart`), each chunk
 * of those within the lazy chunk's budget: above Shiki's largest language grammars (emacs-lisp and
 * cpp, about 790 kB each) and the ghostty-web terminal (about 640 kB), each loaded only when a
 * code block or terminal needs it.
 *
 * Each route keeps a budget too: what opening it loads beyond the first paint, which is its own
 * chunk and every chunk that one imports statically. The budgets are in `bundle-budgets.json`,
 * in kB of minified code. A build over any of them fails, so a route that grew says so in the
 * pull request that grew it; raise the number there when the growth is meant.
 * `GRAM_BUNDLE_REPORT=1` prints every route's size.
 */
interface BundleBudgets {
  readonly firstPaintKb: number;
  readonly lazyChunkKb: number;
  /** By route file under `src/routes`, without `.tsx`; `default` is for a route not named. */
  readonly routeKb: Readonly<Record<string, number>>;
}
const budgets = JSON.parse(
  readFileSync(new URL("./bundle-budgets.json", import.meta.url), "utf8"),
) as BundleBudgets;
const ROUTE_MODULE = /[\\/]src[\\/]routes[\\/](.+)\.tsx\?tsr-split=component/;
const entryBudget: Plugin = {
  name: "gram-entry-budget",
  apply: "build",
  generateBundle(_options, bundle) {
    const chunks = new Map(
      Object.values(bundle).flatMap((each) =>
        each.type === "chunk" ? [[each.fileName, each]] : [],
      ),
    );
    const kbOf = (files: Iterable<string>) => {
      let bytes = 0;
      for (const fileName of files) bytes += Buffer.byteLength(chunks.get(fileName)?.code ?? "");
      return bytes / 1000;
    };
    /** `from` and every chunk it imports statically, leaving out what `loaded` already has. */
    const closure = (from: string, loaded: ReadonlySet<string>) => {
      const seen = new Set<string>();
      const visit = (fileName: string) => {
        if (seen.has(fileName) || loaded.has(fileName)) return;
        seen.add(fileName);
        for (const imported of chunks.get(fileName)?.imports ?? []) visit(imported);
      };
      visit(from);
      return seen;
    };
    const over: string[] = [];
    const initial = new Set<string>();
    for (const entry of chunks.values()) {
      if (!entry.isEntry) continue;
      const files = closure(entry.fileName, initial);
      for (const fileName of files) initial.add(fileName);
      const kb = kbOf(files);
      if (kb > budgets.firstPaintKb)
        over.push(
          `entry ${entry.fileName} loads ${kb.toFixed(0)} kB before first paint (${files.size} files), over its ${budgets.firstPaintKb} kB budget`,
        );
    }
    for (const chunk of chunks.values()) {
      if (initial.has(chunk.fileName)) continue;
      const kb = Buffer.byteLength(chunk.code) / 1000;
      if (kb > budgets.lazyChunkKb)
        over.push(
          `lazily loaded chunk ${chunk.fileName} is ${kb.toFixed(0)} kB, over its ${budgets.lazyChunkKb} kB budget`,
        );
    }
    const routes = new Map<string, number>();
    for (const chunk of chunks.values()) {
      for (const id of chunk.moduleIds) {
        const route = ROUTE_MODULE.exec(id)?.[1]?.replaceAll("\\", "/");
        if (route === undefined) continue;
        routes.set(route, kbOf(closure(chunk.fileName, initial)));
      }
    }
    for (const [route, kb] of [...routes].toSorted((a, b) => b[1] - a[1])) {
      const budget = budgets.routeKb[route] ?? budgets.routeKb["default"]!;
      if (process.env["GRAM_BUNDLE_REPORT"] === "1")
        this.info(`route ${route}: ${kb.toFixed(0)} kB of ${budget} kB`);
      if (kb > budget)
        over.push(
          `route ${route} loads ${kb.toFixed(0)} kB beyond the first paint, over its ${budget} kB budget`,
        );
    }
    for (const route of Object.keys(budgets.routeKb)) {
      if (route !== "default" && !routes.has(route))
        over.push(`bundle-budgets.json names the route ${route}, which the build does not have`);
    }
    if (over.length > 0)
      this.error(
        `${over.join("\n")}\nBudgets are in apps/web/bundle-budgets.json; raise one there when the growth is meant.`,
      );
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
    chunkSizeWarningLimit: budgets.firstPaintKb,
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
          //
          // The packages among them go in a file of their own, ahead of the app's code. They are
          // half of the first download and change with a dependency bump, not with a release, so
          // a browser that has them keeps them across updates and fetches only the app's half.
          groups: [
            { name: "vendor", tags: ["$initial"], test: /[\\/]node_modules[\\/]/, priority: 2 },
            { name: "initial", tags: ["$initial"], priority: 1 },
          ],
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
