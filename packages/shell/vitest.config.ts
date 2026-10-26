import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "shell",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
