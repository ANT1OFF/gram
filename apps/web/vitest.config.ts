import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { defineProject } from "vitest/config";

/**
 * Keeps modules that call `import.meta.glob` out of Vitest's on-disk module cache. The cache keys
 * a module on its own source, but a glob expands to whichever files match when it is transformed,
 * so a cached expansion misses a file added later (a new settings route, say) until the cache is
 * cleared. Vitest skips such modules itself only on the exact text `import.meta.glob(`, which the
 * typed `import.meta.glob<T>(` form used here doesn't contain.
 */
const globsSkipModuleCache: Plugin = {
  name: "gram:globs-skip-module-cache",
  configureVitest({ defineCacheKeyGenerator }) {
    defineCacheKeyGenerator(({ sourceCode }) =>
      /\bimport\.meta\.glob\b/.test(sourceCode) ? false : undefined,
    );
  },
};

export default defineProject({
  plugins: [globsSkipModuleCache],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    name: "web",
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.mjs"],
    setupFiles: ["./src/test-setup.ts"],
  },
});
