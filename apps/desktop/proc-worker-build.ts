// The server gets a self-contained command worker beside its bundle. Building it separately
// prevents the bundler from hoisting the worker's message listener into the owning process.

import { fileURLToPath } from "node:url";
import { build, type Plugin } from "vite";

import { bundledPackages } from "../../tools/notices/bundled-packages.mjs";
import { shippedBuild, shippedOutput } from "./shipped-code.ts";

/** Emits the macOS command worker beside the server without runtime dependencies. */
export const commandWorkerPlugin = (): Plugin => ({
  name: "gram:command-worker",
  async generateBundle() {
    const result = await build({
      configFile: false,
      logLevel: "error",
      plugins: [bundledPackages("proc-worker")],
      ssr: { noExternal: true },
      build: {
        ssr: true,
        write: false,
        ...shippedBuild,
        rolldownOptions: {
          input: fileURLToPath(new URL("../../packages/git/src/proc-worker.ts", import.meta.url)),
          platform: "node",
          output: { ...shippedOutput, format: "cjs", codeSplitting: false },
        },
      },
    });
    if ("close" in result) throw new Error("command worker build unexpectedly watching");
    for (const bundle of Array.isArray(result) ? result : [result]) {
      for (const chunk of bundle.output) {
        if (chunk.type === "chunk") {
          this.emitFile({ type: "asset", fileName: "proc-worker.js", source: chunk.code });
        }
      }
    }
  },
});
