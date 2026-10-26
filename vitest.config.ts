import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "apps/*/vitest.config.{ts,mts}",
      "packages/*/vitest.config.ts",
      "tools/vitest.config.ts",
    ],
  },
});
