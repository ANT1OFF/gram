import * as nodePath from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import type { PrStatus } from "@gram/contracts";
import { Pr, PrLookupError, ProcLive } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { deleteMergedBranch } from "./branch-cleanup.ts";
import { hasGit, makeRepo, removeDir, run, tempDir, write } from "./test-repo.ts";

const merged = (headRefOid: string): PrStatus => ({
  number: 42,
  state: "MERGED",
  url: "u",
  title: "t",
  isDraft: false,
  checks: "passing",
  headMatches: false,
  aheadOfPr: false,
  headRefOid,
});

/** Real git, and gh answering `answer` for the bound PR lookup. */
const withPr = (answer: Effect.Effect<PrStatus | undefined, PrLookupError>) =>
  Effect.provide(
    Layer.mergeAll(
      ProcLive,
      Layer.succeed(Pr, {
        status: () => answer,
        checks: () => Effect.succeed([]),
        prime: () => Effect.void,
        seenChecks: () => Effect.succeed(undefined),
        detail: () => Effect.succeed({ available: false }),
      }),
    ),
  );

const PR = { repo: "acme/app", number: 42 };

const branches = (repo: string) => run(repo, "branch", "--list", "feat").trim();

describe.skipIf(!hasGit)("deleteMergedBranch", () => {
  const dirs: Array<string> = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) removeDir(dir);
  });

  /** A repo with a `feat` worktree holding one commit; returns that commit. */
  const fixture = () => {
    const tmp = tempDir();
    dirs.push(tmp);
    const repo = makeRepo(tmp);
    const worktree = nodePath.join(tmp, "feat-tree");
    run(repo, "worktree", "add", "-q", "-b", "feat", worktree);
    write(nodePath.join(worktree, "feature.txt"), "feature");
    run(worktree, "add", "-A");
    run(worktree, "commit", "-qm", "feature");
    const head = run(worktree, "rev-parse", "HEAD").trim();
    return { repo, worktree, head };
  };

  it.effect("deletes the local branch when its tip is the merged PR's head", () =>
    Effect.gen(function* () {
      const { repo, worktree, head } = fixture();
      run(repo, "worktree", "remove", worktree);
      const result = yield* deleteMergedBranch({ repoPath: repo, branch: "feat", pr: PR }).pipe(
        withPr(Effect.succeed(merged(head))),
      );
      expect(result).toEqual({ name: "feat", deleted: true });
      expect(branches(repo)).toBe("");
    }),
  );

  it.effect("keeps a branch with commits the merged PR doesn't have", () =>
    Effect.gen(function* () {
      const { repo, worktree, head } = fixture();
      write(nodePath.join(worktree, "more.txt"), "more");
      run(worktree, "add", "-A");
      run(worktree, "commit", "-qm", "more");
      run(repo, "worktree", "remove", worktree);
      const result = yield* deleteMergedBranch({ repoPath: repo, branch: "feat", pr: PR }).pipe(
        withPr(Effect.succeed(merged(head))),
      );
      expect(result).toEqual({
        name: "feat",
        deleted: false,
        reason: "it has commits #42 doesn't",
      });
      expect(branches(repo)).toContain("feat");
    }),
  );

  it.effect("keeps a branch still checked out in another worktree", () =>
    Effect.gen(function* () {
      const { repo, worktree, head } = fixture();
      const result = yield* deleteMergedBranch({ repoPath: repo, branch: "feat", pr: PR }).pipe(
        withPr(Effect.succeed(merged(head))),
      );
      expect(result.deleted).toBe(false);
      expect(result.reason).toContain(worktree);
      expect(branches(repo)).toContain("feat");
    }),
  );

  it.effect("keeps the branch when gh can't confirm the merge", () =>
    Effect.gen(function* () {
      const { repo, worktree } = fixture();
      run(repo, "worktree", "remove", worktree);
      const result = yield* deleteMergedBranch({ repoPath: repo, branch: "feat", pr: PR }).pipe(
        withPr(Effect.fail(new PrLookupError({ message: "HTTP 502" }))),
      );
      expect(result).toEqual({
        name: "feat",
        deleted: false,
        reason: "couldn't confirm #42 with gh",
      });
      expect(branches(repo)).toContain("feat");
    }),
  );
});
