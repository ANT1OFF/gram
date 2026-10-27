// The CI lane table in packages/git/src/ci-policy.ts names paths by hand; these keep it true to the
// workspace graph and to what the e2e suite, the bundles and the Vitest suite actually read.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { workspaces } from "./affected.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const graph = workspaces(root);
const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
  .split("\0")
  .filter((path) => path !== "");
const sources = tracked.filter((path) => /\.(ts|tsx|mts|mjs|cjs|js)$/.test(path));
const isTest = (path) => /\.test\.(ts|tsx|mjs)$/.test(path);
/** Every module specifier a file names: static and dynamic imports, re-exports, `new URL(…)`. */
const specifiers = (path) =>
  [
    ...readFileSync(join(root, path), "utf8").matchAll(
      /(?:from\s+|import\s*\(\s*|require\s*\(\s*|new URL\(\s*|import\s+)["'`]([^"'`]+)["'`]/g,
    ),
  ].map((match) => match[1]);

const closure = (start) => {
  const reached = new Set(start);
  for (let grew = true; grew;) {
    grew = false;
    for (const ws of graph)
      if (reached.has(ws.dir))
        for (const dir of ws.uses)
          if (!reached.has(dir)) {
            reached.add(dir);
            grew = true;
          }
  }
  return reached;
};

describe("CI lanes", () => {
  it("lets only apps/desktop skip the e2e suite", () => {
    // The specs reach workspaces through apps/web's graph and by relative source imports.
    const specs = sources.filter((path) => path.startsWith("apps/web/e2e/"));
    const imported = specs.flatMap((path) =>
      specifiers(path).flatMap((spec) => {
        const match = /^(?:\.\.\/)+((?:apps|packages)\/[\w-]+)\//.exec(spec);
        return match === null ? [] : [match[1]];
      }),
    );
    const reached = closure(["apps/web", ...imported]);
    expect(graph.map((ws) => ws.dir).filter((dir) => !reached.has(dir))).toEqual(["apps/desktop"]);
    expect(graph.filter((ws) => ws.uses.includes("apps/desktop"))).toEqual([]);
  });

  it("keeps test files out of every source that isn't a test", () => {
    const offenders = sources
      .filter((path) => !isTest(path))
      .filter((path) => specifiers(path).some((spec) => /\.test(\.[a-z]+)?$/.test(spec)));
    expect(offenders).toEqual([]);
  });

  it("keeps the tests-only tools out of the workspaces and their builds", () => {
    const testsOnly =
      /tools\/(release-rc|release-stable|mock-kit|dead-code)\/|tools\/(check-docs|check-public-scaffold|scaffold-boundaries|check-release-please|test-release-please|check-dependency-pins)\.mjs/;
    const offenders = sources
      .filter((path) => /^(apps|packages)\//.test(path) && !isTest(path))
      .filter((path) => specifiers(path).some((spec) => testsOnly.test(spec)));
    expect(offenders).toEqual([]);
  });

  it("keeps the e2e specs out of the Vitest suite", () => {
    const config = readFileSync(join(root, "apps/web/vitest.config.ts"), "utf8");
    expect(config).not.toMatch(/["']e2e/);
  });
});
