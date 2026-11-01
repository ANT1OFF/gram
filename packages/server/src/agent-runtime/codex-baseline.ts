import { CODEX_CLI_VERSION } from "@gram/agents/codex";
import { codexNpmCoordinates, type RuntimeArtifact } from "./gate.ts";

/**
 * Codex's npm platform packages for the version Gram's Codex bindings were generated from,
 * as EXAMPLE's registry served them. They ship inside the signed app, and are the one version the
 * managed runtime may install. Each holds,
 * under `package/vendor/<target>/`, the same files as that release's complete GitHub package: the
 * code-mode host, ripgrep and the resources Codex looks for beside itself.
 */
const release = (
  target: string,
  integrity: string,
  sha256: string,
  size: number,
  publishedAt: string,
): RuntimeArtifact => ({
  agent: "codex",
  version: CODEX_CLI_VERSION,
  target,
  npm: { ...codexNpmCoordinates(CODEX_CLI_VERSION, target)!, integrity },
  sha256,
  size,
  publishedAt,
  artifactUpdatedAt: publishedAt,
  source: "bundled",
});

export const CODEX_BASELINE: ReadonlyArray<RuntimeArtifact> = [
  release(
    "aarch64-apple-darwin",
    "sha512-5fWH6qqUInACcRADIewjlnRxDb4QLe0uriwehiZz0+viuAAB8I+WWefqw4xwHvyKaxeiGX4uK56+vrgfvFk3FQ==",
    "181d2eda8addbeca0b689c996df207293947928bdd9c88a097837ae1c7e69ca5",
    147_077_955,
    "2026-10-29T19:58:59.115Z",
  ),
  release(
    "x86_64-apple-darwin",
    "sha512-Vj5wXJPizKmrzNtnRNQf9PP6FJkG3iJU/UO3NE4WvkENZGoQfmImdwf4MVRI5NgwjSuC6LT0HbBRHPVVnwGHuw==",
    "588aad29a4779badc894daeb2e43757ed01d213366fd931fd9a5ec47f7e31e14",
    156_633_428,
    "2026-10-29T19:56:08.466Z",
  ),
  release(
    "x86_64-pc-windows-msvc",
    "sha512-NS8Ps5oG5r19pCrMCUXwUqOui6odnUIoBlQkrjCJ+h1k6KiwCzC/+mI9d3nSZCqFoVONPBTmqyq8NYq3YaFGyA==",
    "47d74aed875a3c01315f042152329ae09b0bd9d26a3285802d1c85aeadce083e",
    180_706_795,
    "2026-10-29T20:01:08.677Z",
  ),
  release(
    "aarch64-pc-windows-msvc",
    "sha512-LWO1cyGlxbKgeUM7QJ1a6QMSsJi++3PqgIi6BmIUBoj/kzZqRIR69UDMQgeU/9izzJFYMSbwt++lHnUFyjQXlA==",
    "0af3dbf9675d199026e75d0c01ccbd231ece959ec0ff8207a5db8b4d625e0d00",
    168_971_160,
    "2026-10-29T20:15:15.847Z",
  ),
];
