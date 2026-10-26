import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { defineConfig } from "electron-vite";
import { bundledPackages } from "../../tools/notices/bundled-packages.mjs";
import { commandWorkerPlugin } from "./proc-worker-build.ts";
import { shippedBuild, shippedOutput } from "./shipped-code.ts";

// The server runs in a utilityProcess, so it gets its own build. Sharing one build with main let
// Rolldown hoist shared runtime code into the server bundle, and main then ran the server on load.
const serverRequire = createRequire(new URL("../../packages/server/package.json", import.meta.url));

export default defineConfig({
  main: {
    plugins: [
      commandWorkerPlugin(),
      bundledPackages("server"),
      {
        // The terminal emulator is WebAssembly the server reads from disk. Unbundled it comes out of
        // the `ghostty-web` package; a packaged app has no such package, so it ships beside the
        // bundle, where `plain-text.ts` looks next.
        name: "gram:ghostty-wasm",
        generateBundle() {
          this.emitFile({
            type: "asset",
            fileName: "ghostty-vt.wasm",
            // Names the source, so the notices count ghostty-web among the server's packages.
            originalFileName: serverRequire.resolve("ghostty-web/ghostty-vt.wasm"),
            source: readFileSync(serverRequire.resolve("ghostty-web/ghostty-vt.wasm")),
          });
        },
      },
    ],
    build: {
      ...shippedBuild,
      outDir: "out/server",
      // Native addons load from node_modules at runtime, next to their platform binaries.
      // `@parcel/watcher` isn't packaged: only Linux dev imports it lazily, so it must stay external
      // rather than be bundled from `@gram/git`'s node_modules.
      externalizeDeps: { include: ["@parcel/watcher", "node-pty"] },
      rolldownOptions: {
        output: shippedOutput,
        input: {
          server: fileURLToPath(new URL("../../packages/server/src/main.ts", import.meta.url)),
        },
      },
    },
  },
});
