// The packages workflow's publishing rules, read from the file itself so an edit can't drop one
// quietly: only main and releases publish, the switch stops both, and the token that
// writes packages never meets an install.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const text = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../.github/workflows/packages.yml"),
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

describe("packages.yml", () => {
  it("publishes only from main or a published release, and not with the switch off", () => {
    expect(text).toContain(
      "PUBLISHING: ${{ vars.GRAM_PUBLISH_PACKAGES != 'false' && (github.event_name == 'release' || (github.event_name == 'push' && github.ref == 'refs/heads/main')) }}",
    );
    expect(text).toMatch(
      /\n {2}push:\n {4}# [^\n]+\n {4}branches: \[main, "integration\/\*\*"\]\n/,
    );
    expect(text).toMatch(/\n {2}release:\n {4}types: \[published\]\n/);
    for (const name of ["publish", "manifest"]) {
      expect(job(name)).toMatch(/\n {4}if: needs\.pack\.outputs\.publishing == 'true'\n/);
    }
    expect(job("image")).toMatch(
      /- name: Push\n {8}if: needs\.pack\.outputs\.publishing == 'true'\n/,
    );
    // Every upload sits behind one of those conditions.
    expect(
      text.match(/docker push|imagetools create|publish\.mjs --registry "\$REGISTRY"/g),
    ).toEqual([
      'publish.mjs --registry "$REGISTRY"',
      'publish.mjs --registry "$REGISTRY"',
      'publish.mjs --registry "$REGISTRY"',
      "docker push",
      "imagetools create",
    ]);
    expect(job("pack")).toContain('publish.mjs --registry "$REGISTRY" --dry-run');
  });

  it("grants nothing at the top and no write to the job that installs", () => {
    expect(text).toMatch(/\npermissions: \{\}\n/);
    expect(job("pack")).toMatch(/permissions:\n {6}contents: read\n {4}outputs:/);
    expect(job("pack")).toContain("bun install --frozen-lockfile");
  });

  it("writes packages from a job that installs nothing", () => {
    const publish = job("publish");
    expect(publish).toMatch(/packages: write/);
    expect(publish).not.toMatch(/bun |npm install|npm ci|setup-bun/);
    expect(publish).not.toMatch(/uses: actions\/cache@/);
  });

  it("pins every action to a commit and never keeps the checkout's token", () => {
    const uses = [...text.matchAll(/uses: (\S+)/g)].map((match) => match[1]);
    expect(uses.length).toBeGreaterThan(0);
    for (const action of uses) expect(action).toMatch(/^[\w-]+\/[\w-]+@[0-9a-f]{40}$/);
    const checkouts = text.split("uses: actions/checkout@").slice(1);
    for (const checkout of checkouts)
      expect(checkout).toMatch(/^\S+ # \S+\n\s+with:\n\s+persist-credentials: false/);
  });

  it("splices no event value into a script", () => {
    const scripts = [...text.matchAll(/run: \|\n((?: {10}.*\n|\n)+)/g)].map((match) => match[1]);
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) expect(script).not.toContain("${{");
  });
});
