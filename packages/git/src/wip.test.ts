import * as fs from "node:fs";
import * as nodePath from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ProcLive } from "./proc.ts";
import { hasGit, makeRepo, removeDir, run, tempDir, write } from "./test-utils.ts";
import {
  dropWip,
  fetchBranchTip,
  fetchWip,
  isPushRemote,
  pushWip,
  restoreWip,
  restoreWipWorktree,
  snapshotWip,
  wipCaughtUp,
  wipRef,
} from "./wip.ts";

const provide = Effect.provide(ProcLive);
/** The tests' remote is a bare repository on disk. */
const FILE = "file";

describe.skipIf(!hasGit)("a thread's work in progress", () => {
  const dirs: Array<string> = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) removeDir(dir);
  });
  /** A repository with a bare `origin` beside it. */
  const withOrigin = () => {
    const dir = tempDir();
    dirs.push(dir);
    const repo = makeRepo(dir);
    const origin = nodePath.join(dir, "origin.git");
    run(dir, "init", "--bare", "--quiet", origin);
    run(repo, "remote", "add", "origin", origin);
    run(repo, "push", "--quiet", "origin", "HEAD:refs/heads/main");
    return { repo, origin };
  };

  it.live("is committed on top of HEAD under a hidden ref, the branch and index untouched", () =>
    Effect.gen(function* () {
      const { repo, origin } = withOrigin();
      const head = run(repo, "rev-parse", "HEAD").trim();
      write(nodePath.join(repo, "tracked.txt"), "edited\n");
      write(nodePath.join(repo, "src", "new.ts"), "export const made = 1;\n");
      run(repo, "add", "src/new.ts");
      const staged = run(repo, "diff", "--cached", "--name-only");

      const kept = yield* snapshotWip(repo, "thread-1");
      expect(kept).toMatchObject({ ref: wipRef("thread-1"), uncommitted: true });
      expect(run(repo, "rev-parse", "HEAD").trim()).toBe(head);
      expect(run(repo, "rev-parse", `${kept.commit}^`).trim()).toBe(head);
      expect(run(repo, "diff", "--cached", "--name-only")).toBe(staged);
      expect(run(repo, "show", `${kept.ref}:tracked.txt`)).toBe("edited\n");
      expect(run(repo, "show", `${kept.ref}:src/new.ts`)).toBe("export const made = 1;\n");

      // The same tree on the same HEAD keeps its commit, so a repeat has nothing new to push.
      expect((yield* snapshotWip(repo, "thread-1")).commit).toBe(kept.commit);

      yield* pushWip(repo, kept, "origin", FILE);
      expect(run(origin, "rev-parse", wipRef("thread-1")).trim()).toBe(kept.commit);
      expect(run(origin, "show", `${wipRef("thread-1")}:tracked.txt`)).toBe("edited\n");
      // No branch of the remote moved.
      expect(run(origin, "rev-parse", "refs/heads/main").trim()).toBe(head);
    }).pipe(provide),
  );

  it.live("carries commits the branch hasn't pushed, and replaces what the remote kept", () =>
    Effect.gen(function* () {
      const { repo, origin } = withOrigin();
      write(nodePath.join(repo, "tracked.txt"), "first\n");
      yield* pushWip(repo, yield* snapshotWip(repo, "thread-1"), "origin", FILE);
      run(repo, "commit", "--quiet", "-am", "local only");
      const head = run(repo, "rev-parse", "HEAD").trim();

      const clean = yield* snapshotWip(repo, "thread-1");
      expect(clean).toMatchObject({ commit: head, uncommitted: false });
      yield* pushWip(repo, clean, "origin", FILE);
      expect(run(origin, "rev-parse", wipRef("thread-1")).trim()).toBe(head);
      expect(run(origin, "log", "-1", "--format=%s", wipRef("thread-1")).trim()).toBe("local only");
    }).pipe(provide),
  );

  it.live("writes that one ref whatever the user's config says of tags", () =>
    Effect.gen(function* () {
      const { repo, origin } = withOrigin();
      run(repo, "config", "push.followTags", "true");
      run(repo, "tag", "-a", "v1", "-m", "v1");
      write(nodePath.join(repo, "tracked.txt"), "edited\n");
      yield* pushWip(repo, yield* snapshotWip(repo, "thread-1"), "origin", FILE);
      expect(run(origin, "for-each-ref", "--format=%(refname)").trim().split("\n")).toEqual([
        wipRef("thread-1"),
        "refs/heads/main",
      ]);
    }).pipe(provide),
  );

  it.live("refuses an id or a remote that git would read as something else", () =>
    Effect.gen(function* () {
      const { repo } = withOrigin();
      expect((yield* Effect.flip(snapshotWip(repo, "../heads/main"))).message).toContain(
        "invalid thread id",
      );
      const kept = yield* snapshotWip(repo, "thread-1");
      expect((yield* Effect.flip(pushWip(repo, kept, "--receive-pack=x"))).message).toContain(
        "invalid remote",
      );
      // A remote on disk, or one that names a helper to run, is refused by git itself.
      expect((yield* Effect.flip(pushWip(repo, kept))).message).toMatch(/not allowed|file/);
      expect(
        (yield* Effect.flip(pushWip(repo, kept, "ext::sh -c touch%20/tmp/x"))).message,
      ).toContain("invalid remote");
      expect((yield* Effect.flip(pushWip(repo, kept, "ext::/bin/true"))).message).toMatch(
        /not allowed|ext/,
      );
      expect(
        (yield* Effect.flip(pushWip(repo, { ...kept, ref: "refs/heads/main" }, "origin", FILE)))
          .message,
      ).toContain("not a work-in-progress snapshot");
      expect(isPushRemote("origin")).toBe(true);
      expect(isPushRemote("https://git.example.test/acme/widgets.git")).toBe(true);
      expect(isPushRemote("")).toBe(false);
    }).pipe(provide),
  );

  /** A second machine's clone of `origin`, made as a host makes one. */
  const cloneOf = (origin: string) => {
    const dir = tempDir();
    dirs.push(dir);
    const clone = nodePath.join(dir, "clone");
    run(dir, "clone", "--quiet", "--branch", "main", origin, clone);
    run(clone, "config", "user.email", "test@example.test");
    run(clone, "config", "user.name", "Test");
    return { dir, clone };
  };

  it.live("follows the thread to a fresh clone: unpushed commits and uncommitted files", () =>
    Effect.gen(function* () {
      const { repo, origin } = withOrigin();
      run(repo, "checkout", "--quiet", "-b", "feature/work");
      write(nodePath.join(repo, "committed.txt"), "never pushed\n");
      run(repo, "add", "committed.txt");
      run(repo, "commit", "--quiet", "-m", "local only");
      const head = run(repo, "rev-parse", "HEAD").trim();
      write(nodePath.join(repo, "tracked.txt"), "edited\n");
      write(nodePath.join(repo, "src", "new.ts"), "export const made = 1;\n");
      run(repo, "rm", "--quiet", "--cached", "committed.txt");
      fs.rmSync(nodePath.join(repo, "committed.txt"));
      const status = run(repo, "status", "--porcelain", "--untracked-files=all");
      yield* pushWip(repo, yield* snapshotWip(repo, "thread-1"), "origin", FILE);

      // Into a worktree of the new machine's clone, on the branch the remote never had.
      const { dir, clone } = cloneOf(origin);
      const kept = yield* fetchWip(clone, "thread-1", "origin", FILE);
      expect(kept).toMatchObject({ ref: wipRef("thread-1"), head, uncommitted: true });
      const tree = nodePath.join(dir, "trees", "work");
      yield* restoreWipWorktree(clone, tree, kept!, "feature/work");
      expect(run(tree, "rev-parse", "HEAD").trim()).toBe(head);
      expect(run(tree, "symbolic-ref", "--short", "HEAD").trim()).toBe("feature/work");
      expect(fs.readFileSync(nodePath.join(tree, "tracked.txt"), "utf8")).toBe("edited\n");
      expect(fs.readFileSync(nodePath.join(tree, "src", "new.ts"), "utf8")).toBe(
        "export const made = 1;\n",
      );
      expect(fs.existsSync(nodePath.join(tree, "committed.txt"))).toBe(false);
      // Uncommitted again; what was staged comes back unstaged.
      expect(
        run(tree, "status", "--porcelain", "--untracked-files=all")
          .split("\n")
          .map((line) => line.slice(3))
          .toSorted(),
      ).toEqual(
        status
          .split("\n")
          .map((line) => line.slice(3))
          .toSorted(),
      );
      expect(run(tree, "diff", "--cached", "--name-only")).toBe("");
      // The clone's own checkout is as the clone made it.
      expect(run(clone, "status", "--porcelain")).toBe("");

      // And into the clone's own checkout, for a thread that worked there.
      const again = cloneOf(origin);
      const main = yield* fetchWip(again.clone, "thread-1", "origin", FILE);
      // Over changes of its own nothing is put back.
      write(nodePath.join(again.clone, "mine.txt"), "mine\n");
      expect(
        (yield* Effect.flip(restoreWip(again.clone, main!, "feature/work"))).message,
      ).toContain("changes of its own");
      fs.rmSync(nodePath.join(again.clone, "mine.txt"));
      yield* restoreWip(again.clone, main!, "feature/work");
      expect(run(again.clone, "rev-parse", "feature/work").trim()).toBe(head);
      expect(fs.readFileSync(nodePath.join(again.clone, "tracked.txt"), "utf8")).toBe("edited\n");
    }).pipe(provide),
  );

  it.live(
    "puts back a branch kept with nothing uncommitted, and removes a worktree it can't finish",
    () =>
      Effect.gen(function* () {
        const { repo, origin } = withOrigin();
        write(nodePath.join(repo, "tracked.txt"), "committed\n");
        run(repo, "commit", "--quiet", "-am", "local only");
        const head = run(repo, "rev-parse", "HEAD").trim();
        yield* pushWip(repo, yield* snapshotWip(repo, "thread-1"), "origin", FILE);

        const { dir, clone } = cloneOf(origin);
        expect(yield* fetchWip(clone, "thread-none", "origin", FILE)).toBeUndefined();
        const kept = yield* fetchWip(clone, "thread-1", "origin", FILE);
        expect(kept).toMatchObject({ commit: head, head, uncommitted: false });
        // The clone's own checkout holds `main` with changes of its own, so a second worktree
        // can't take it.
        write(nodePath.join(clone, "mine.txt"), "mine\n");
        const taken = nodePath.join(dir, "taken");
        expect(
          (yield* Effect.flip(restoreWipWorktree(clone, taken, kept!, "main"))).message,
        ).toMatch(/main is checked out/);
        expect(fs.existsSync(taken)).toBe(false);
        expect(run(clone, "worktree", "list").trim().split("\n")).toHaveLength(1);
        expect(run(clone, "symbolic-ref", "--short", "HEAD").trim()).toBe("main");
        fs.rmSync(nodePath.join(clone, "mine.txt"));
        const tree = nodePath.join(dir, "tree");
        yield* restoreWipWorktree(clone, tree, kept!, "mine");
        expect(run(tree, "rev-parse", "HEAD").trim()).toBe(head);
        expect(run(tree, "status", "--porcelain")).toBe("");
        expect(
          (yield* Effect.flip(restoreWipWorktree(clone, tree, kept!, "other"))).message,
        ).toContain("is there already");
        expect((yield* Effect.flip(fetchWip(clone, "thread-1"))).message).toMatch(
          /not allowed|file/,
        );
      }).pipe(provide),
  );

  it.live(
    "is deleted once the remote's branch holds it all, and only then counts as caught up",
    () =>
      Effect.gen(function* () {
        const { repo, origin } = withOrigin();
        write(nodePath.join(repo, "tracked.txt"), "edited\n");
        const dirty = yield* snapshotWip(repo, "thread-1");
        yield* pushWip(repo, dirty, "origin", FILE);
        expect(yield* wipCaughtUp(repo, dirty, "origin", FILE)).toBe(false);
        run(repo, "commit", "--quiet", "-am", "done");
        const clean = yield* snapshotWip(repo, "thread-1");
        // Committed, and the remote's branch is still behind.
        expect(yield* wipCaughtUp(repo, clean, "origin", FILE)).toBe(false);
        run(repo, "push", "--quiet", "origin", "HEAD:refs/heads/main");
        expect(yield* wipCaughtUp(repo, clean, "origin", FILE)).toBe(true);

        yield* dropWip(repo, "thread-1", "origin", FILE);
        expect(run(origin, "for-each-ref", "--format=%(refname)").trim()).toBe("refs/heads/main");
        expect(run(repo, "for-each-ref", "--format=%(refname)", "refs/gram/wip").trim()).toBe("");
        // Again, with nothing there to delete.
        yield* dropWip(repo, "thread-1", "origin", FILE);
        expect(
          (yield* Effect.flip(dropWip(repo, "../heads/main", "origin", FILE))).message,
        ).toContain("invalid thread id");
      }).pipe(provide),
  );

  it.live("never moves a branch that is here already back, and loses none of its commits", () =>
    Effect.gen(function* () {
      const { repo, origin } = withOrigin();
      const tree = nodePath.join(nodePath.dirname(repo), "tree");
      run(repo, "worktree", "add", "--quiet", "-b", "feature/work", tree);
      write(nodePath.join(tree, "a.txt"), "one\n");
      run(tree, "add", "-A");
      run(tree, "commit", "--quiet", "-m", "first");
      const first = run(tree, "rev-parse", "HEAD").trim();
      yield* pushWip(tree, yield* snapshotWip(tree, "thread-1"), "origin", FILE);
      // Work went on on the same disk and was never pushed; then the folder alone was lost.
      write(nodePath.join(tree, "a.txt"), "two\n");
      run(tree, "commit", "--quiet", "-am", "second");
      const second = run(tree, "rev-parse", "HEAD").trim();
      fs.rmSync(tree, { recursive: true, force: true });

      // The ref is behind the branch: the branch stays where it is, and is what is checked out.
      const stale = yield* fetchWip(repo, "thread-1", "origin", FILE);
      expect(stale).toMatchObject({ head: first, uncommitted: false });
      expect(yield* restoreWipWorktree(repo, tree, stale!, "feature/work")).toEqual({
        ahead: true,
      });
      expect(run(repo, "rev-parse", "feature/work").trim()).toBe(second);
      expect(run(tree, "symbolic-ref", "--short", "HEAD").trim()).toBe("feature/work");
      expect(fs.readFileSync(nodePath.join(tree, "a.txt"), "utf8")).toBe("two\n");

      // Kept with files uncommitted on top of the older tip: there is no place for them that
      // loses nothing, so nothing is put back and the branch is not moved.
      run(tree, "checkout", "--quiet", "--detach", first);
      write(nodePath.join(tree, "b.txt"), "uncommitted\n");
      yield* pushWip(tree, yield* snapshotWip(tree, "thread-1"), "origin", FILE);
      fs.rmSync(tree, { recursive: true, force: true });
      const dirty = yield* fetchWip(repo, "thread-1", "origin", FILE);
      expect(dirty).toMatchObject({ head: first, uncommitted: true });
      expect(
        (yield* Effect.flip(restoreWipWorktree(repo, tree, dirty!, "feature/work"))).message,
      ).toContain("was not moved");
      expect(run(repo, "rev-parse", "feature/work").trim()).toBe(second);
      expect(fs.existsSync(tree)).toBe(false);

      // A branch that went another way is not moved either.
      run(repo, "checkout", "--quiet", "--detach");
      run(repo, "commit", "--quiet", "--allow-empty", "-m", "elsewhere");
      run(repo, "branch", "--quiet", "-f", "feature/work", "HEAD");
      const elsewhere = run(repo, "rev-parse", "feature/work").trim();
      expect(
        (yield* Effect.flip(restoreWipWorktree(repo, tree, stale!, "feature/work"))).message,
      ).toContain("was not moved");
      expect(run(repo, "rev-parse", "feature/work").trim()).toBe(elsewhere);

      // One behind the kept tip is moved forward to it.
      run(repo, "branch", "--quiet", "-f", "feature/work", "main");
      expect(yield* restoreWipWorktree(repo, tree, stale!, "feature/work")).toEqual({
        ahead: false,
      });
      expect(run(repo, "rev-parse", "feature/work").trim()).toBe(first);
      expect(run(origin, "rev-parse", wipRef("thread-1")).trim()).toBe(dirty!.commit);
    }).pipe(provide),
  );

  it.live("takes the clone's default branch for a thread that worked on it", () =>
    Effect.gen(function* () {
      const { repo, origin } = withOrigin();
      // The thread's worktree was on `main`, the clone it was made from somewhere else.
      run(repo, "checkout", "--quiet", "--detach");
      const work = nodePath.join(nodePath.dirname(repo), "work");
      run(repo, "worktree", "add", "--quiet", work, "main");
      write(nodePath.join(work, "new.txt"), "uncommitted\n");
      const head = run(work, "rev-parse", "HEAD").trim();
      yield* pushWip(work, yield* snapshotWip(work, "thread-1"), "origin", FILE);

      // A fresh clone is on `main` itself: it gives the branch up, and nothing in it changes.
      const { dir, clone } = cloneOf(origin);
      const kept = yield* fetchWip(clone, "thread-1", "origin", FILE);
      const tree = nodePath.join(dir, "tree");
      fs.mkdirSync(tree);
      yield* restoreWipWorktree(clone, tree, kept!, "main");
      expect(run(tree, "symbolic-ref", "--short", "HEAD").trim()).toBe("main");
      expect(run(tree, "rev-parse", "HEAD").trim()).toBe(head);
      expect(fs.readFileSync(nodePath.join(tree, "new.txt"), "utf8")).toBe("uncommitted\n");
      expect(run(clone, "rev-parse", "HEAD").trim()).toBe(head);
      expect(run(clone, "status", "--porcelain")).toBe("");
      expect(run(clone, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("HEAD");
    }).pipe(provide),
  );

  it.live("refuses a ref that isn't the commit the stop kept", () =>
    Effect.gen(function* () {
      const { repo, origin } = withOrigin();
      write(nodePath.join(repo, "tracked.txt"), "edited\n");
      const snapshot = yield* snapshotWip(repo, "thread-1");
      yield* pushWip(repo, snapshot, "origin", FILE);
      const { clone } = cloneOf(origin);
      expect(yield* fetchWip(clone, "thread-1", "origin", FILE, snapshot.commit)).toMatchObject({
        commit: snapshot.commit,
        uncommitted: true,
      });
      run(clone, "update-ref", "-d", wipRef("thread-1"));

      // Somebody who can push writes the ref, made to read as this module's own.
      const forger = cloneOf(origin).clone;
      run(forger, "checkout", "--quiet", "--orphan", "forged");
      write(nodePath.join(forger, "tracked.txt"), "forged\n");
      run(forger, "add", "-A");
      run(forger, "commit", "--quiet", "-m", "base");
      write(nodePath.join(forger, "planted.sh"), "#!/bin/sh\n");
      run(forger, "add", "-A");
      run(
        forger,
        "-c",
        "user.email=gram@localhost",
        "-c",
        "user.name=Gram",
        "commit",
        "--quiet",
        "-m",
        "work in progress thread-1",
      );
      run(forger, "push", "--quiet", "--force", "origin", `HEAD:${wipRef("thread-1")}`);
      expect(
        (yield* Effect.flip(fetchWip(clone, "thread-1", "origin", FILE, snapshot.commit))).message,
      ).toContain("isn't the commit the stop kept");
      // Nothing of it arrived.
      expect(run(clone, "for-each-ref", "--format=%(refname)", "refs/gram/wip").trim()).toBe("");
      expect(
        (yield* Effect.flip(fetchWip(clone, "thread-1", "origin", FILE, "not-a-commit"))).message,
      ).toContain("invalid commit");
    }).pipe(provide),
  );

  it.live("leaves a ref another folder of the thread wrote, and deletes its own", () =>
    Effect.gen(function* () {
      const { repo, origin } = withOrigin();
      const other = cloneOf(origin).clone;
      // Another clone keeps uncommitted work of the same thread under the thread's one ref.
      write(nodePath.join(other, "tracked.txt"), "only here\n");
      const theirs = yield* snapshotWip(other, "thread-1");
      yield* pushWip(other, theirs, "origin", FILE);

      // This one is caught up: what the ref holds is not its own, so it stays.
      const clean = yield* snapshotWip(repo, "thread-1");
      expect(yield* wipCaughtUp(repo, clean, "origin", FILE)).toBe(true);
      expect(yield* dropWip(repo, "thread-1", "origin", FILE, { by: clean.commit })).toBe("left");
      expect(run(origin, "rev-parse", wipRef("thread-1")).trim()).toBe(theirs.commit);

      // Its own earlier snapshot, which its working tree moved on from, goes.
      write(nodePath.join(repo, "tracked.txt"), "edited\n");
      const dirty = yield* snapshotWip(repo, "thread-1");
      yield* pushWip(repo, dirty, "origin", FILE);
      run(repo, "commit", "--quiet", "-am", "done");
      run(repo, "push", "--quiet", "origin", "HEAD:refs/heads/main");
      const done = yield* snapshotWip(repo, "thread-1");
      expect(done.previous).toBe(dirty.commit);
      expect(
        yield* dropWip(repo, "thread-1", "origin", FILE, {
          by: done.commit,
          also: [done.previous!],
        }),
      ).toBe("dropped");
      expect(run(origin, "for-each-ref", "--format=%(refname)").trim()).toBe("refs/heads/main");
      expect(yield* dropWip(repo, "thread-1", "origin", FILE, { by: done.commit })).toBe("absent");

      // A ref at a commit the branch contains goes too.
      run(repo, "push", "--quiet", "origin", `HEAD~1:${wipRef("thread-1")}`);
      expect(yield* dropWip(repo, "thread-1", "origin", FILE, { by: done.commit })).toBe("dropped");
    }).pipe(provide),
  );

  it.live("reads a branch's tip from the remote, for a thread whose branch held everything", () =>
    Effect.gen(function* () {
      const { repo, origin } = withOrigin();
      run(repo, "checkout", "--quiet", "-b", "feature/done");
      write(nodePath.join(repo, "done.txt"), "pushed\n");
      run(repo, "add", "-A");
      run(repo, "commit", "--quiet", "-m", "done");
      run(repo, "push", "--quiet", "origin", "feature/done");
      const head = run(repo, "rev-parse", "HEAD").trim();

      const { dir, clone } = cloneOf(origin);
      expect(yield* fetchBranchTip(clone, "feature/none", "origin", FILE)).toBeUndefined();
      expect((yield* Effect.flip(fetchBranchTip(clone, "-x", "origin", FILE))).message).toContain(
        "invalid branch",
      );
      const tip = yield* fetchBranchTip(clone, "feature/done", "origin", FILE);
      expect(tip).toEqual({
        ref: "refs/heads/feature/done",
        commit: head,
        head,
        uncommitted: false,
      });
      const tree = nodePath.join(dir, "tree");
      yield* restoreWipWorktree(clone, tree, tip!, "feature/done");
      expect(run(tree, "symbolic-ref", "--short", "HEAD").trim()).toBe("feature/done");
      expect(fs.readFileSync(nodePath.join(tree, "done.txt"), "utf8")).toBe("pushed\n");
    }).pipe(provide),
  );
});
