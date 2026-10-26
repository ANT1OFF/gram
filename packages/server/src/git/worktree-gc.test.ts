import * as fs from "node:fs";
import * as nodePath from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import type {
  PrStatus,
  ProjectId,
  Thread,
  ThreadId,
  ThreadStatus,
  WorkspaceId,
} from "@gram/contracts";
import { Pr, ProcLive } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { hasGit, makeRepo, removeDir, run, tempDir, write } from "./test-repo.ts";
import {
  asChecked,
  checkMissingWorktree,
  checkWorktree,
  othersCheckouts,
  freeNodeModules,
  MERGED_GRACE_MS,
  sweepDue,
  sweepStep,
  type SweepFacts,
  type WorktreeCheck,
} from "./worktree-gc.ts";

const DAY = 86_400_000;
const NOW = 100 * DAY;
const SWEEP = { freeAfterDays: 3, removeAfterDays: 14 };
const PATH = "/r/.worktrees/feat-x";

const thread = (overrides: Partial<Thread> = {}): Thread => ({
  id: "t-worker" as ThreadId,
  projectId: "p-1" as ProjectId,
  title: "Worker",
  userNamed: false,
  model: { agent: "claude", model: "opus" },
  mode: "auto",
  checkout: { kind: "worktree", path: PATH, branch: "feat/x", repoRoot: "/r" },
  labels: [],
  pinned: false,
  parked: true,
  unread: false,
  workspaceId: "ws-1" as WorkspaceId,
  spawnedBy: { threadId: "t-orch" as ThreadId, feature: "x" },
  boundPr: { repo: "o/r", number: 7, monitor: false },
  createdAt: 0,
  lastActivityAt: NOW - 20 * DAY,
  ...overrides,
});

const badge = (state: PrStatus["state"], headRefOid?: string): PrStatus => ({
  number: 7,
  state,
  url: "https://github.com/o/r/pull/7",
  title: "t",
  isDraft: false,
  checks: "passing",
  headMatches: true,
  aheadOfPr: false,
  ...(headRefOid === undefined ? {} : { headRefOid }),
});

const facts = (overrides: Partial<SweepFacts> = {}): SweepFacts => ({
  thread: thread(),
  status: "cold",
  pendingRequests: 0,
  busy: false,
  git: undefined,
  badge: undefined,
  heldByOthers: [],
  ...overrides,
});

/** Real git, and gh answering `answer` for every PR lookup. */
const withPr = (answer: PrStatus | undefined) =>
  Effect.provide(
    Layer.mergeAll(
      ProcLive,
      Layer.succeed(Pr, {
        status: () => Effect.succeed(answer),
        checks: () => Effect.succeed([]),
        prime: () => Effect.void,
        seenChecks: () => Effect.succeed(undefined),
        detail: () => Effect.succeed({ available: false }),
      }),
    ),
  );

const CLEAN_PUSHED_SETTLED: WorktreeCheck = { clean: true, pushed: true, prSettled: true };

describe("sweepDue", () => {
  it("frees an archived or merged worker after N days and removes it after M", () => {
    expect(sweepDue(facts(), SWEEP, NOW)).toEqual({ free: true, remove: true });
    const merged = facts({
      thread: thread({ parked: false, completedReason: "prMerged" }),
      badge: badge("MERGED"),
      status: "idle",
    });
    expect(sweepDue(merged, SWEEP, NOW)).toEqual({ free: true, remove: true });
    const young = facts({ thread: thread({ lastActivityAt: NOW - 5 * DAY }) });
    expect(sweepDue(young, SWEEP, NOW)).toEqual({ free: true, remove: false });
    const fresh = facts({ thread: thread({ lastActivityAt: NOW - DAY }) });
    expect(sweepDue(fresh, SWEEP, NOW)).toBeUndefined();
    // Counted from completion when that came after the last activity.
    const completed = facts({ thread: thread({ completedAt: NOW - DAY }) });
    expect(sweepDue(completed, SWEEP, NOW)).toBeUndefined();
  });

  it("removes a merged thread's worktree once the grace has passed, not after M days", () => {
    const merged = (finishedAgo: number) =>
      facts({
        thread: thread({
          parked: false,
          completedReason: "prMerged",
          completedAt: NOW - finishedAgo,
          lastActivityAt: NOW - finishedAgo,
        }),
        badge: badge("MERGED"),
        status: "idle",
      });
    expect(sweepDue(merged(MERGED_GRACE_MS - 1), SWEEP, NOW)).toBeUndefined();
    expect(sweepDue(merged(MERGED_GRACE_MS), SWEEP, NOW)).toEqual({ free: false, remove: true });
    // A plain thread whose PR closed unmerged still waits the full M days.
    const { spawnedBy: _, ...plain } = thread({ parked: false, lastActivityAt: NOW - 5 * DAY });
    const closed = facts({
      thread: plain,
      badge: badge("CLOSED"),
      status: "idle",
    });
    expect(sweepDue(closed, SWEEP, NOW)).toEqual({ free: true, remove: false });
  });

  it("takes a plain thread once archived or its PRs settled", () => {
    const { spawnedBy: _, workspaceId: _w, ...plain } = thread();
    expect(sweepDue(facts({ thread: plain }), SWEEP, NOW)).toEqual({ free: true, remove: true });
    const mergedPlain = facts({
      thread: { ...plain, parked: false, completedReason: "prMerged", completedAt: NOW - DAY },
      badge: badge("MERGED"),
      status: "idle",
    });
    expect(sweepDue(mergedPlain, SWEEP, NOW)).toEqual({ free: false, remove: true });
    const working = facts({ thread: { ...plain, parked: false }, status: "idle" });
    expect(sweepDue(working, SWEEP, NOW)).toBeUndefined();
    const inReview = facts({ thread: { ...plain, parked: false }, badge: badge("OPEN") });
    expect(sweepDue(inReview, SWEEP, NOW)).toBeUndefined();
    // A plain thread in a worktree Gram didn't make is never the sweep's.
    const elsewhere = facts({
      thread: { ...plain, checkout: { kind: "worktree", path: "/tmp/agent-wt", repoRoot: "/r" } },
    });
    expect(sweepDue(elsewhere, SWEEP, NOW)).toBeUndefined();
  });

  it("never removes a worker with no PR to ask about, only frees it", () => {
    const { boundPr: _, ...unbound } = thread();
    expect(sweepDue(facts({ thread: unbound }), SWEEP, NOW)).toEqual({
      free: true,
      remove: false,
    });
  });

  it("never touches a thread that isn't finished and at rest in a worktree of its own", () => {
    const { spawnedBy: _, ...plain } = thread();
    const never: ReadonlyArray<[string, SweepFacts]> = [
      ["a plain thread still open for work", facts({ thread: { ...plain, parked: false } })],
      ["an orchestrator", facts({ thread: thread({ role: "orchestrator" }) })],
      [
        "the main checkout",
        facts({ thread: thread({ checkout: { kind: "main", path: "/r", branch: "main" } }) }),
      ],
      [
        "a worktree kind at the repo root",
        facts({
          thread: thread({ checkout: { kind: "worktree", path: "/r", repoRoot: "/r" } }),
        }),
      ],
      [
        "a worker spanning repos",
        facts({
          thread: thread({ extraCheckouts: [{ kind: "worktree", path: "/other/.worktrees/x" }] }),
        }),
      ],
      ["a worker waiting on the user", facts({ pendingRequests: 1 })],
      ["a worker with background work", facts({ busy: true })],
      ["a checkout another thread holds", facts({ heldByOthers: ["/r/.worktrees/feat-x/"] })],
      [
        "a worker that followed its agent elsewhere",
        facts({
          thread: thread({ currentCheckout: { kind: "worktree", path: "/r/.worktrees/y" } }),
        }),
      ],
      [
        "a checkout another thread followed its agent into",
        facts({
          heldByOthers: othersCheckouts(
            [
              thread(),
              thread({
                id: "t-main" as ThreadId,
                checkout: { kind: "main", path: "/r" },
                currentCheckout: { kind: "worktree", path: PATH },
              }),
            ],
            thread().id,
          ),
        }),
      ],
      [
        "a worker still in review",
        facts({ thread: thread({ parked: false }), badge: badge("OPEN"), status: "idle" }),
      ],
      ["a worker that only went idle", facts({ thread: thread({ parked: false }) })],
      [
        "a worker reopened since its merge",
        facts({
          thread: thread({
            parked: false,
            settledMerge: { merged: [{ number: 7, url: "https://github.com/o/r/pull/7" }] },
          }),
          badge: badge("MERGED"),
          status: "idle",
        }),
      ],
      [
        "a merged worker with a followed PR still open",
        facts({
          thread: thread({
            parked: false,
            completedReason: "prMerged",
            extraPrs: [{ repo: "o/lib", number: 9, monitor: false }],
          }),
          badge: badge("MERGED"),
          extraBadges: [{ ...badge("OPEN"), number: 9, url: "https://github.com/o/lib/pull/9" }],
          status: "idle",
        }),
      ],
    ];
    for (const [what, input] of never) expect(sweepDue(input, SWEEP, NOW), what).toBeUndefined();
    const live: ReadonlyArray<ThreadStatus> = [
      "starting",
      "running",
      "needsApproval",
      "needsInput",
      "error",
    ];
    for (const status of live) {
      expect(sweepDue(facts({ status }), SWEEP, NOW), status).toBeUndefined();
    }
  });
});

describe("asChecked", () => {
  it("holds only while the worker is in the checked checkout and nothing that made it due moved", () => {
    const checked = thread();
    const guard = asChecked(checked);
    expect(guard.expectedCheckout).toBe(PATH);
    expect(guard.stillHolds?.(checked)).toBe(true);
    expect(guard.stillHolds?.(thread({ lastActivityAt: NOW }))).toBe(false);
    expect(guard.stillHolds?.(thread({ parked: false }))).toBe(false);
    expect(guard.stillHolds?.(thread({ completedAt: NOW, completedReason: "user" }))).toBe(false);
    const { spawnedBy: _, ...detached } = checked;
    expect(guard.stillHolds?.(detached)).toBe(false);
  });
});

describe("sweepStep", () => {
  const due = { free: true, remove: true };

  it("removes only a clean, pushed worktree whose PR is merged or closed", () => {
    expect(sweepStep(due, CLEAN_PUSHED_SETTLED)).toBe("remove");
    expect(sweepStep(due, { ...CLEAN_PUSHED_SETTLED, prSettled: false })).toBe("free");
    expect(
      sweepStep({ free: false, remove: true }, { ...CLEAN_PUSHED_SETTLED, prSettled: false }),
    ).toBeUndefined();
    expect(sweepStep({ free: true, remove: false }, CLEAN_PUSHED_SETTLED)).toBe("free");
  });

  it("never acts on uncommitted or unpushed work", () => {
    expect(sweepStep(due, { ...CLEAN_PUSHED_SETTLED, clean: false })).toBeUndefined();
    expect(sweepStep(due, { ...CLEAN_PUSHED_SETTLED, pushed: false })).toBeUndefined();
  });
});

describe("checkMissingWorktree", () => {
  it.effect("has nothing to lose, and asks only whether the PR settled", () =>
    Effect.gen(function* () {
      const asked = { cwd: "" };
      const answering = (answer: PrStatus | undefined) =>
        Effect.provide(
          Layer.succeed(Pr, {
            status: (cwd) => Effect.sync(() => ((asked.cwd = cwd), answer)),
            checks: () => Effect.succeed([]),
            prime: () => Effect.void,
            seenChecks: () => Effect.succeed(undefined),
            detail: () => Effect.succeed({ available: false }),
          }),
        );
      // A bound PR is asked about from the main checkout, the one folder git can run in.
      expect(
        yield* checkMissingWorktree(thread(), undefined, true).pipe(answering(badge("MERGED"))),
      ).toEqual(CLEAN_PUSHED_SETTLED);
      expect(asked.cwd).toBe("/r");
      expect(
        yield* checkMissingWorktree(thread(), badge("MERGED"), true).pipe(answering(badge("OPEN"))),
      ).toEqual({ clean: true, pushed: true, prSettled: false });
      // Unbound, the branch's PR can't be looked up without the folder: the last badge says.
      const { boundPr: _bound, ...unbound } = thread();
      asked.cwd = "";
      expect(
        yield* checkMissingWorktree(unbound, badge("CLOSED"), true).pipe(answering(undefined)),
      ).toEqual(CLEAN_PUSHED_SETTLED);
      expect(asked.cwd).toBe("");
      expect(
        (yield* checkMissingWorktree(unbound, undefined, true).pipe(answering(undefined)))
          .prSettled,
      ).toBe(false);
      expect(
        yield* checkMissingWorktree(thread(), undefined, false).pipe(answering(badge("MERGED"))),
      ).toEqual({ clean: true, pushed: true, prSettled: false });
    }),
  );
});

describe.skipIf(!hasGit)("the sweep's git", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) removeDir(dir);
  });

  /** A repo with a bare origin and a pushed worktree on `feat/x`. */
  const setup = () => {
    const dir = tempDir();
    dirs.push(dir);
    const repo = makeRepo(dir);
    const origin = nodePath.join(dir, "origin.git");
    run(dir, "init", "-q", "--bare", origin);
    run(repo, "remote", "add", "origin", origin);
    const tree = nodePath.join(repo, ".worktrees", "feat-x");
    run(repo, "worktree", "add", "-q", "-b", "feat/x", tree);
    run(tree, "push", "-q", "-u", "origin", "feat/x");
    return { repo, tree };
  };

  it.effect("reads clean and pushed, then dirty, then unpushed, and a squash-merged head", () =>
    Effect.gen(function* () {
      const { tree } = setup();
      const merged = badge("MERGED");
      expect(yield* checkWorktree(tree, thread(), true).pipe(withPr(merged))).toEqual(
        CLEAN_PUSHED_SETTLED,
      );
      write(nodePath.join(tree, "scratch.txt"), "x\n");
      expect((yield* checkWorktree(tree, thread(), false).pipe(withPr(merged))).clean).toBe(false);
      run(tree, "add", "-A");
      run(tree, "commit", "-qm", "local only");
      const local = yield* checkWorktree(tree, thread(), true).pipe(withPr(badge("OPEN")));
      expect(local).toEqual({ clean: true, pushed: false, prSettled: false });
      // GitHub deleted the branch after a squash merge; HEAD is still the PR's head.
      const head = run(tree, "rev-parse", "HEAD").trim();
      run(tree, "update-ref", "-d", "refs/remotes/origin/feat/x");
      expect(
        yield* checkWorktree(tree, thread(), true).pipe(withPr(badge("CLOSED", head))),
      ).toEqual(CLEAN_PUSHED_SETTLED);
    }),
  );

  it.effect("frees untracked node_modules at the top and in packages, never tracked ones", () =>
    Effect.gen(function* () {
      const { tree } = setup();
      write(nodePath.join(tree, "node_modules", "a", "index.js"), "a\n");
      write(nodePath.join(tree, "apps", "web", "node_modules", "b", "index.js"), "b\n");
      write(nodePath.join(tree, "vendor", "node_modules", "kept.js"), "kept\n");
      run(tree, "add", "-f", "vendor/node_modules/kept.js");
      run(tree, "commit", "-qm", "vendored");
      // A link named node_modules is left, and what it points at is never followed.
      const target = nodePath.join(tree, "..", "elsewhere");
      write(nodePath.join(target, "precious.txt"), "p\n");
      fs.mkdirSync(nodePath.join(tree, "tools"));
      fs.symlinkSync(target, nodePath.join(tree, "tools", "node_modules"), "junction");
      // A submodule's own index is the only one that knows what it tracks, so it is never entered.
      write(nodePath.join(tree, "libs", "sub", ".git"), "gitdir: ../../.git/modules/sub\n");
      write(nodePath.join(tree, "libs", "sub", "node_modules", "tracked.js"), "t\n");

      expect(yield* freeNodeModules(tree).pipe(Effect.provide(ProcLive))).toBe(2);
      expect(fs.existsSync(nodePath.join(tree, "node_modules"))).toBe(false);
      expect(fs.existsSync(nodePath.join(tree, "apps", "web", "node_modules"))).toBe(false);
      expect(fs.existsSync(nodePath.join(tree, "vendor", "node_modules", "kept.js"))).toBe(true);
      expect(fs.existsSync(nodePath.join(target, "precious.txt"))).toBe(true);
      expect(fs.existsSync(nodePath.join(tree, "libs", "sub", "node_modules", "tracked.js"))).toBe(
        true,
      );
    }),
  );
});
