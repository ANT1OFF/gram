import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "themes",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
