import * as fs from "node:fs";
import * as nodePath from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  isExcluded,
  mergeSelectedIntoRoot,
  newRules,
  readPermissionRules,
  ruleCommand,
  seedWorktreePermissions,
  settingsPath,
  unionInto,
} from "./claude-settings.ts";
import { removeDir, tempDir, write } from "./test-utils.ts";

const allow = (...rules: Array<string>) => ({ allow: rules, deny: [], ask: [] });

describe("claude settings", () => {
  const dirs: Array<string> = [];
  const tmp = () => {
    const dir = tempDir();
    dirs.push(dir);
    return dir;
  };
  const linked = () => {
    const root = tmp();
    const repo = nodePath.join(root, "repo");
    const wt = nodePath.join(root, "wt");
    const outside = nodePath.join(root, "outside");
    for (const dir of [repo, wt, outside]) fs.mkdirSync(dir);
    return { repo, wt, outside };
  };

  afterEach(() => {
    for (const dir of dirs.splice(0)) removeDir(dir);
  });

  it("excludes outward-facing rules at a command boundary only", () => {
    expect(isExcluded("Bash(git push)")).toBe(true);
    expect(isExcluded("Bash(git push origin main)")).toBe(true);
    expect(isExcluded("Bash(git push:*)")).toBe(true);
    expect(isExcluded("PowerShell(gh pr create --fill)")).toBe(true);
    expect(isExcluded("Bash(gh pr review 12)")).toBe(true);
    expect(isExcluded("Bash(gh   PR   Merge 7)")).toBe(true);
    expect(isExcluded("Bash(gh release create v1)")).toBe(true);
    expect(isExcluded("Bash(git pushx)")).toBe(false);
    expect(isExcluded("Bash(git status)")).toBe(false);
    expect(isExcluded("Bash(gh issue list)")).toBe(false);
    expect(isExcluded("PowerShell(cargo fmt *)")).toBe(false);
  });

  it("strips the tool wrapper and normalises whitespace", () => {
    expect(ruleCommand("Bash(git   push   -f)")).toBe("git push -f");
    expect(ruleCommand("PowerShell(Cargo Fmt)")).toBe("cargo fmt");
    expect(ruleCommand("no-parens-rule")).toBe("no-parens-rule");
  });

  it("unions add-only, dedupes, and preserves other keys", () => {
    const base = { permissions: { allow: ["Bash(a)", "Bash(b)"] }, env: { FOO: "1" } };
    const merged = unionInto(base, allow("Bash(b)", "Bash(c)"));
    expect(merged["permissions"]).toEqual({ allow: ["Bash(a)", "Bash(b)", "Bash(c)"] });
    expect(merged["env"]).toEqual({ FOO: "1" });
  });

  it("drops excluded rules and keeps non-string entries", () => {
    expect(unionInto({}, allow("Bash(git push)", "Bash(npm test)"))["permissions"]).toEqual({
      allow: ["Bash(npm test)"],
    });
    const merged = unionInto(
      { permissions: { allow: ["Bash(a)", { custom: true }] } },
      allow("Bash(b)"),
    );
    expect(merged["permissions"]).toEqual({ allow: ["Bash(a)", { custom: true }, "Bash(b)"] });
  });

  it("offers worktree rules minus root minus excluded", () => {
    expect(newRules(allow("Bash(a)", "Bash(b)", "Bash(git push)"), allow("Bash(a)"))).toEqual([
      "Bash(b)",
    ]);
  });

  it.effect("seeds a filtered file when the worktree has none", () =>
    Effect.gen(function* () {
      const root = tmp();
      const repo = nodePath.join(root, "repo");
      const wt = nodePath.join(root, "wt");
      write(
        settingsPath(repo),
        JSON.stringify({ permissions: { allow: ["Bash(npm test)", "Bash(git push)"] } }),
      );
      fs.mkdirSync(wt);
      yield* seedWorktreePermissions(repo, wt);
      expect(readPermissionRules(wt).allow).toEqual(["Bash(npm test)"]);
    }),
  );

  it.effect("seeds without clobbering an existing worktree file", () =>
    Effect.gen(function* () {
      const root = tmp();
      const repo = nodePath.join(root, "repo");
      const wt = nodePath.join(root, "wt");
      write(settingsPath(repo), JSON.stringify({ permissions: { allow: ["Bash(root-rule)"] } }));
      write(
        settingsPath(wt),
        JSON.stringify({ permissions: { allow: ["Bash(wt-rule)"] }, env: { X: "1" } }),
      );
      yield* seedWorktreePermissions(repo, wt);
      const parsed = JSON.parse(fs.readFileSync(settingsPath(wt), "utf8"));
      expect(parsed.permissions.allow).toEqual(["Bash(wt-rule)", "Bash(root-rule)"]);
      expect(parsed.env).toEqual({ X: "1" });
    }),
  );

  it.effect("is a no-op without a root file", () =>
    Effect.gen(function* () {
      const root = tmp();
      yield* seedWorktreePermissions(nodePath.join(root, "repo"), root);
      expect(fs.existsSync(settingsPath(root))).toBe(false);
    }),
  );

  it.effect("merges only selected, non-excluded rules back, even when raced", () =>
    Effect.gen(function* () {
      const repo = tmp();
      write(settingsPath(repo), JSON.stringify({ permissions: { allow: ["Bash(existing)"] } }));
      const worktree = allow("Bash(picked)", "Bash(skipped)", "Bash(git push)", "Bash(other)");
      yield* Effect.all(
        [
          mergeSelectedIntoRoot(repo, worktree, ["Bash(picked)", "Bash(git push)"]),
          mergeSelectedIntoRoot(repo, worktree, ["Bash(other)"]),
        ],
        { concurrency: "unbounded" },
      );
      expect([...readPermissionRules(repo).allow].toSorted()).toEqual([
        "Bash(existing)",
        "Bash(other)",
        "Bash(picked)",
      ]);
    }),
  );

  // A symlink on Windows needs a privilege CI doesn't have.
  describe.skipIf(process.platform === "win32")("a .claude the branch made a symlink", () => {
    it.effect("seeding doesn't write through it", () =>
      Effect.gen(function* () {
        const { repo, wt, outside } = linked();
        write(settingsPath(repo), JSON.stringify({ permissions: { allow: ["Bash(npm test)"] } }));
        fs.symlinkSync(outside, nodePath.join(wt, ".claude"));
        yield* seedWorktreePermissions(repo, wt);
        expect(fs.readdirSync(outside)).toEqual([]);
      }),
    );

    it.effect("seeding doesn't read the root's through it", () =>
      Effect.gen(function* () {
        const { repo, wt, outside } = linked();
        write(
          nodePath.join(outside, "settings.local.json"),
          JSON.stringify({ permissions: { allow: ["Bash(elsewhere)"] } }),
        );
        fs.symlinkSync(outside, nodePath.join(repo, ".claude"));
        yield* seedWorktreePermissions(repo, wt);
        expect(fs.existsSync(settingsPath(wt))).toBe(false);
        expect(readPermissionRules(repo)).toEqual({ allow: [], deny: [], ask: [] });
      }),
    );

    it.effect("merging back doesn't write through the root's", () =>
      Effect.gen(function* () {
        const { repo, outside } = linked();
        const external = nodePath.join(outside, "settings.local.json");
        write(external, JSON.stringify({ permissions: { allow: ["Bash(existing)"] } }));
        fs.symlinkSync(outside, nodePath.join(repo, ".claude"));
        yield* mergeSelectedIntoRoot(repo, allow("Bash(picked)"), ["Bash(picked)"]);
        expect(JSON.parse(fs.readFileSync(external, "utf8"))).toEqual({
          permissions: { allow: ["Bash(existing)"] },
        });
      }),
    );

    it.effect("a settings file that is itself a symlink is neither read nor written through", () =>
      Effect.gen(function* () {
        const { repo, wt, outside } = linked();
        const external = nodePath.join(outside, "settings.local.json");
        write(external, JSON.stringify({ permissions: { allow: ["Bash(elsewhere)"] } }));
        write(settingsPath(repo), JSON.stringify({ permissions: { allow: ["Bash(npm test)"] } }));
        fs.mkdirSync(nodePath.join(wt, ".claude"));
        fs.symlinkSync(external, settingsPath(wt));
        yield* seedWorktreePermissions(repo, wt);
        expect(readPermissionRules(wt)).toEqual({ allow: [], deny: [], ask: [] });
        expect(fs.lstatSync(settingsPath(wt)).isSymbolicLink()).toBe(true);
        expect(JSON.parse(fs.readFileSync(external, "utf8"))).toEqual({
          permissions: { allow: ["Bash(elsewhere)"] },
        });
      }),
    );
  });
});
