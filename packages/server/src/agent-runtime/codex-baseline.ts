import { CODEX_CLI_VERSION } from "@gram/agents/codex";
import { codexNpmCoordinates, type RuntimeArtifact } from "./gate.ts";

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
    "sha512-sQyOGJabAUTEWCKe1O6GNsE7NKnHCHSjzLrazfYUgw8OFsFDeAQGVEwzvpXTK1yW1hJiLLAMRzC/W2Vu7m9DwQ==",
    "ab7ba154261db88eef760dfe69978fbb67018c2e1200ff536dc8c51ed9c758b5",
    154_915_137,
    "2026-11-18T03:50:42.798Z",
  ),
  release(
    "x86_64-apple-darwin",
    "sha512-lniwntVB9YaCQNNaTgpLxVvABkrnZDCO/UZf3z7POwH71ikkVNi7NxBrfl6aSIS9b3UBJKxjPlAm3qeIxINJVg==",
    "7f419a43d2506d6c7caf1b70eedcdd57967f3544085f51b3e888e6983acbf9c2",
    165_132_536,
    "2026-11-18T03:53:20.390Z",
  ),
  release(
    "x86_64-pc-windows-msvc",
    "sha512-eNlCGvSTKMegqo1R0PPfAf0jOQp8OGfWH8WX2UyTtRN6E/YOecJnz4n1X9lIb02O8Zda/Lv6/WST7+8mufTVSw==",
    "49eedd5e5e1c828b0cfcdde97f19d83528d8fda4eafef3b02cc770da218b6da3",
    188_506_732,
    "2026-11-18T03:56:09.799Z",
  ),
  release(
    "aarch64-pc-windows-msvc",
    "sha512-VSfDt/Y/RYqeT+9gCwmIO1kEj7bF7RYQdhanhMWQqWpZBdPLrF19z2z8JbL+Gt/amE7A1d/Rt2g/p44DLrDhFg==",
    "d4cac38151ecca6372d6a6ec8612f52fe7011e00a9da37527bc884e79eb3ef0e",
    176_793_730,
    "2026-11-18T03:51:01.860Z",
  ),
];
