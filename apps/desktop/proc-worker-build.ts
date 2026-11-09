// The server gets self-contained bundles beside its own: the command worker, and the worker host
// that runs as its own process. Building each separately keeps the bundler from hoisting their
// entry code into the owning process.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build, type Plugin } from "vite";

import { bundledPackages } from "../../tools/notices/bundled-packages.mjs";
import { shippedBuild, shippedOutput } from "./shipped-code.ts";

/** One CommonJS bundle of `input`, emitted beside the server as `<name>.js`. */
const besideServer = (
  name: string,
  input: URL,
  external: ReadonlyArray<string> = [],
  define: Record<string, string> = {},
): Plugin => ({
  name: `gram:${name}`,
  async generateBundle() {
    const result = await build({
      configFile: false,
      logLevel: "error",
      define,
      plugins: [bundledPackages(name)],
      ssr: { noExternal: true },
      build: {
        ssr: true,
        write: false,
        ...shippedBuild,
        rolldownOptions: {
          input: fileURLToPath(input),
          platform: "node",
          external: [...external],
          output: { ...shippedOutput, format: "cjs", codeSplitting: false },
        },
      },
    });
    if ("close" in result) throw new Error(`${name} build unexpectedly watching`);
    for (const bundle of Array.isArray(result) ? result : [result]) {
      for (const chunk of bundle.output) {
        if (chunk.type === "chunk") {
          this.emitFile({ type: "asset", fileName: `${name}.js`, source: chunk.code });
        }
      }
    }
  },
});

/** Emits the macOS command worker beside the server without runtime dependencies. */
export const commandWorkerPlugin = (): Plugin =>
  besideServer("proc-worker", new URL("../../packages/git/src/proc-worker.ts", import.meta.url));

/**
 * Emits `gram-host`, this machine's worker host as its own process, beside the server. Native
 * addons stay external, as in the server's own bundle.
 */
export const hostProcessPlugin = (): Plugin =>
  besideServer(
    "gram-host",
    new URL("../../packages/server/src/host/main.ts", import.meta.url),
    ["@parcel/watcher", "node-pty"],
    // The release it was built as, for its hello: the main Gram tells a joined machine to update.
    { GRAM_HOST_RELEASE: JSON.stringify(appRelease()) },
  );

/** The app's release, as its package says. */
export const appRelease = (): string => {
  const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
    version?: unknown;
  };
  if (typeof pkg.version !== "string") throw new Error("apps/desktop/package.json has no version");
  return pkg.version;
};
