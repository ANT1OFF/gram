import { fileURLToPath } from "node:url";

import { defineConfig } from "electron-vite";

import { bundledPackages } from "../../tools/notices/bundled-packages.mjs";
import { shippedBuild, shippedOutput } from "./shipped-code.ts";

// A hosted site window's one preload (`@gram/shell` `modules/device/site-preload.ts`) gets a
// build of its own, as the pinned pages' guard does: a sandboxed preload loads one file. It
// shares nothing with the app's preload, and gives the page one call, `window.gramHostedSite`.
export default defineConfig({
  preload: {
    plugins: [bundledPackages("hosted-site")],
    build: {
      ...shippedBuild,
      outDir: "out/hosted-site",
      rolldownOptions: {
        input: {
          "hosted-site": fileURLToPath(new URL("./src/preload/hosted-site.ts", import.meta.url)),
        },
        output: shippedOutput,
      },
    },
  },
});
