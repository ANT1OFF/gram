import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "git",
    environment: "node",
    include: ["src/**/*.test.ts"],
    testTimeout: 30_000,
    // Cleanup hooks retry a busy temp tree for up to 20 s (`removeDir`) before leaving it behind.
    hookTimeout: 30_000,
  },
});
