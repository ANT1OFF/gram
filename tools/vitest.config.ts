import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "tools",
    environment: "node",
    include: [
      "oxlint/*.test.mjs",
      "release-rc/*.test.mjs",
      "release-stable/*.test.mjs",
      "mock-kit/*.test.mjs",
      "check/*.test.mjs",
      "notices/*.test.mjs",
      "sherpa-onnx/*.test.mjs",
    ],
  },
});
