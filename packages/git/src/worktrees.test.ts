import * as fs from "node:fs";
import * as nodePath from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { readPermissionRules, settingsPath } from "./claude-settings.ts";
import { ProcLive } from "./proc.ts";
import { hasGit, makeRepo, removeDir, run, tempDir, write } from "./test-utils.ts";
import { copyWorktreeIncludes } from "./worktree-include.ts";
import {
  addWorktree,
  baseBranches,
  createWorktree,
  listWorktrees,
  pendingPermissions,
  planPlacement,
  removeDirAllResilient,
  removeWorktree,
  restoreWorktree,
  sanitizeBase,
  worktreeCleanliness,
  type ParsedWorktree,
} from "./worktrees.ts";

const provide = Effect.provide(ProcLive);
const row = (path: string, branch?: string): ParsedWorktree => ({
  path,
  branch,
  detached: branch === undefined,
});
const allowRules = (dir: string, ...rules: Array<string>) =>
  write(settingsPath(dir), JSON.stringify({ permissions: { allow: rules } }));

/** Runs `commit` with git's author and committer dates pinned to `date`. */
const withCommitDate = (date: string, commit: () => void) => {
  const keys = ["GIT_AUTHOR_DATE", "GIT_COMMITTER_DATE"] as const;
  const saved = keys.map((key) => process.env[key]);
  for (const key of keys) process.env[key] = date;
  try {
    commit();
  } finally {
    keys.forEach((key, i) => {
      const value = saved[i];
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    });
  }
};

describe.skipIf(!hasGit)("worktrees", () => {
  const dirs: Array<string> = [];
  const tmp = () => {
    const dir = tempDir();
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) removeDir(dir);
  });

  /** A repo with ignored files, a worktree of it, and `include` as its `.worktreeinclude`. */
  const includeFixture = (include?: string) => {
    const repo = makeRepo(tmp());
    write(nodePath.join(repo, ".gitignore"), ".env\nconfig/secret.key\nscratch.txt\n");
    write(nodePath.join(repo, ".env"), "KEY=1");
    write(nodePath.join(repo, "config", "secret.key"), "s3cr3t");
    write(nodePath.join(repo, "scratch.txt"), "junk");
    if (include !== undefined) write(nodePath.join(repo, ".worktreeinclude"), include);
    run(repo, "add", "-A");
    run(repo, "commit", "-qm", "fixture");
    const wt = nodePath.join(nodePath.dirname(repo), "wt");
    run(repo, "worktree", "add", "-q", wt);
    return { repo, wt };
  };

  /** A repo whose ignored `generated/` the include rule copies, and a dir outside both trees. */
  const linkFixture = () => {
    const root = tmp();
    const repo = makeRepo(root);
    const outside = nodePath.join(root, "outside");
    fs.mkdirSync(outside);
    write(nodePath.join(repo, ".gitignore"), "generated/\n");
    write(nodePath.join(repo, ".worktreeinclude"), "generated/**\n.env\n");
    run(repo, "add", "-A");
    run(repo, "commit", "-qm", "fixture");
    return { root, repo, outside };
  };

  /** makeRepo + an ignored local settings file + a real worktree at `<repo>/.worktrees/<name>`. */
  const repoWithWorktree = (name = "b") => {
    const repo = makeRepo(tmp());
    write(nodePath.join(repo, ".gitignore"), ".claude/settings.local.json\n.worktrees/\n");
    run(repo, "add", ".gitignore");
    run(repo, "commit", "-qm", "ignore local settings");
    const wt = nodePath.join(repo, ".worktrees", name);
    run(repo, "worktree", "add", "-q", "-b", name, wt);
    return { repo, wt };
  };

  describe("placement", () => {
    it("adds a fresh branch under .worktrees", () => {
      const repo = nodePath.join(tmp(), "repo");
      fs.mkdirSync(repo);
      const plan = planPlacement([], repo, "feat/x", "feat/x");
      expect(plan).toEqual({
        worktreeDir: nodePath.join(repo, ".worktrees", "feat-x"),
        reuse: false,
        isMainCheckout: false,
        folderName: "feat-x",
      });
    });

    it("reuses the checkout that already has the branch", () => {
      const root = tmp();
      const repo = nodePath.join(root, "repo");
      const other = nodePath.join(root, "other");
      fs.mkdirSync(repo);
      fs.mkdirSync(other);
      const plan = planPlacement(
        [row(repo, "master"), row(other, "feat/x")],
        repo,
        "feat/x",
        "feat/x",
      );
      expect(plan.reuse).toBe(true);
      expect(plan.isMainCheckout).toBe(false);
      expect(plan.worktreeDir).toBe(other);
    });

    it("flags landing in the main checkout", () => {
      const repo = nodePath.join(tmp(), "repo");
      fs.mkdirSync(repo);
      const plan = planPlacement([row(repo, "feat/x")], repo, "feat/x", "feat/x");
      expect(plan.reuse && plan.isMainCheckout).toBe(true);
    });

    it("matches the raw branch even when unrepresentable", () => {
      const root = tmp();
      const other = nodePath.join(root, "other");
      fs.mkdirSync(other);
      const plan = planPlacement(
        [row(other, "weird#branch")],
        nodePath.join(root, "repo"),
        "weird#branch",
        "",
      );
      expect(plan.reuse).toBe(true);
      expect(plan.worktreeDir).toBe(other);
    });

    it("ignores a stale listing whose dir is gone", () => {
      const root = tmp();
      const repo = nodePath.join(root, "repo");
      const plan = planPlacement(
        [row(nodePath.join(root, "gone"), "feat/x")],
        repo,
        "feat/x",
        "feat/x",
      );
      expect(plan.reuse).toBe(false);
      expect(plan.worktreeDir).toBe(nodePath.join(repo, ".worktrees", "feat-x"));
    });

    it("reuses a registered worktree root but never a stray dir", () => {
      const repo = nodePath.join(tmp(), "repo");
      const wtDir = nodePath.join(repo, ".worktrees", "feat-x");
      fs.mkdirSync(wtDir, { recursive: true });
      expect(planPlacement([row(repo, "master"), row(wtDir)], repo, "feat/x", "feat/x").reuse).toBe(
        true,
      );
      const stray = nodePath.join(repo, ".worktrees", "feat-y");
      fs.mkdirSync(stray, { recursive: true });
      expect(planPlacement([], repo, "feat/y", "feat/y").reuse).toBe(false);
    });
  });

  describe("add", () => {
    it.live("creates a new branch checkout", () =>
      Effect.gen(function* () {
        const repo = makeRepo(tmp());
        const wt = nodePath.join(nodePath.dirname(repo), "wt-new");
        yield* addWorktree(repo, "feature/x", wt, undefined);
        expect(fs.existsSync(nodePath.join(wt, "tracked.txt"))).toBe(true);
        expect(run(wt, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("feature/x");
      }).pipe(provide),
    );

    it.live("checks out an existing branch", () =>
      Effect.gen(function* () {
        const repo = makeRepo(tmp());
        run(repo, "branch", "existing");
        const wt = nodePath.join(nodePath.dirname(repo), "wt-existing");
        yield* addWorktree(repo, "existing", wt, undefined);
        expect(run(wt, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("existing");
      }).pipe(provide),
    );

    it.live("seeds the repo permission allowlist minus outward rules", () =>
      Effect.gen(function* () {
        const repo = makeRepo(tmp());
        allowRules(repo, "Bash(npm test)", "Bash(git push)");
        const wt = nodePath.join(nodePath.dirname(repo), "wt-seeded");
        yield* addWorktree(repo, "seeded", wt, undefined);
        expect(readPermissionRules(wt).allow).toEqual(["Bash(npm test)"]);
      }).pipe(provide),
    );

    it.live("surfaces a git failure", () =>
      Effect.gen(function* () {
        const repo = makeRepo(tmp());
        const wt = nodePath.join(nodePath.dirname(repo), "wt-dup");
        yield* addWorktree(repo, "dup", wt, undefined);
        const error = yield* Effect.flip(addWorktree(repo, "dup2", wt, undefined));
        expect(error.reason).toBe("invalidRequest");
        expect(error.message.startsWith("git worktree failed:")).toBe(true);
      }).pipe(provide),
    );

    it.live("bases a new branch on the override", () =>
      Effect.gen(function* () {
        const repo = makeRepo(tmp());
        run(repo, "checkout", "-qb", "develop");
        write(nodePath.join(repo, "only-on-develop.txt"), "x");
        run(repo, "add", "-A");
        run(repo, "commit", "-qm", "on develop");
        run(repo, "checkout", "-q", "-");
        const wt = nodePath.join(nodePath.dirname(repo), "wt-based");
        yield* addWorktree(repo, "feature/from-develop", wt, "develop");
        expect(fs.existsSync(nodePath.join(wt, "only-on-develop.txt"))).toBe(true);
      }).pipe(provide),
    );

    it.live("verifies a base and falls back on anything unusable", () =>
      Effect.gen(function* () {
        const repo = makeRepo(tmp());
        expect(yield* sanitizeBase(repo, "no-such-branch")).toBeUndefined();
        expect(yield* sanitizeBase(repo, "-evil")).toBeUndefined();
        expect(yield* sanitizeBase(repo, "semi;colon")).toBeUndefined();
        expect(yield* sanitizeBase(repo, "")).toBeUndefined();
        expect(yield* sanitizeBase(repo, "  main  ")).toBe("main");
      }).pipe(provide),
    );
  });

  describe(".worktreeinclude", () => {
    it.live("copies matched ignored files, including nested ones", () =>
      Effect.gen(function* () {
        const { repo, wt } = includeFixture(".env\nconfig/secret.key\n");
        expect(yield* copyWorktreeIncludes(repo, wt)).toBe(2);
        expect(fs.readFileSync(nodePath.join(wt, ".env"), "utf8")).toBe("KEY=1");
        expect(fs.readFileSync(nodePath.join(wt, "config", "secret.key"), "utf8")).toBe("s3cr3t");
        expect(fs.existsSync(nodePath.join(wt, "scratch.txt"))).toBe(false);
      }).pipe(provide),
    );

    it.live("is a no-op without an include file and skips comments", () =>
      Effect.gen(function* () {
        const none = includeFixture();
        expect(yield* copyWorktreeIncludes(none.repo, none.wt)).toBe(0);
        const commented = includeFixture("# secrets\n\n.env\n");
        expect(yield* copyWorktreeIncludes(commented.repo, commented.wt)).toBe(1);
      }).pipe(provide),
    );

    it.live("copies a name git would quote in line output", () =>
      Effect.gen(function* () {
        const repo = makeRepo(tmp());
        write(nodePath.join(repo, ".gitignore"), "*.env\n");
        write(nodePath.join(repo, ".worktreeinclude"), "*.env\n");
        write(nodePath.join(repo, "blåbær.env"), "KEY=1");
        run(repo, "add", "-A");
        run(repo, "commit", "-qm", "fixture");
        const wt = nodePath.join(nodePath.dirname(repo), "wt");
        run(repo, "worktree", "add", "-q", wt);
        expect(yield* copyWorktreeIncludes(repo, wt)).toBe(1);
        expect(fs.readFileSync(nodePath.join(wt, "blåbær.env"), "utf8")).toBe("KEY=1");
        // A name at the component limit still fits beside its temp file.
        const long = `${"a".repeat(251)}.env`;
        write(nodePath.join(repo, long), "LONG=1");
        expect(yield* copyWorktreeIncludes(repo, wt)).toBe(2);
        expect(fs.readFileSync(nodePath.join(wt, long), "utf8")).toBe("LONG=1");
      }).pipe(provide),
    );

    // Git for Windows checks symlinks out as plain files unless `core.symlinks` and the privilege
    // to make them are both there.
    describe.skipIf(process.platform === "win32")("symlinks", () => {
      it.live("doesn't write through a directory the branch tracks as a symlink", () =>
        Effect.gen(function* () {
          const { root, repo, outside } = linkFixture();
          write(nodePath.join(outside, "artifact.txt"), "original");
          run(repo, "checkout", "-qb", "linked");
          fs.symlinkSync(outside, nodePath.join(repo, "generated"));
          run(repo, "add", "-f", "generated");
          run(repo, "commit", "-qm", "tracked symlink");
          run(repo, "checkout", "-q", "main");
          write(nodePath.join(repo, "generated", "artifact.txt"), "replacement");
          const wt = nodePath.join(root, "wt");
          run(repo, "worktree", "add", "-q", wt, "linked");
          expect(fs.lstatSync(nodePath.join(wt, "generated")).isSymbolicLink()).toBe(true);
          expect(yield* copyWorktreeIncludes(repo, wt)).toBe(0);
          expect(fs.readFileSync(nodePath.join(outside, "artifact.txt"), "utf8")).toBe("original");
        }).pipe(provide),
      );

      it.live("doesn't replace a file the branch tracks as a symlink", () =>
        Effect.gen(function* () {
          const { root, repo, outside } = linkFixture();
          const target = nodePath.join(outside, "target.txt");
          write(target, "original");
          run(repo, "checkout", "-qb", "linked");
          fs.symlinkSync(target, nodePath.join(repo, ".env"));
          run(repo, "add", "-f", ".env");
          run(repo, "commit", "-qm", "tracked symlink");
          run(repo, "checkout", "-q", "main");
          write(nodePath.join(repo, ".gitignore"), "generated/\n.env\n");
          write(nodePath.join(repo, ".env"), "KEY=1");
          const wt = nodePath.join(root, "wt");
          run(repo, "worktree", "add", "-q", wt, "linked");
          expect(yield* copyWorktreeIncludes(repo, wt)).toBe(0);
          expect(fs.readFileSync(target, "utf8")).toBe("original");
          expect(fs.readlinkSync(nodePath.join(wt, ".env"))).toBe(target);
        }).pipe(provide),
      );

      it.live("doesn't copy an ignored source symlink's target in", () =>
        Effect.gen(function* () {
          const { root, repo, outside } = linkFixture();
          const secret = nodePath.join(outside, "private.txt");
          write(secret, "dummy confidential text");
          fs.mkdirSync(nodePath.join(repo, "generated"));
          fs.symlinkSync(secret, nodePath.join(repo, "generated", "private.txt"));
          fs.symlinkSync(outside, nodePath.join(repo, "generated", "dir"));
          write(nodePath.join(repo, "generated", "plain.txt"), "kept");
          const wt = nodePath.join(root, "wt");
          run(repo, "worktree", "add", "-q", wt);
          expect(yield* copyWorktreeIncludes(repo, wt)).toBe(1);
          expect(fs.readFileSync(nodePath.join(wt, "generated", "plain.txt"), "utf8")).toBe("kept");
          expect(fs.existsSync(nodePath.join(wt, "generated", "private.txt"))).toBe(false);
          expect(fs.existsSync(nodePath.join(wt, "generated", "dir"))).toBe(false);
        }).pipe(provide),
      );
    });
  });

  describe("restore", () => {
    it.live("recreates a deleted worktree from the local branch, origin, then the PR's head", () =>
      Effect.gen(function* () {
        const root = tmp();
        const repo = makeRepo(root);
        const origin = nodePath.join(root, "origin.git");
        run(root, "init", "-q", "--bare", origin);
        run(repo, "remote", "add", "origin", origin);
        run(repo, "push", "-q", "origin", "main");
        write(nodePath.join(repo, ".gitignore"), ".env\n");
        write(nodePath.join(repo, ".worktreeinclude"), ".env\n");
        run(repo, "add", "-A");
        run(repo, "commit", "-qm", "include");
        run(repo, "push", "-q", "origin", "main");
        write(nodePath.join(repo, ".env"), "TOKEN=dummy\n");
        const { checkout } = yield* createWorktree({
          repoPath: repo,
          branch: "feat/x",
          openCheckouts: [],
        });
        const dir = checkout.path;
        write(nodePath.join(dir, "a.txt"), "a\n");
        run(dir, "add", "a.txt");
        run(dir, "commit", "-qm", "a");
        const head = run(dir, "rev-parse", "HEAD").trim();
        const restore = (fromPr?: number) =>
          restoreWorktree({
            repoPath: repo,
            worktreeDir: dir,
            branch: "feat/x",
            fromPr,
            openCheckouts: [],
          });

        // Still there: nothing to restore.
        expect((yield* Effect.flip(restore())).message).toContain("nothing to restore");
        fs.rmSync(dir, { recursive: true, force: true });
        expect(yield* restore()).toEqual({ kind: "restored", source: "local" });
        expect(run(dir, "rev-parse", "HEAD").trim()).toBe(head);
        expect(fs.readFileSync(nodePath.join(dir, ".env"), "utf8")).toBe("TOKEN=dummy\n");

        // Only origin has it: the local branch went after a merge.
        run(dir, "push", "-q", "origin", "feat/x");
        run(repo, "worktree", "remove", "--force", dir);
        run(repo, "branch", "-D", "feat/x");
        expect(yield* restore()).toEqual({ kind: "restored", source: "origin" });
        expect(run(dir, "rev-parse", "HEAD").trim()).toBe(head);

        // Gone everywhere: nothing changes unless the PR's head is asked for.
        run(repo, "push", "-q", origin, `${head}:refs/pull/7/head`);
        run(repo, "push", "-q", "origin", "--delete", "feat/x");
        fs.rmSync(dir, { recursive: true, force: true });
        run(repo, "worktree", "prune");
        run(repo, "branch", "-D", "feat/x");
        // A remote-tracking ref that outlived the branch on GitHub isn't taken for origin's.
        run(repo, "update-ref", "refs/remotes/origin/feat/x", head);
        expect(yield* restore()).toEqual({ kind: "branchGone" });
        expect(fs.existsSync(dir)).toBe(false);
        expect(yield* restore(7)).toEqual({ kind: "restored", source: "pr" });
        expect(run(dir, "rev-parse", "HEAD").trim()).toBe(head);
        expect(run(dir, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("feat/x");
        // The PR's head was fetched into a ref of its own, and that ref is gone again.
        expect(run(repo, "for-each-ref", "refs/gram").trim()).toBe("");
      }).pipe(provide),
    );

    it.live("refuses a branch checked out in another worktree", () =>
      Effect.gen(function* () {
        const repo = makeRepo(tmp());
        const other = nodePath.join(repo, ".worktrees", "other");
        run(repo, "worktree", "add", "-q", "-b", "feat/y", other);
        const error = yield* Effect.flip(
          restoreWorktree({
            repoPath: repo,
            worktreeDir: nodePath.join(repo, ".worktrees", "gone"),
            branch: "feat/y",
            openCheckouts: [],
          }),
        );
        expect(error).toMatchObject({ reason: "conflict" });
        expect(error.message).toContain("feat/y is checked out in");
      }).pipe(provide),
    );
  });

  describe("create", () => {
    it.live("places the worktree, reuses it for the same branch, and guards open checkouts", () =>
      Effect.gen(function* () {
        const repo = makeRepo(tmp());
        const created = yield* createWorktree({
          repoPath: repo,
          branch: "feat/x",
          openCheckouts: [],
        });
        const dir = nodePath.join(repo, ".worktrees", "feat-x");
        expect(created.reused).toBe(false);
        expect(created.checkout).toMatchObject({
          kind: "worktree",
          path: dir,
          branch: "feat/x",
          repoRoot: repo,
        });
        const again = yield* createWorktree({
          repoPath: repo,
          branch: "feat/x",
          openCheckouts: [],
        });
        expect(again.reused).toBe(true);
        expect(fs.realpathSync(again.checkout.path)).toBe(fs.realpathSync(dir));
        const error = yield* Effect.flip(
          createWorktree({ repoPath: repo, branch: "feat/x", openCheckouts: [dir] }),
        );
        expect(error.reason).toBe("conflict");
        const main = yield* createWorktree({ repoPath: repo, branch: "main", openCheckouts: [] });
        expect(main.checkout.kind).toBe("main");
      }).pipe(provide),
    );

    it.live("keeps the worktrees folder out of the main checkout's status, listed once", () =>
      Effect.gen(function* () {
        const repo = makeRepo(tmp());
        yield* createWorktree({ repoPath: repo, branch: "feat/a", openCheckouts: [] });
        yield* createWorktree({ repoPath: repo, branch: "feat/b", openCheckouts: [] });
        expect(run(repo, "status", "--porcelain")).toBe("");
        const exclude = fs.readFileSync(nodePath.join(repo, ".git", "info", "exclude"), "utf8");
        expect(exclude.split(/\r?\n/).filter((line) => line === ".worktrees/")).toHaveLength(1);
        expect(fs.existsSync(nodePath.join(repo, ".gitignore"))).toBe(false);
      }).pipe(provide),
    );

    it.live("adds to an existing exclude file in its line endings, or creates one", () =>
      Effect.gen(function* () {
        const repo = makeRepo(tmp());
        const exclude = nodePath.join(repo, ".git", "info", "exclude");
        // Windows-written, without a final newline.
        fs.writeFileSync(exclude, "# local\r\n*.log");
        write(nodePath.join(repo, "debug.log"), "x");
        yield* createWorktree({ repoPath: repo, branch: "feat/a", openCheckouts: [] });
        expect(fs.readFileSync(exclude, "utf8")).toBe("# local\r\n*.log\r\n.worktrees/\r\n");
        expect(run(repo, "status", "--porcelain")).toBe("");

        fs.rmSync(exclude);
        yield* createWorktree({ repoPath: repo, branch: "feat/b", openCheckouts: [] });
        expect(fs.readFileSync(exclude, "utf8")).toBe(".worktrees/\n");
      }).pipe(provide),
    );

    it.live("starts a new branch without tracking its base", () =>
      Effect.gen(function* () {
        const root = tmp();
        const origin = nodePath.join(root, "origin.git");
        run(root, "init", "-q", "--bare", "-b", "main", origin);
        const repo = makeRepo(root);
        run(repo, "remote", "add", "origin", origin);
        run(repo, "push", "-q", "origin", "main");
        run(repo, "fetch", "-q", "origin");
        const created = yield* createWorktree({
          repoPath: repo,
          branch: "feat/x",
          openCheckouts: [],
        });
        expect(created.checkout.base).toMatch(/main$/);
        // With no upstream, publishing pushes `-u origin feat/x` instead of refusing origin/main.
        expect(() => run(repo, "rev-parse", "--abbrev-ref", "feat/x@{upstream}")).toThrow();
      }).pipe(provide),
    );

    it.live("rejects an invalid branch or repo", () =>
      Effect.gen(function* () {
        const repo = makeRepo(tmp());
        expect(
          (yield* Effect.flip(
            createWorktree({ repoPath: repo, branch: "bad branch", openCheckouts: [] }),
          )).reason,
        ).toBe("invalidRequest");
        const plain = tmp();
        expect(
          (yield* Effect.flip(createWorktree({ repoPath: plain, branch: "x", openCheckouts: [] })))
            .message,
        ).toBe("repoPath is not a git repository");
      }).pipe(provide),
    );

    it.live("lists worktrees with main, open and activity annotations", () =>
      Effect.gen(function* () {
        const { repo, wt } = repoWithWorktree();
        const list = yield* listWorktrees(repo, { openCheckouts: [wt] });
        expect(list.worktrees.map((w) => [w.isMain, w.isOpen, w.branch])).toEqual([
          [true, false, "main"],
          [false, true, "b"],
        ]);
        expect(list.worktrees[1]?.lastActivity).toBeGreaterThan(0);
      }).pipe(provide),
    );

    it.live("dates a thread-less worktree by its last commit, not by when it was listed", () =>
      Effect.gen(function* () {
        const { repo, wt } = repoWithWorktree();
        const committed = Date.UTC(2021, 0, 2, 3, 4, 5);
        withCommitDate(new Date(committed).toISOString(), () =>
          run(wt, "commit", "--allow-empty", "-qm", "old work"),
        );
        const list = yield* listWorktrees(repo, { openCheckouts: [] });
        expect(list.worktrees[1]?.lastActivity).toBe(committed);

        const withAgent = yield* listWorktrees(repo, {
          openCheckouts: [],
          lastActivity: (path) => (path === wt ? 42 : 0),
        });
        expect(withAgent.worktrees[1]?.lastActivity).toBe(42);
      }).pipe(provide),
    );

    it.live("reports the ref an empty base picker will use", () =>
      Effect.gen(function* () {
        const repo = makeRepo(tmp());
        run(repo, "update-ref", "refs/remotes/origin/trunk", "HEAD");
        run(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
        const result = yield* baseBranches(repo);
        expect(result.default).toBe("origin/trunk");
        expect(result.branches[0]).toBe("origin/trunk");
      }).pipe(provide),
    );
  });

  describe("remove", () => {
    it.live("merges selected non-excluded rules into root after removal", () =>
      Effect.gen(function* () {
        const { repo, wt } = repoWithWorktree();
        allowRules(repo, "Bash(ls *)");
        allowRules(wt, "Bash(date:*)", "Bash(whoami)", "Bash(git push)");
        yield* removeWorktree({
          repoPath: repo,
          worktreeDir: wt,
          mergeRules: ["Bash(date:*)", "Bash(git push)"],
          openCheckouts: [],
        });
        expect(fs.existsSync(wt)).toBe(false);
        expect(readPermissionRules(repo).allow).toEqual(["Bash(ls *)", "Bash(date:*)"]);
      }).pipe(provide),
    );

    it.live("refuses a dirty worktree with dirty: true and merges nothing", () =>
      Effect.gen(function* () {
        const { repo, wt } = repoWithWorktree();
        allowRules(repo, "Bash(ls *)");
        allowRules(wt, "Bash(date:*)");
        write(nodePath.join(wt, "tracked.txt"), "changed");
        const error = yield* Effect.flip(
          removeWorktree({
            repoPath: repo,
            worktreeDir: wt,
            mergeRules: ["Bash(date:*)"],
            openCheckouts: [],
          }),
        );
        expect(error.dirty).toBe(true);
        expect(fs.existsSync(wt)).toBe(true);
        expect(readPermissionRules(repo).allow).toEqual(["Bash(ls *)"]);
        yield* removeWorktree({ repoPath: repo, worktreeDir: wt, force: true, openCheckouts: [] });
        expect(fs.existsSync(wt)).toBe(false);
      }).pipe(provide),
    );

    it.live("refuses while a thread is open, and converges after an out-of-band delete", () =>
      Effect.gen(function* () {
        const { repo, wt } = repoWithWorktree();
        expect(
          (yield* Effect.flip(
            removeWorktree({ repoPath: repo, worktreeDir: wt, openCheckouts: [wt] }),
          )).reason,
        ).toBe("conflict");
        fs.rmSync(wt, { recursive: true, force: true });
        yield* removeWorktree({ repoPath: repo, worktreeDir: wt, openCheckouts: [] });
        expect(run(repo, "worktree", "list", "--porcelain")).not.toContain(".worktrees/b");
      }).pipe(provide),
    );

    it.live("detects uncommitted work structurally, scoped to the checkout", () =>
      Effect.gen(function* () {
        const { repo, wt } = repoWithWorktree();
        expect(yield* worktreeCleanliness(wt)).toBe("clean");
        write(nodePath.join(wt, "tracked.txt"), "changed");
        expect(yield* worktreeCleanliness(wt)).toBe("dirty");
        write(nodePath.join(wt, "tracked.txt"), "tracked");
        write(nodePath.join(wt, "new-untracked.txt"), "x");
        expect(yield* worktreeCleanliness(wt)).toBe("dirty");
        write(nodePath.join(repo, "tracked.txt"), "changed");
        const subdir = nodePath.join(repo, "plain-subdir");
        fs.mkdirSync(subdir);
        expect(yield* worktreeCleanliness(subdir)).toBe("unknown");
        expect(yield* worktreeCleanliness(nodePath.join(repo, "absent"))).toBe("clean");
      }).pipe(provide),
    );

    // Git refuses an unreadable index; reading that failure as "clean" let the fs fallback delete
    // the only copy of uncommitted work without force.
    it.live("refuses a non-forced removal when git can't read the worktree's status", () =>
      Effect.gen(function* () {
        const { repo, wt } = repoWithWorktree();
        const work = nodePath.join(wt, "uncommitted.txt");
        write(work, "only copy of invented work");
        const index = nodePath.resolve(wt, run(wt, "rev-parse", "--git-path", "index").trim());
        fs.writeFileSync(index, "bad");
        expect(yield* worktreeCleanliness(wt)).toBe("unknown");
        const error = yield* Effect.flip(
          removeWorktree({ repoPath: repo, worktreeDir: wt, openCheckouts: [] }),
        );
        expect(error.dirty).toBe(true);
        expect(error.message).toMatch(/^git couldn't read the worktree's status: /);
        expect(fs.existsSync(work)).toBe(true);
        yield* removeWorktree({ repoPath: repo, worktreeDir: wt, force: true, openCheckouts: [] });
        expect(fs.existsSync(wt)).toBe(false);
      }).pipe(provide),
    );

    it.live("offers pending permissions only for a registered worktree", () =>
      Effect.gen(function* () {
        const { repo, wt } = repoWithWorktree();
        allowRules(repo, "Bash(ls *)");
        allowRules(wt, "Bash(ls *)", "Bash(date:*)", "Bash(git push)");
        expect(yield* pendingPermissions(repo, wt)).toEqual(["Bash(date:*)"]);
        const fake = nodePath.join(nodePath.dirname(repo), "not-a-worktree");
        allowRules(fake, "Bash(date:*)");
        expect((yield* Effect.flip(pendingPermissions(repo, fake))).reason).toBe("invalidRequest");
      }).pipe(provide),
    );

    it.live("deletes a tree idempotently", () =>
      Effect.gen(function* () {
        const dir = nodePath.join(tmp(), "wt");
        write(nodePath.join(dir, "a", "b", "c", "file.txt"), "x");
        yield* removeDirAllResilient(dir);
        expect(fs.existsSync(dir)).toBe(false);
        yield* removeDirAllResilient(dir);
      }),
    );
  });
});
