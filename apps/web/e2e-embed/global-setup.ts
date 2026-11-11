import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { build, preview } from "vite";

const webDir = fileURLToPath(new URL("..", import.meta.url));
const fixtureConfig = fileURLToPath(new URL("./fixture/vite.config.ts", import.meta.url));

/**
 * Builds the package as it ships (`scripts/build-embed.mjs`), then a separate app that consumes
 * only that build, and serves the app on a free loopback port. `GRAM_EMBED_E2E_SKIP_BUILD=1`
 * reuses the package already in `dist-embed`, for a spec being written.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  if (process.env["GRAM_EMBED_E2E_SKIP_BUILD"] !== "1") {
    const built = spawnSync(process.execPath, ["scripts/build-embed.mjs"], {
      cwd: webDir,
      stdio: "inherit",
    });
    if (built.status !== 0) throw new Error("the embeddable package failed to build");
  }
  await build({ configFile: fixtureConfig, logLevel: "warn" });
  const server = await preview({
    configFile: fixtureConfig,
    logLevel: "warn",
    preview: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  const address = server.httpServer.address();
  if (address === null || typeof address === "string")
    throw new Error("the fixture app's server has no port");
  process.env["GRAM_EMBED_E2E_ORIGIN"] = `http://127.0.0.1:${address.port}`;
  return async () => {
    await server.close();
  };
}
