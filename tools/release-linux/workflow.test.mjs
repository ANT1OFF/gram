// The release workflow's trust rules, read from the file itself so an edit can't drop one quietly:
// only versioned download caches in the build, read-only tokens where repository code runs, and an
// attest job that runs none.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const text = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../.github/workflows/release-linux.yml"),
  "utf8",
);
/** A job's lines, from its key to the next job's. */
const job = (name) => {
  const start = text.indexOf(`\n  ${name}:\n`);
  expect(start).toBeGreaterThan(0);
  const rest = text.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
};
const uses = (block) => [...block.matchAll(/uses: ([^\s@]+)@([0-9a-f]+)/g)].map((m) => m[1]);

describe("release-linux.yml", () => {
  it("grants nothing at the top, and a read-only token to the build and the rebuild", () => {
    expect(text).toMatch(/\npermissions: \{\}\n/);
    expect(job("build")).toMatch(/permissions:\n {6}contents: read\n {4}outputs:/);
    expect(job("sherpa-onnx")).toMatch(/permissions:\n {6}contents: read\n {4}defaults:/);
  });

  it("restores only hash-verifiable archives, never extracted builder toolsets", () => {
    const attest = job("attest");
    expect(uses(attest)).not.toContain("actions/cache");
    expect(attest).not.toMatch(/\n\s+cache:/);
    const build = job("build");
    const caches = build.split(/\n {6}- /).filter((step) => step.includes("uses: actions/cache@"));
    expect(caches).toHaveLength(1);
    const paths = /path: \|\n([^]*?)\n {10}key:/
      .exec(caches[0])[1]
      .trim()
      .split("\n")
      .map((line) => line.trim());
    expect(paths).toEqual([
      "~/.cache/electron",
      "~/.cache/electron-builder/*/*.tar.gz",
      "~/.cache/electron-builder/*/*.7z",
    ]);
    expect(caches[0]).toContain(
      "gram-release-packaging-archives-v2-${{ runner.os }}-${{ runner.arch }}-${{ steps.packaging-cache.outputs.versions }}",
    );
    expect(caches[0]).not.toMatch(/restore-keys:/);
    expect(build).toContain("node tools/packaging/cache.mjs --key");
    expect(build).toContain("node tools/packaging/cache.mjs --seed-checksums");
    expect(build).toMatch(/setup-bun@[0-9a-f]{40}[^\n]*\n {8}with:\n[^]*?no-cache: true/);
    expect(build).toMatch(
      /setup-node@[0-9a-f]{40}[^\n]*\n {8}with:\n[^]*?package-manager-cache: false/,
    );
  });

  it("signs in a job that checks out nothing and runs no repository code", () => {
    const attest = job("attest");
    expect(uses(attest)).toEqual(["actions/download-artifact", "actions/attest-build-provenance"]);
    expect(attest).not.toMatch(/\bbun\b|\bnode\b|tools\//);
    expect(attest).toMatch(
      /permissions:\n {6}contents: read\n {6}id-token: write\n {6}attestations: write\n/,
    );
  });

  it("rebuilds the committed sherpa-onnx beside the build, and attests only once both passed", () => {
    const rebuild = job("sherpa-onnx");
    const at = rebuild.indexOf("tools/sherpa-onnx/build-linux-x64.sh");
    expect(at).toBeGreaterThan(0);
    expect(rebuild.slice(at)).toMatch(/diff <\(ls "\$committed"\)/);
    expect(rebuild.slice(at)).toMatch(/cmp "\$file"/);
    // The same commit as the build, no cache, nothing uploaded.
    expect(uses(rebuild)).toEqual(["actions/checkout"]);
    expect(rebuild).toMatch(/persist-credentials: false/);
    expect(rebuild).not.toMatch(/\bref:/);
    // It runs for the same events as the build, so a PR's dry run exercises it too.
    expect(/\n {4}if: (.*)\n/.exec(rebuild)[1]).toBe(/\n {4}if: (.*)\n/.exec(job("build"))[1]);
    expect(job("build")).not.toContain("build-linux-x64.sh");
    expect(job("attest")).toMatch(/\n {4}needs: \[build, sherpa-onnx\]\n/);
  });

  it("pins every action to a full commit SHA", () => {
    for (const line of text.split("\n").filter((l) => /^\s+(- )?uses: /.test(l)))
      expect(line).toMatch(/@[0-9a-f]{40} # v\d/);
  });
});
