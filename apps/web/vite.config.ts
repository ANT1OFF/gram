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
    ...(e2eToken ? [e2eTokenEndpoint(e2eToken)] : []),
  ],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    port: 5173,
    strictPort: true,
    ...(serverPort ? { proxy: proxy(serverPort) } : {}),
  },
});
