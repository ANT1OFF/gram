import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "server",
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Real-git suites spawn dozens of git processes, which are slow on Windows runners.
    testTimeout: 30_000,
    // Cleanup hooks retry a busy temp tree for up to 20 s (`removeDir`) before leaving it behind.
    hookTimeout: 30_000,
  },
});
