import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "agents",
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Cleanup hooks retry a busy temp tree on Windows for about 11 s before giving up.
    hookTimeout: 30_000,
  },
});
