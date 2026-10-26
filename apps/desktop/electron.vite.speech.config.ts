import { createRequire } from "node:module";

import { defineConfig } from "electron-vite";

import { bundledPackages } from "../../tools/notices/bundled-packages.mjs";
import { shippedBuild, shippedOutput } from "./shipped-code.ts";

// The speech process runs in a utilityProcess of its own, so it gets its own build, for the reason
// the server has one (electron.vite.server.config.ts): one build per process keeps Rolldown from
// hoisting another process's code into its bundle.
export default defineConfig({
  main: {
    plugins: [bundledPackages("speech")],
    build: {
      ...shippedBuild,
      outDir: "out/speech",
      // The native addon loads from node_modules at runtime, next to its platform package.
      externalizeDeps: { include: ["sherpa-onnx-node"] },
      rolldownOptions: {
        output: shippedOutput,
        // The process's code is the shell package's; the bundle, and the addon beside it, are ours.
        input: {
          speech: createRequire(import.meta.url).resolve("@gram/shell/speech-process/main"),
        },
      },
    },
  },
});
