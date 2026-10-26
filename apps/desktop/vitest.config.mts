import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "desktop",
    environment: "node",
    include: ["src/**/*.test.ts", "build/**/*.test.mjs"],
  },
});
