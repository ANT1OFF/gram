import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { affected, workspaces } from "./affected.mjs";

const graph = workspaces(fileURLToPath(new URL("../../", import.meta.url)));

describe("affected projects", () => {
  it("reads the workspace graph from manifests and project references", () => {
    const server = graph.find((ws) => ws.dir === "packages/server");
    expect(server?.uses).toEqual(
      expect.arrayContaining(["packages/agents", "packages/contracts", "packages/git"]),
    );
    // apps/web references packages/shell in its tsconfig without a manifest dependency.
    expect(graph.find((ws) => ws.dir === "apps/web")?.uses).toContain("packages/shell");
  });

  it("runs a changed workspace and every workspace that depends on it", () => {
    expect(affected(["apps/web/src/a.tsx"], graph)).toMatchObject({
      all: false,
      projects: ["web"],
    });
    expect(affected(["packages/server/src/a.ts"], graph).projects.toSorted()).toEqual([
      "desktop",
      "server",
    ]);
    const contracts = affected(["packages/contracts/src/a.ts"], graph).projects;
    expect(contracts).toEqual(
      expect.arrayContaining(["web", "server", "agents", "git", "desktop"]),
    );
    expect(contracts).not.toContain("themes");
  });

  it("runs only the tools project for tool sources and nothing for prose", () => {
    expect(affected(["tools/release-rc/rc.mjs"], graph).projects).toEqual(["tools"]);
    expect(
      affected(["docs/VERIFICATION.md", ".github/workflows/check.yml"], graph).projects,
    ).toEqual([]);
  });

  it("runs everything for shared root files and for sources outside every workspace", () => {
    for (const path of ["bun.lock", "package.json", "tsconfig.base.json", "patches/x.patch"])
      expect(affected([path], graph)).toMatchObject({ all: true });
    expect(affected(["scripts/new-root-script.mjs"], graph)).toMatchObject({ all: true });
    expect(affected(["tools/check/run.mjs"], graph)).toMatchObject({ all: true });
  });
});
