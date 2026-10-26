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
    "sha512-6Znu97O7+Ie/cnUpsWLx6NlcPc7DNuj6sAs58xpt0/tKRgx4+xgE9zca1YrwqQUBjUQO1HexudyimmhpZjdWlA==",
    "93121cae6c2fe77cdb20f88f611783dbec77a3e241948ad018da120480a6f296",
    134_323_627,
    "2026-10-05T18:39:16.824Z",
  ),
  release(
    "x86_64-apple-darwin",
    "sha512-Q33hmY6BxhoQRgCo4f/xS20yMxORnilQMNdr5w1bXSkXGYAty8/z9odcHbsNYUM6m0fNle12DHLQ5F0Dpfji3A==",
    "9b45ea7cd6521280ee5be3e853499ac75301bdceb776a3ecec6b9660114cb5a3",
    143_424_230,
    "2026-10-05T18:36:58.946Z",
  ),
  release(
    "x86_64-pc-windows-msvc",
    "sha512-yyqykHtHNhm0ZViofGozz9a4ffUyXDsiyRu9Q2hPNg/cu4uzSsovNr5kDmzBXPFWAilmlZuNkwpw1W7uae2nlg==",
    "34371566f3b0688ed5de49f135c02008982399d58a9553f5764b948f041730a0",
    162_641_414,
    "2026-10-05T18:36:42.090Z",
  ),
  release(
    "aarch64-pc-windows-msvc",
    "sha512-PCGz2kVUBKKzyKv/cqo/1WqWN8GVUyk9sk0LyWIyXftdU0t+SSsGp45c2I6iOitm88ftGB3LxFHpTMnaiIKU7w==",
    "114441075ada4c1fcd74884acd63ddd7978243bc6956f9208b9a7d4fa9ab3710",
    151_954_386,
    "2026-10-05T18:38:04.384Z",
  ),
];
