import { fileURLToPath } from "node:url";

import { bundledPackages } from "../../tools/notices/bundled-packages.mjs";
import { shippedBuild, shippedOutput } from "./shipped-code.ts";
import { captureBuildSource } from "./src/build-source.ts";

import { defineConfig } from "electron-vite";

// Evaluate after electron-vite removes its temporary bundled config, so that file cannot
// make an otherwise clean checkout look dirty to the provenance capture.
export default defineConfig(() => ({
  main: {
    // Each bundle records the packages it carries for the third-party notices; see tools/notices.
    plugins: [bundledPackages("main")],
    define: {
      GRAM_BUILD_SOURCE: JSON.stringify(
        captureBuildSource(fileURLToPath(new URL("../../", import.meta.url))),
      ),
    },
    build: {
      ...shippedBuild,
      rolldownOptions: {
        // The server is built separately (electron.vite.server.config.ts) into out/server.
        input: { index: fileURLToPath(new URL("./src/main/index.ts", import.meta.url)) },
        output: shippedOutput,
      },
    },
  },
  preload: {
    plugins: [bundledPackages("preload")],
    build: {
      ...shippedBuild,
      rolldownOptions: {
        input: { index: fileURLToPath(new URL("./src/preload/index.ts", import.meta.url)) },
        output: shippedOutput,
      },
    },
  },
}));
