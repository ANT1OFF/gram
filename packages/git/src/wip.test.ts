import * as nodePath from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ProcLive } from "./proc.ts";
import { hasGit, makeRepo, removeDir, run, tempDir, write } from "./test-utils.ts";
import { isPushRemote, pushWip, snapshotWip, wipRef } from "./wip.ts";

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
});
