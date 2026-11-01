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
    "sha512-pDizgOUAtq3/k3AbUFHbaU19WpYKCja+oFpNSTLKrDQj4lTUNSDuTPJip4uQVn2/1EipQdpQrGMOQBVuI1znAA==",
    "9b5a35be1975ceb332eaf274032f375b017ab644ff0165737ead03277fae77cd",
    140_709_294,
    "2026-10-23T04:58:04.632Z",
  ),
  release(
    "x86_64-apple-darwin",
    "sha512-lIe+udnguPGzBezkgbkj2Eaz0YqOhNXT7jja136Fj0sXfI+UKNS2icmaK14GcoRAgeVEpDTtC1ftamWBPmD1zg==",
    "77b69304fe4be92cf52aeb6f0493bf60ed01147e215184d79d74a8b996293c29",
    149_402_773,
    "2026-10-23T04:55:36.822Z",
  ),
  release(
    "x86_64-pc-windows-msvc",
    "sha512-urWPhwh9YavuoAPIkmVYKBTtd5OtGVL4Ki0Fb28dhK/Mz6Pt4LSy+gbRrZFz5+RXrw9ubvXuXDCcd8beYcWhDg==",
    "4fbd23473a2fc223396cdd8490d3f658d368438134c12a3f1dac9d1e2041a65b",
    172_854_349,
    "2026-10-23T04:55:52.547Z",
  ),
  release(
    "aarch64-pc-windows-msvc",
    "sha512-Zkzt8HNmB/vOnlDo5D7IOlrt5rHaxYQB7iGbNP7bHcXZtrk6gaD7UriwaieGYJpcf8DqAT/0tqzY4xbs8ZwbmQ==",
    "5b8f542ad5396f306a73b765ff157f9bbc229cdde488930efeca2859eeec9a6d",
    161_368_651,
    "2026-10-23T04:56:16.399Z",
  ),
];
