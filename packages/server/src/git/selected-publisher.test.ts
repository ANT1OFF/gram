import { describe, expect, it } from "@effect/vitest";
import { ProcLive } from "@gram/git";
import * as Effect from "effect/Effect";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { materializeSelectedPublisher } from "./local-checks.ts";

const run = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: cwd, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } }).trim();
const fixture = (attributes = "", source = "public synthetic source\n", archive = false) => {
  const root = mkdtempSync(path.join(tmpdir(), "gram-selected-publisher-"));
  const repo = path.join(root, "repo"); mkdirSync(repo);
  run(repo, "init", "-q", "--template=");
  writeFileSync(path.join(repo, "source.txt"), source);
  if (attributes) writeFileSync(path.join(repo, ".gitattributes"), attributes);
  run(repo, "add", "--", "source.txt", ...(attributes ? [".gitattributes"] : []));
  if (archive) {
    const admin = "ci/archive/unit-tests/2026-10-03/.gitattributes";
    mkdirSync(path.dirname(path.join(repo, admin)), { recursive: true });
    writeFileSync(path.join(repo, admin), "**/*.archived linguist-generated=true\n");
    run(repo, "add", "--", admin);
    const payload = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: repo, input: "synthetic archived payload", encoding: "utf8" }).trim();
    run(repo, "update-index", "--add", "--cacheinfo", `100644,${payload},ci/archive/unit-tests/2026-10-03/test.rs.archived`);
  }
  const omitted = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: repo, input: "synthetic omitted object", encoding: "utf8" }).trim();
  run(repo, "update-index", "--add", "--cacheinfo", `100644,${omitted},.env.example`);
  run(repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
  const head = run(repo, "rev-parse", "HEAD"), tree = run(repo, "rev-parse", "HEAD^{tree}");
  const entries = run(repo, "ls-tree", "-r", "--full-tree", head).split("\n").map((line) => {
    const [meta, name] = line.split("\t"); const [mode, , oid] = meta!.split(" ");
    return { path: name!, mode: mode!, oid: oid!, selected: name !== ".env.example" && !name!.endsWith("test.rs.archived") };
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const raw = JSON.stringify({ schema: "gram.selected-source/v1", head, base: head, tree, entries });
  const manifest = path.join(root, "selection.json"); writeFileSync(manifest, raw);
  const publisher = path.join(root, "publisher");
  run(repo, "-c", "core.hooksPath=/dev/null", "worktree", "add", "--no-checkout", "--detach", publisher, head);
  run(publisher, "read-tree", head); // Populate only Git index metadata, without checkout.
  return { root, publisher, manifest, head, tree, sha256: createHash("sha256").update(raw).digest("hex") };
};
const materialize = (f: ReturnType<typeof fixture>, sha256 = f.sha256) => Effect.runPromise(
  materializeSelectedPublisher(f.publisher, { manifest: f.manifest, sha256 }, f.head, f.head, f.tree).pipe(Effect.provide(ProcLive)),
);

describe("explicit selected publisher preparation", () => {
  it("prepares selected raw bytes and leaves the omitted synthetic object absent", async () => {
    const f = fixture(); try {
      const result = await materialize(f);
      expect(result.selected).toBe(1);
      expect(readFileSync(path.join(f.publisher, "source.txt"), "utf8")).toBe("public synthetic source\n");
      expect(existsSync(path.join(f.publisher, ".env.example"))).toBe(false);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
  it("admits archive attributes while omitting the synthetic archived payload", async () => {
    const f = fixture("", "public synthetic source\n", true); try {
      const result = await materialize(f);
      expect(result.selected).toBe(2);
      expect(existsSync(path.join(f.publisher, "ci/archive/unit-tests/2026-10-03/.gitattributes"))).toBe(true);
      expect(existsSync(path.join(f.publisher, "ci/archive/unit-tests/2026-10-03/test.rs.archived"))).toBe(false);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
  it("refuses a stale selection before materializing source", async () => {
    const f = fixture(); try {
      await expect(materialize(f, "0".repeat(64))).rejects.toThrow("selected-source manifest identity differs");
      expect(existsSync(path.join(f.publisher, "source.txt"))).toBe(false);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
  it("refuses a changed index before materializing source", async () => {
    const f = fixture(); try {
      run(f.publisher, "update-index", "--force-remove", "source.txt");
      await expect(materialize(f)).rejects.toThrow("publisher index differs from selection");
      expect(existsSync(path.join(f.publisher, "source.txt"))).toBe(false);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
  it("refuses an omitted archive attributes control", async () => {
    const f = fixture("", "public synthetic source\n", true); try {
      const doc = JSON.parse(readFileSync(f.manifest, "utf8"));
      doc.entries.find((row: { path: string }) => row.path.endsWith("/.gitattributes")).selected = false;
      const raw = JSON.stringify(doc); writeFileSync(f.manifest, raw);
      await expect(materialize(f, createHash("sha256").update(raw).digest("hex"))).rejects.toThrow("unsafe selected-source entry");
      expect(existsSync(path.join(f.publisher, "source.txt"))).toBe(false);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
  it("refuses actual graft metadata before materializing source", async () => {
    const f = fixture(); try {
      const common = run(f.publisher, "rev-parse", "--path-format=absolute", "--git-common-dir");
      mkdirSync(path.join(common, "info"), { recursive: true });
      writeFileSync(path.join(common, "info", "grafts"), "# synthetic graft marker\n");
      await expect(materialize(f)).rejects.toThrow("publisher info/grafts forbidden");
      expect(existsSync(path.join(f.publisher, "source.txt"))).toBe(false);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
  it("refuses filter attributes before materializing source", async () => {
    const f = fixture("source.txt filter=unexpected\n"); try {
      await expect(materialize(f)).rejects.toThrow("publisher selected filter attributes are forbidden");
      expect(existsSync(path.join(f.publisher, "source.txt"))).toBe(false);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
  it("refuses transformed selected bytes", async () => {
    const f = fixture("source.txt ident\n", "$Id$\n"); try {
      await expect(materialize(f)).rejects.toThrow("selected-source materialization differs");
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
});
