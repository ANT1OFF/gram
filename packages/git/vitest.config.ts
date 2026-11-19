import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "git",
    environment: "node",
    // Git tests never read the host's global or system config (a Mac's `filter.lfs.*` pointing at a
    // git-lfs that isn't installed, for one). Set for the whole worker, so product code the tests
    // spawn inherits it too; `run` in src/test-utils.ts sets the same pair for fixture git.
    env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    include: ["src/**/*.test.ts"],
    testTimeout: 30_000,
    // Cleanup hooks retry a busy temp tree for up to 20 s (`removeDir`) before leaving it behind.
    hookTimeout: 30_000,
  },
});
