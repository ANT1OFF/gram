import * as fs from "node:fs";
import * as nodePath from "node:path";
import type { PrStatus } from "@gram/contracts";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  carryRebaseTier,
  diffToken,
  fillRebase,
  localGitState,
  prFingerprint,
} from "./git-state.ts";
import { GitStateRuntime, GitStateRuntimeLive } from "./git-state-runtime.ts";
import { Pr, PrLookupError } from "./pr.ts";
import { ProcLive } from "./proc.ts";
import { hasGit, makeRepo, removeDir, run, tempDir, write } from "./test-utils.ts";

const provide = Effect.provide(ProcLive);

const pr = (overrides: Partial<PrStatus> = {}): PrStatus => ({
  number: 7,
  state: "OPEN",
  url: "u",
  title: "t",
  isDraft: false,
  checks: "passing",
  headMatches: true,
  aheadOfPr: false,
  ...overrides,
});

describe("carryRebaseTier", () => {
  it("keeps the carried base, counts, conflicts and upstream over a fresh local state", () => {
    const fresh = {
      repo: true,
      branch: "feat",
      worktree: false,
      head: "new",
      changesToken: "c2",
      changedFiles: 1,
      behindBase: 0,
      aheadBase: 0,
      conflicts: false,
    };
    const carried = {
      ...fresh,
      head: "old",
      base: "origin/main",
      behindBase: 3,
      aheadBase: 2,
      conflicts: true,
      upstream: "diverged" as const,
    };
    expect(carryRebaseTier(fresh, carried)).toEqual({
      ...fresh,
      base: "origin/main",
      behindBase: 3,
      aheadBase: 2,
      conflicts: true,
      upstream: "diverged",
    });
    expect(carryRebaseTier(fresh, undefined)).toBe(fresh);
    // Whether HEAD is on a remote is carried only for the same HEAD: a new commit may not be.
    expect(carryRebaseTier(fresh, { ...carried, headOnRemote: true })).not.toHaveProperty(
      "headOnRemote",
    );
    expect(
      carryRebaseTier(fresh, { ...carried, head: "new", headOnRemote: true }).headOnRemote,
    ).toBe(true);
  });
});

describe.skipIf(!hasGit)("GitStateRuntime snapshot without the rebase tier", () => {
  const dirs: Array<string> = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) removeDir(dir);
  });

  it.live("carries the last tier and the PR-elsewhere cue instead of measuring", () =>
    Effect.gen(function* () {
      const root = tempDir();
      dirs.push(root);
      const repo = makeRepo(root);
      run(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
      run(repo, "checkout", "-q", "-b", "feat");
      write(nodePath.join(repo, "f.txt"), "work\n");
      run(repo, "add", "-A");
      run(repo, "commit", "-qm", "work");

      const layer = GitStateRuntimeLive.pipe(
        Layer.provide(
          Layer.succeed(Pr, {
            status: () => Effect.succeed(undefined),
            checks: () => Effect.succeed([]),
            prime: () => Effect.void,
            seenChecks: () => Effect.succeed(undefined),
            detail: () => Effect.succeed({ available: false }),
          }),
        ),
        Layer.provide(ProcLive),
      );
      const runtime = yield* GitStateRuntime.pipe(Effect.provide(layer));
      const measured = yield* runtime.snapshot(repo, { remote: false });
      expect(measured).toMatchObject({ base: "origin/main", aheadBase: 1 });

      const previous = {
        ...measured,
        behindBase: 4,
        aheadBase: 9,
        prElsewhere: {
          number: 41,
          title: "Dark mode",
          url: "https://github.com/acme/web/pull/41",
          repo: "acme/web",
          branch: "feat/dark",
          worktreePath: nodePath.join(root, "dark"),
        },
      };
      const skipped = yield* runtime.snapshot(repo, { remote: false, previous, rebase: false });
      expect(skipped).toMatchObject({ behindBase: 4, aheadBase: 9, base: "origin/main" });
      expect(skipped.prElsewhere?.number).toBe(41);

      const again = yield* runtime.snapshot(repo, { remote: false, previous, rebase: true });
      expect(again).toMatchObject({ behindBase: 0, aheadBase: 1 });
      expect(again.prElsewhere?.number).toBe(41);

      // An edit its watcher didn't report is only seen once the checkout is read again.
      write(nodePath.join(repo, "g.txt"), "more\n");
      const reused = yield* runtime.snapshot(repo, { remote: false, reuseLocal: true });
      expect(reused.changedFiles).toBe(0);
      const read = yield* runtime.snapshot(repo, { remote: false });
      expect(read.changedFiles).toBe(1);
      // Another spelling of the same checkout takes that read, as its one watcher keeps it.
      const link = nodePath.join(root, "link");
      fs.symlinkSync(repo, link, "junction");
      write(nodePath.join(repo, "h.txt"), "more\n");
      const linked = yield* runtime.snapshot(link, { remote: false, reuseLocal: true });
      expect(linked.changedFiles).toBe(1);
    }),
  );
});

describe("fingerprints", () => {
  it("move with their constituents", () => {
    const base = {
      repo: true,
      worktree: false,
      head: "h",
      changesToken: "ct",
      changedFiles: 0,
      base: "origin/main",
      behindBase: 1,
      aheadBase: 2,
      conflicts: false,
    };
    const token = diffToken(base);
    expect(diffToken({ ...base })).toBe(token);
    expect(diffToken({ ...base, changesToken: "ct2" })).not.toBe(token);
    expect(diffToken({ ...base, base: "origin/dev" })).not.toBe(token);
    expect(diffToken({ ...base, behindBase: 9 })).not.toBe(token);
    const fp = prFingerprint(pr({ updatedAt: "2026-01-01T00:00:00Z" }));
    expect(prFingerprint(pr({ updatedAt: "2026-01-01T00:00:00Z" }))).toBe(fp);
    expect(prFingerprint(pr({ updatedAt: "2026-01-02T00:00:00Z" }))).not.toBe(fp);
    expect(prFingerprint(pr({ checks: "failing", updatedAt: "2026-01-01T00:00:00Z" }))).not.toBe(
      fp,
    );
  });
});

describe.skipIf(!hasGit)("local git state", () => {
  const dirs: Array<string> = [];
  const tmp = () => {
    const dir = tempDir();
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) removeDir(dir);
  });

  it.live("reports linked-worktree topology", () =>
    Effect.gen(function* () {
      const root = tmp();
      const repo = makeRepo(root);
      const wt = nodePath.join(repo, ".worktrees", "feat");
      run(repo, "worktree", "add", "-q", "-b", "feat", wt);
      const main = yield* localGitState(repo);
      expect(main).toMatchObject({ repo: true, worktree: false });
      const linked = yield* localGitState(wt);
      expect(linked).toMatchObject({ repo: true, worktree: true, branch: "feat" });
      const sub = nodePath.join(wt, "sub");
      fs.mkdirSync(sub);
      expect((yield* localGitState(sub)).worktree).toBe(true);
      const plain = nodePath.join(root, "plain");
      fs.mkdirSync(plain);
      expect(yield* localGitState(plain)).toMatchObject({ repo: false, worktree: false });
    }).pipe(provide),
  );

  it.live("tracks the branch, changes, and a second edit of a dirty file", () =>
    Effect.gen(function* () {
      const repo = makeRepo(tmp());
      run(repo, "checkout", "-q", "-b", "feat");
      const clean = yield* localGitState(repo);
      expect(clean.branch).toBe("feat");
      expect(clean.pr).toBeUndefined();
      expect([clean.base, clean.behindBase, clean.aheadBase, clean.conflicts]).toEqual([
        undefined,
        0,
        0,
        false,
      ]);
      write(nodePath.join(repo, "b.txt"), "b");
      const dirty = yield* localGitState(repo);
      expect(dirty.changesToken).not.toBe(clean.changesToken);
      expect(dirty.changedFiles).toBe(1);
      write(nodePath.join(repo, "tracked.txt"), "a\nfirst\n");
      const first = yield* localGitState(repo);
      const statusBefore = run(repo, "status", "--porcelain");
      write(nodePath.join(repo, "tracked.txt"), "a\nsecond edit, longer\n");
      const second = yield* localGitState(repo);
      expect(run(repo, "status", "--porcelain")).toBe(statusBefore);
      expect(second.changesToken).not.toBe(first.changesToken);
      // Staging another hunk moves nothing in the porcelain or the working tree, only the index.
      write(nodePath.join(repo, "tracked.txt"), "one\ntwo\n");
      run(repo, "add", "tracked.txt");
      write(nodePath.join(repo, "tracked.txt"), "one\ntwo\nthree\n");
      const partly = yield* localGitState(repo);
      const statusPartly = run(repo, "status", "--porcelain");
      write(nodePath.join(repo, "staged.tmp"), "one\ntwo\nthree-ish\n");
      const blob = run(repo, "hash-object", "-w", "staged.tmp").trim();
      fs.rmSync(nodePath.join(repo, "staged.tmp"));
      run(repo, "update-index", "--cacheinfo", `100644,${blob},tracked.txt`);
      const restaged = yield* localGitState(repo);
      expect(run(repo, "status", "--porcelain")).toBe(statusPartly);
      expect(restaged.changesToken).not.toBe(partly.changesToken);
    }).pipe(provide),
  );

  it.live("measures against the PR base and detects conflicts only when diverged", () =>
    Effect.gen(function* () {
      const repo = makeRepo(tmp());
      write(nodePath.join(repo, "shared.txt"), "base\n");
      run(repo, "add", "-A");
      run(repo, "commit", "-qm", "base");
      run(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
      run(repo, "update-ref", "refs/remotes/origin/develop", "HEAD");
      const rebase = (prBase?: string) =>
        localGitState(repo).pipe(Effect.flatMap((state) => fillRebase(repo, state, prBase)));

      expect((yield* rebase()).base).toBeUndefined();
      run(repo, "checkout", "-q", "-b", "feat");
      write(nodePath.join(repo, "shared.txt"), "feat\n");
      run(repo, "add", "-A");
      run(repo, "commit", "-qm", "feat work");
      expect(yield* rebase()).toMatchObject({
        base: "origin/main",
        behindBase: 0,
        aheadBase: 1,
        conflicts: false,
      });

      run(repo, "checkout", "-q", "main");
      write(nodePath.join(repo, "shared.txt"), "mainline\n");
      run(repo, "add", "-A");
      run(repo, "commit", "-qm", "mainline");
      run(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
      run(repo, "checkout", "-q", "feat");
      expect(yield* rebase()).toMatchObject({ behindBase: 1, aheadBase: 1, conflicts: true });
      expect(yield* rebase("develop")).toMatchObject({
        base: "origin/develop",
        behindBase: 0,
        aheadBase: 1,
        conflicts: false,
      });
      expect((yield* rebase("no-such-base")).base).toBeUndefined();
    }).pipe(provide),
  );

  it.live("classifies the branch against its own origin counterpart", () =>
    Effect.gen(function* () {
      const repo = makeRepo(tmp());
      const measured = () =>
        localGitState(repo).pipe(Effect.flatMap((state) => fillRebase(repo, state, undefined)));
      const upstream = () => measured().pipe(Effect.map((state) => state.upstream));
      const aheadUpstream = () => measured().pipe(Effect.map((state) => state.aheadUpstream));
      expect(yield* upstream()).toBeUndefined();
      run(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
      expect(yield* upstream()).toBe("synced");
      expect(yield* aheadUpstream()).toBeUndefined();
      write(nodePath.join(repo, "f.txt"), "two\n");
      run(repo, "add", "-A");
      run(repo, "commit", "-qm", "two");
      expect(yield* upstream()).toBe("ahead");
      expect(yield* aheadUpstream()).toBe(1);
      run(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
      run(repo, "reset", "-q", "--hard", "HEAD~1");
      expect(yield* upstream()).toBe("behind");
      expect(yield* aheadUpstream()).toBeUndefined();
      run(repo, "checkout", "-q", "--detach", "HEAD");
      write(nodePath.join(repo, "f.txt"), "rewritten\n");
      run(repo, "add", "-A");
      run(repo, "commit", "-qm", "rewritten");
      run(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
      run(repo, "checkout", "-q", "main");
      write(nodePath.join(repo, "f.txt"), "local\n");
      run(repo, "add", "-A");
      run(repo, "commit", "-qm", "local");
      expect(yield* upstream()).toBe("diverged");
      expect(yield* aheadUpstream()).toBe(1);
      run(repo, "checkout", "-q", "--detach", "HEAD");
      expect(yield* upstream()).toBeUndefined();
    }).pipe(provide),
  );

  it.live("says whether a remote-tracking ref holds HEAD", () =>
    Effect.gen(function* () {
      const repo = makeRepo(tmp());
      const onRemote = () =>
        localGitState(repo).pipe(
          Effect.flatMap((state) => fillRebase(repo, state, undefined)),
          Effect.map((state) => state.headOnRemote),
        );
      expect(yield* onRemote()).toBe(false);
      run(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
      expect(yield* onRemote()).toBe(true);
      run(repo, "checkout", "-q", "-b", "feat");
      write(nodePath.join(repo, "feat.txt"), "feat\n");
      run(repo, "add", "-A");
      run(repo, "commit", "-qm", "feat work");
      expect(yield* onRemote()).toBe(false);
      // Any remote ref will do, not only the branch's own or the base.
      run(repo, "update-ref", "refs/remotes/fork/elsewhere", "HEAD");
      expect(yield* onRemote()).toBe(true);
      run(repo, "checkout", "-q", "--detach", "HEAD");
      expect(yield* onRemote()).toBe(true);
    }).pipe(provide),
  );

  it.live("ignores a configured upstream that points at the base", () =>
    Effect.gen(function* () {
      const repo = makeRepo(tmp());
      run(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
      run(repo, "checkout", "-q", "-b", "feat");
      run(repo, "config", "branch.feat.remote", "origin");
      run(repo, "config", "branch.feat.merge", "refs/heads/main");
      write(nodePath.join(repo, "feat.txt"), "feat\n");
      run(repo, "add", "-A");
      run(repo, "commit", "-qm", "feat work");
      run(repo, "checkout", "-q", "main");
      write(nodePath.join(repo, "g.txt"), "mainline\n");
      run(repo, "add", "-A");
      run(repo, "commit", "-qm", "mainline");
      run(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
      run(repo, "checkout", "-q", "feat");
      const state = yield* localGitState(repo).pipe(
        Effect.flatMap((s) => fillRebase(repo, s, undefined)),
      );
      expect(state.upstream).toBeUndefined();
      expect(state).toMatchObject({ behindBase: 1, aheadBase: 1, conflicts: false });
    }).pipe(provide),
  );

  it.live(
    "snapshots the network tier: origin, PR, rebase against the PR base, merged-head suppression",
    () =>
      Effect.gen(function* () {
        const repo = makeRepo(tmp());
        run(repo, "remote", "add", "origin", "git@github.com:acme/web.git");
        // Any fetch the snapshot attempts lands on a missing local path, never the network.
        run(
          repo,
          "config",
          `url.${nodePath.join(repo, "no-such-remote.git")}.insteadOf`,
          "git@github.com:acme/web.git",
        );
        run(repo, "update-ref", "refs/remotes/origin/develop", "HEAD");
        run(repo, "checkout", "-q", "-b", "feat");
        write(nodePath.join(repo, "f.txt"), "work\n");
        run(repo, "add", "-A");
        run(repo, "commit", "-qm", "work");
        const head = run(repo, "rev-parse", "HEAD").trim();

        let badge: PrStatus | undefined = pr({ baseRef: "develop", headRefOid: "someone-else" });
        let failure: string | undefined;
        const layer = GitStateRuntimeLive.pipe(
          Layer.provide(
            Layer.succeed(Pr, {
              status: () =>
                failure === undefined
                  ? Effect.succeed(badge)
                  : Effect.fail(new PrLookupError({ message: failure })),
              checks: () => Effect.succeed([]),
              prime: () => Effect.void,
              seenChecks: () => Effect.succeed(undefined),
              detail: () => Effect.succeed({ available: false }),
            }),
          ),
          Layer.provide(ProcLive),
        );
        const runtime = yield* GitStateRuntime.pipe(Effect.provide(layer));

        const open = yield* runtime.snapshot(repo, { remote: true });
        expect(open).toMatchObject({
          origin: "acme/web",
          branch: "feat",
          base: "origin/develop",
          aheadBase: 1,
        });
        expect(open.pr?.number).toBe(7);

        const local = yield* runtime.snapshot(repo, { remote: false, previous: open });
        expect(local.pr?.number).toBe(7);

        failure = "HTTP 403: API rate limit exceeded for user ID 1.";
        const stale = yield* runtime.snapshot(repo, { remote: true, previous: open });
        expect(stale.pr).toMatchObject({ number: 7, stale: { reason: "rate limited" } });
        const still = yield* runtime.snapshot(repo, { remote: true, previous: stale });
        expect(still.pr?.stale?.since).toBe(stale.pr?.stale?.since);
        failure = undefined;

        badge = pr({ state: "MERGED", baseRef: "develop", headRefOid: head });
        const merged = yield* runtime.snapshot(repo, { remote: true, previous: open });
        expect(merged.pr?.state).toBe("MERGED");
        expect(merged.pr?.stale).toBeUndefined();
        expect([merged.base, merged.aheadBase]).toEqual([undefined, 0]);
      }).pipe(Effect.scoped),
  );
});
