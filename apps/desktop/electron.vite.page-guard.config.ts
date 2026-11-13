import { fileURLToPath } from "node:url";

import { defineConfig } from "electron-vite";

import { bundledPackages } from "../../tools/notices/bundled-packages.mjs";
import { shippedBuild, shippedOutput } from "./shipped-code.ts";

// Pinned pages' one preload, the clipboard guard (`@gram/shell` `modules/pages/guard.ts`), gets a
// build of its own: a sandboxed preload loads one file, and in the app preload's build Rolldown
// would hoist a runtime both share into a chunk neither could load. It shares nothing with the
// app's preload, and exposes nothing to the page.
export default defineConfig({
  preload: {
    plugins: [bundledPackages("page-guard")],
    build: {
      ...shippedBuild,
      outDir: "out/page-guard",
      rolldownOptions: {
        input: {
          "page-guard": fileURLToPath(new URL("./src/preload/page-guard.ts", import.meta.url)),
        },
        output: shippedOutput,
      },
    },
  },
});
