// The release workflow's trust rules, read from the file itself so an edit can't drop one quietly:
// no Actions cache in the attested build, read-only tokens where repository code runs, and an
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
  it("grants nothing at the top, and a read-only token to the build", () => {
    expect(text).toMatch(/\npermissions: \{\}\n/);
    expect(job("build")).toMatch(/permissions:\n {6}contents: read\n {4}outputs:/);
  });

  it("restores no cache in the build or the attestation", () => {
    for (const name of ["build", "attest"]) {
      const block = job(name);
      expect(uses(block)).not.toContain("actions/cache");
      expect(block).not.toMatch(/\n\s+cache:/);
    }
    const build = job("build");
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

  it("rebuilds the committed sherpa-onnx and requires the same bytes before installing them", () => {
    const build = job("build");
    const rebuild = build.indexOf("tools/sherpa-onnx/build-linux-x64.sh");
    expect(rebuild).toBeGreaterThan(0);
    expect(build.slice(rebuild)).toMatch(/cmp "\$file"/);
    expect(rebuild).toBeLessThan(build.indexOf("bun install --frozen-lockfile"));
  });

  it("pins every action to a full commit SHA", () => {
    for (const line of text.split("\n").filter((l) => /^\s+(- )?uses: /.test(l)))
      expect(line).toMatch(/@[0-9a-f]{40} # v\d/);
  });
});
