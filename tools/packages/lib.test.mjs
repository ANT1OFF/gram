import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  BINS,
  builtEntry,
  canaryVersion,
  dependencySpec,
  distTag,
  hostManifest,
  publishedName,
  publishManifest,
  PUBLISHED,
  publishOrder,
  releaseVersion,
  sourceKind,
} from "./lib.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const json = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
const workspace = json("package.json");
const catalog = workspace.workspaces.catalog;
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const manifests = Object.fromEntries(
  PUBLISHED.map((folder) => [folder, json(`packages/${folder}/package.json`)]),
);
const published = Object.values(manifests).map((manifest) => manifest.name);
const manifestOf = (folder, scope = "@owner", version = "1.2.4-canary.20260102030405.g012345678") =>
  publishManifest({
    manifest: manifests[folder],
    folder,
    catalog,
    published,
    version,
    scope,
    repository: "owner/gram",
    commit: COMMIT,
    engines: { node: ">=26" },
    built: { typescript: catalog.typescript, node: "26.0.0" },
  });

describe("versions", () => {
  it("numbers a canary after the release it follows, by commit time then hash", () => {
    const version = canaryVersion({
      base: "1.2.3",
      committedAt: "2026-01-02T04:04:05+01:00",
      commit: COMMIT,
    });
    expect(version).toBe("1.2.4-canary.20260102030405.g012345678");
    // Valid semver: no numeric part with a leading zero, which a bare hash could be.
    expect(version).toMatch(/^\d+\.\d+\.\d+-canary\.[1-9]\d{13}\.g[0-9a-f]{9}$/);
  });

  it("refuses a canary of a prerelease, a short hash or a time that isn't one", () => {
    const good = { base: "1.2.3", committedAt: "2026-01-02T03:04:05Z", commit: COMMIT };
    expect(() => canaryVersion({ ...good, base: "1.2.3-rc.1" })).toThrow(/plain release/);
    expect(() => canaryVersion({ ...good, commit: "0123456" })).toThrow(/full commit/);
    expect(() => canaryVersion({ ...good, committedAt: "yesterday" })).toThrow(/commit time/);
  });

  it("releases only the version the tag names", () => {
    expect(releaseVersion({ base: "1.2.3", tag: "v1.2.3" })).toBe("1.2.3");
    expect(() => releaseVersion({ base: "1.2.3", tag: "v1.2.4" })).toThrow(/doesn't name/);
    expect(() => releaseVersion({ base: "1.2.3-rc.1", tag: "v1.2.3-rc.1" })).toThrow();
  });

  it("tags canaries `canary` and releases `latest`, and never the other way", () => {
    expect(distTag({ version: "1.2.4-canary.1.gabc", canary: true })).toBe("canary");
    expect(distTag({ version: "1.2.3", canary: false })).toBe("latest");
    expect(() => distTag({ version: "1.2.3", canary: true })).toThrow();
    expect(() => distTag({ version: "1.2.4-canary.1.gabc", canary: false })).toThrow();
  });
});

describe("names", () => {
  it("keeps the workspace name in its own scope and prefixes it in any other", () => {
    expect(publishedName("@gram/contracts", "@gram")).toBe("@gram/contracts");
    expect(publishedName("@gram/contracts", "@owner")).toBe("@owner/gram-contracts");
    expect(() => publishedName("@gram/contracts", "Owner")).toThrow(/scope/);
    expect(() => publishedName("contracts", "@owner")).toThrow(/workspace package/);
  });

  it("aliases a renamed package back to the name the imports use", () => {
    expect(dependencySpec("@gram/git", "@gram", "1.2.3")).toBe("1.2.3");
    expect(dependencySpec("@gram/git", "@owner", "1.2.3")).toBe("npm:@owner/gram-git@1.2.3");
  });

  it("orders packages after their dependencies", () => {
    const packages = ["server", "contracts", "agents"].map((folder) => ({ folder }));
    expect(publishOrder(packages).map((entry) => entry.folder)).toEqual([
      "contracts",
      "agents",
      "server",
    ]);
    expect(() => publishOrder([{ folder: "shell" }])).toThrow();
  });
});

describe("published manifests", () => {
  it("lists every published package after the ones it depends on", () => {
    for (const [index, folder] of PUBLISHED.entries()) {
      for (const [name, spec] of Object.entries(manifests[folder].dependencies ?? {})) {
        if (!spec.startsWith("workspace:")) continue;
        expect(published.indexOf(name), `${folder} uses ${name}`).toBeGreaterThanOrEqual(0);
        expect(published.indexOf(name), `${folder} uses ${name}`).toBeLessThan(index);
      }
    }
  });

  it("leaves no workspace or catalog specifier, and no range", () => {
    for (const folder of PUBLISHED) {
      const manifest = manifestOf(folder);
      const specs = Object.entries({ ...manifest.dependencies, ...manifest.peerDependencies });
      for (const [name, spec] of specs) {
        expect(spec, `${folder}: ${name}`).toMatch(
          /^(npm:@owner\/gram-[a-z]+@)?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/,
        );
      }
      expect(manifest).not.toHaveProperty("private");
      expect(manifest).not.toHaveProperty("devDependencies");
      expect(manifest).not.toHaveProperty("scripts");
    }
  });

  it("makes Effect an exact peer and pins the platform's shared half beside it", () => {
    const git = manifestOf("git");
    expect(git.peerDependencies).toEqual({ effect: catalog.effect });
    expect(git.dependencies).not.toHaveProperty("effect");
    expect(git.dependencies["@effect/platform-node"]).toBe(catalog.effect);
    expect(git.dependencies["@effect/platform-node-shared"]).toBe(catalog.effect);
    expect(manifestOf("themes")).not.toHaveProperty("peerDependencies");
  });

  it("points every export at built files, types first", () => {
    for (const folder of PUBLISHED) {
      const manifest = manifestOf(folder);
      expect(Object.keys(manifest.exports)).toEqual(Object.keys(manifests[folder].exports));
      for (const entry of Object.values(manifest.exports)) {
        expect(Object.keys(entry)).toEqual(["types", "default"]);
        expect(entry.types).toMatch(/^\.\/dist\/.+\.d\.ts$/);
        expect(entry.default).toMatch(/^\.\/dist\/.+\.js$/);
      }
    }
    expect(builtEntry("./src/entries/core.ts")).toEqual({
      types: "./dist/entries/core.d.ts",
      default: "./dist/entries/core.js",
    });
    expect(() => builtEntry("./lib/core.js")).toThrow();
  });

  it("depends on its siblings at its own version, under the workspace names", () => {
    const server = manifestOf("server", "@owner", "1.2.3");
    expect(server.name).toBe("@owner/gram-server");
    expect(server.dependencies["@gram/contracts"]).toBe("npm:@owner/gram-contracts@1.2.3");
    expect(manifestOf("server", "@gram", "1.2.3").dependencies["@gram/contracts"]).toBe("1.2.3");
    expect(server.repository).toEqual({
      type: "git",
      url: "git+https://github.com/owner/gram.git",
      directory: "packages/server",
    });
    expect(server.gram.commit).toBe(COMMIT);
  });

  it("installs the server and host commands from sources that exist", () => {
    expect(manifestOf("server").bin).toEqual({
      "gram-server": "./bin/gram-server.mjs",
      "gram-host": "./bin/gram-host.mjs",
    });
    expect(manifestOf("server").files).toEqual(["dist", "bin"]);
    for (const [folder, bins] of Object.entries(BINS)) {
      const sources = readdirSync(join(root, "packages", folder, "src"), { recursive: true });
      for (const target of Object.values(bins)) {
        expect(sources).toContain(target.replace("./dist/", "").replace(/\.js$/, ".ts"));
      }
    }
  });

  it("refuses a dependency on a workspace package that isn't published", () => {
    expect(() =>
      publishManifest({
        manifest: { ...manifests.git, dependencies: { "@gram/shell": "workspace:*" } },
        folder: "git",
        catalog,
        published,
        version: "1.2.3",
        scope: "@owner",
        repository: "owner/gram",
        commit: COMMIT,
        engines: {},
        built: {},
      }),
    ).toThrow(/isn't published/);
  });
});

describe("files", () => {
  it("builds TypeScript, copies what code reads beside itself, and skips tests", () => {
    expect(sourceKind("host/main.ts")).toBe("built");
    expect(sourceKind("recommended/table.json")).toBe("copied");
    expect(sourceKind("host/main.test.ts")).toBe("skipped");
    expect(sourceKind("claude/__snapshots__/a.snap")).toBe("skipped");
  });
});

describe("the standalone host", () => {
  it("names only the native modules, at the workspace's exact pins", () => {
    const manifest = hostManifest({
      version: "1.2.3",
      engines: { node: ">=26" },
      catalog,
      manifests: [manifests.git, manifests.server],
    });
    expect(manifest.dependencies).toEqual({
      "@parcel/watcher": manifests.git.dependencies["@parcel/watcher"],
      "node-pty": catalog["node-pty"],
    });
    expect(manifest.private).toBe(true);
  });
});
