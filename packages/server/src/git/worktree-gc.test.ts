import { spawn } from "node:child_process";
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
import {
  Pr,
  PrLookupError,
  Proc,
  ProcLive,
  ProcSpawnError,
  removeWorktreeDir,
  type ProcOutput,
} from "@gram/git";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { hasGit, makeRepo, removeDir, run, tempDir, write } from "./test-repo.ts";
import {
  ARCHIVED_GRACE_MS,
  anyInside,
  asChecked,
  checkMissingWorktree,
  checkWorktree,
  freeUnlessInUse,
  inUse,
  keepDetachedHead,
  lsofCwds,
  openPrArgs,
  othersCheckouts,
  freeNodeModules,
  processInside,
  MERGED_GRACE_MS,
  sweepDue,
  sweepStep,
  SWEPT_REFS,
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

/** `Pr` answering `answer` for every lookup, or failing with `PrLookupError` on `"fail"`. */
const prAnswering = (answer: PrStatus | undefined | "fail", asked?: { cwd: string }) =>
  Layer.succeed(Pr, {
    status: (cwd) =>
      answer === "fail"
        ? Effect.fail(new PrLookupError({ message: "gh down" }))
        : Effect.sync(() => {
            if (asked !== undefined) asked.cwd = cwd;
            return answer;
          }),
    checks: () => Effect.succeed([]),
    prime: () => Effect.void,
    seenChecks: () => Effect.succeed(undefined),
    detail: () => Effect.succeed({ available: false }),
  });

/** Real git, and gh answering `answer` for every PR lookup. */
const withPr = (answer: PrStatus | undefined) =>
  Effect.provide(Layer.mergeAll(ProcLive, prAnswering(answer)));

const ghOut = (status: number, stdout: string): ProcOutput => ({
  status,
  stdout,
  stderr: "",
  truncated: false,
});

/**
 * Real git, `gh` itself answering `gh` (`"missing"`: not installed) with every call recorded in
 * `calls`, and `Pr` answering `answer`, which a no-PR lookup must never go by.
 */
const withGh = (
  answer: ProcOutput | "missing",
  calls: Array<{ args: ReadonlyArray<string>; cwd: string }> = [],
  pr: PrStatus | undefined | "fail" = undefined,
) =>
  Effect.provide(
    Layer.mergeAll(
      Layer.effect(
        Proc,
        Effect.gen(function* () {
          const live = yield* Proc;
          return {
            run: (bin: string, args: ReadonlyArray<string>, options: { readonly cwd: string }) => {
              if (bin !== "gh") return live.run(bin, args, options as never);
              calls.push({ args, cwd: options.cwd });
              return answer === "missing"
                ? Effect.fail(new ProcSpawnError({ bin, message: "gh not found" }))
                : Effect.succeed(answer);
            },
          };
        }),
      ).pipe(Layer.provide(ProcLive)),
      prAnswering(pr),
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

  it("removes an archived merged worker after the grace, though its badge was dropped", () => {
    // Archived, the publisher drops a thread's state once GitHub answers its PR merged.
    const archived = (finishedAgo: number, overrides: Partial<Thread> = {}) =>
      facts({
        thread: thread({
          completedReason: "prMerged",
          completedAt: NOW - finishedAgo,
          lastActivityAt: NOW - finishedAgo,
          settledMerge: { merged: [{ number: 7, url: "https://github.com/o/r/pull/7" }] },
          ...overrides,
        }),
      });
    expect(sweepDue(archived(MERGED_GRACE_MS - 1), SWEEP, NOW)).toBeUndefined();
    expect(sweepDue(archived(MERGED_GRACE_MS), SWEEP, NOW)).toEqual({ free: false, remove: true });
    // Not merged, or following another PR, or a badge still open: the full M days.
    const later: ReadonlyArray<[string, SweepFacts]> = [
      ["completed by hand", archived(DAY, { completedReason: "user" })],
      ["never completed", facts({ thread: thread({ lastActivityAt: NOW - DAY }) })],
      [
        "following another PR",
        archived(DAY, { extraPrs: [{ repo: "o/lib", number: 9, monitor: false }] }),
      ],
      ["not archived", { ...archived(DAY, { parked: false }), status: "idle" }],
      ["with its PR open again", { ...archived(DAY), badge: badge("OPEN") }],
    ];
    for (const [what, input] of later) {
      expect(sweepDue(input, SWEEP, NOW)?.remove ?? false, what).toBe(false);
    }
  });

  it("removes an archived worker with no PR a day after it was archived", () => {
    const { boundPr: _, ...unbound } = thread();
    const archived = (ago: number) =>
      facts({ thread: { ...unbound, lastActivityAt: NOW - ago, parkedAt: NOW - ago } });
    expect(sweepDue(archived(ARCHIVED_GRACE_MS - 1), SWEEP, NOW)).toBeUndefined();
    expect(sweepDue(archived(ARCHIVED_GRACE_MS), SWEEP, NOW)).toEqual({
      free: false,
      remove: true,
      withoutPr: true,
    });
    expect(sweepDue(archived(5 * DAY), SWEEP, NOW)).toEqual({
      free: true,
      remove: true,
      withoutPr: true,
    });
  });

  it("counts a no-PR worker's grace from its archive, not from when it went quiet", () => {
    const { boundPr: _, ...unbound } = thread();
    // Quiet for three days, archived an hour ago: a day to unarchive it still.
    const justArchived = facts({
      thread: { ...unbound, lastActivityAt: NOW - 3 * DAY, parkedAt: NOW - 3_600_000 },
    });
    expect(sweepDue(justArchived, SWEEP, NOW)).toEqual({ free: true, remove: false });
    // Archived before the time was recorded: it waits the full M days from its last activity.
    const legacy = (ago: number) => facts({ thread: { ...unbound, lastActivityAt: NOW - ago } });
    expect(sweepDue(legacy(3 * DAY), SWEEP, NOW)).toEqual({ free: true, remove: false });
    expect(sweepDue(legacy(14 * DAY), SWEEP, NOW)).toEqual({
      free: true,
      remove: true,
      withoutPr: true,
    });
  });

  it("never removes a thread with a pending wake, which the close would delete", () => {
    const { boundPr: _, ...unbound } = thread();
    const noPr = facts({
      thread: { ...unbound, lastActivityAt: NOW - 5 * DAY, parkedAt: NOW - 5 * DAY },
      hasWake: true,
    });
    // Freeing `node_modules` leaves the thread, and its wake, alone.
    expect(sweepDue(noPr, SWEEP, NOW)).toEqual({ free: true, remove: false });
    const merged = facts({
      thread: thread({
        parked: false,
        completedReason: "prMerged",
        completedAt: NOW - DAY,
        lastActivityAt: NOW - DAY,
      }),
      badge: badge("MERGED"),
      status: "idle",
      hasWake: true,
    });
    expect(sweepDue(merged, SWEEP, NOW)).toBeUndefined();
    expect(sweepDue({ ...merged, hasWake: false }, SWEEP, NOW)).toEqual({
      free: false,
      remove: true,
    });
  });

  it("never removes a thread with no PR that isn't an archived worker", () => {
    const { boundPr: _, ...unbound } = thread();
    // A worker done with no PR that nobody archived: not the sweep's at all.
    const done = facts({
      thread: { ...unbound, parked: false, completedReason: "user", completedAt: NOW - 5 * DAY },
      status: "idle",
    });
    expect(sweepDue(done, SWEEP, NOW)).toBeUndefined();
    // A plain thread archived in Gram's worktree folder is the user's own: never removed unasked.
    const { spawnedBy: _s, ...plain } = unbound;
    expect(sweepDue(facts({ thread: plain }), SWEEP, NOW)).toEqual({
      free: true,
      remove: false,
    });
    // An archived worker that follows a PR, even without a bound one, waits for it as before.
    const following = facts({
      thread: {
        ...unbound,
        lastActivityAt: NOW - 5 * DAY,
        extraPrs: [{ repo: "o/lib", number: 9, monitor: false }],
      },
    });
    expect(sweepDue(following, SWEEP, NOW)).toEqual({ free: true, remove: false });
  });

  it("never touches a thread that isn't finished and at rest in a worktree of its own", () => {
    const { spawnedBy: _, ...plain } = thread();
    const never: ReadonlyArray<[string, SweepFacts]> = [
      ["a plain thread still open for work", facts({ thread: { ...plain, parked: false } })],
      ["an orchestrator", facts({ thread: thread({ role: "orchestrator" }) })],
      [
        // A worker adopting a worktree the user made, outside Gram's own folder.
        "an archived worker with no PR in a worktree Gram didn't make",
        facts({
          thread: (() => {
            const { boundPr: _bound, ...unbound } = thread({
              checkout: { kind: "worktree", path: "/r/wt-mine", branch: "mine", repoRoot: "/r" },
            });
            return unbound;
          })(),
        }),
      ],
      [
        "a merged worker in a worktree Gram didn't make",
        facts({
          thread: thread({
            checkout: { kind: "worktree", path: "/elsewhere/x", branch: "feat/x", repoRoot: "/r" },
            completedReason: "prMerged",
            completedAt: NOW - DAY,
          }),
        }),
      ],
      [
        "a worker in a nested folder below `.worktrees`",
        facts({
          thread: thread({
            checkout: {
              kind: "worktree",
              path: "/r/.worktrees/a/b",
              branch: "feat/x",
              repoRoot: "/r",
            },
          }),
        }),
      ],
      [
        "a worker whose repo isn't known",
        facts({ thread: thread({ checkout: { kind: "worktree", path: PATH, branch: "feat/x" } }) }),
      ],
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
        // As `feat-voice-vocab` was: open, cold between turns, no PR yet, never completed.
        "a live worker with no PR, cold between turns",
        facts({
          thread: (() => {
            const { boundPr: _bound, ...live } = thread({ parked: false });
            return live;
          })(),
        }),
      ],
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

describe("processes inside a worktree", () => {
  it("reads every working folder lsof lists", () => {
    const out = "p1\nn/Users/a/.worktrees/x\np2\nn/\np3\nn/tmp/y (deleted)\nf cwd\n";
    expect(lsofCwds(out)).toEqual(["/Users/a/.worktrees/x", "/", "/tmp/y (deleted)"]);
  });

  it("counts the worktree itself and anything below it, never a sibling", () => {
    expect(anyInside(PATH, PATH, [PATH])).toBe(true);
    expect(anyInside(PATH, PATH, [`${PATH}/node_modules/.bin`])).toBe(true);
    expect(anyInside(PATH, PATH, ["/r/.worktrees/feat-x2", "/r", "/"])).toBe(false);
    // Through a link: the process reports the real folder.
    expect(
      anyInside(PATH, "/private/r/.worktrees/feat-x", ["/private/r/.worktrees/feat-x/apps"]),
    ).toBe(true);
  });

  it.effect("keeps a worktree another thread holds whatever its processes", () =>
    Effect.gen(function* () {
      expect(yield* inUse(PATH, [`${PATH}/`]).pipe(Effect.provide(ProcLive))).toBe(true);
    }),
  );
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
    const withoutPr = { ...due, withoutPr: true as const };
    expect(sweepStep(withoutPr, { ...CLEAN_PUSHED_SETTLED, clean: false })).toBeUndefined();
    expect(sweepStep(withoutPr, { ...CLEAN_PUSHED_SETTLED, pushed: false })).toBeUndefined();
  });

  it("removes a worker with no PR only once GitHub answered none is open for it", () => {
    const withoutPr = { free: false, remove: true, withoutPr: true as const };
    const none: WorktreeCheck = { clean: true, pushed: true, prSettled: false, noPrOpen: true };
    expect(sweepStep(withoutPr, none)).toBe("remove");
    // A PR open for its branch, or a lookup that failed.
    expect(sweepStep(withoutPr, { ...none, noPrOpen: false })).toBeUndefined();
    expect(sweepStep(withoutPr, { clean: true, pushed: true, prSettled: false })).toBeUndefined();
    expect(sweepStep({ ...withoutPr, free: true }, { ...none, noPrOpen: false })).toBe("free");
  });
});

describe("checkMissingWorktree", () => {
  it.effect("has nothing to lose, and asks only whether the PR settled", () =>
    Effect.gen(function* () {
      const asked = { cwd: "" };
      const answering = (answer: PrStatus | undefined) =>
        Effect.provide(Layer.mergeAll(ProcLive, prAnswering(answer, asked)));
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

  it.effect("asks gh itself for an open PR on a no-PR worker's branch, and refuses on doubt", () =>
    Effect.gen(function* () {
      const { boundPr: _bound, ...unbound } = thread();
      const calls: Array<{ args: ReadonlyArray<string>; cwd: string }> = [];
      expect(
        yield* checkMissingWorktree(unbound, undefined, true, true).pipe(
          withGh(ghOut(0, "[]\n"), calls),
        ),
      ).toEqual({ clean: true, pushed: true, prSettled: false, noPrOpen: true });
      expect(calls).toEqual([{ args: openPrArgs({ branch: "feat/x" }), cwd: "/r" }]);
      const refused: ReadonlyArray<[string, ReturnType<typeof withGh>]> = [
        ["an open PR", withGh(ghOut(0, '[{"number":5}]'))],
        ["gh signed out", withGh(ghOut(1, ""))],
        ["gh not installed", withGh("missing")],
        ["gh answering garbage", withGh(ghOut(0, "not json"))],
      ];
      for (const [what, layer] of refused) {
        const check = yield* checkMissingWorktree(unbound, undefined, true, true).pipe(layer);
        expect(check.noPrOpen, what).toBe(false);
      }
      // No branch recorded: nothing to ask, so no.
      const { branch: _b, ...noBranch } = unbound.checkout;
      const lost = yield* checkMissingWorktree(
        { ...unbound, checkout: noBranch },
        undefined,
        true,
        true,
      ).pipe(withGh(ghOut(0, "[]")));
      expect(lost.noPrOpen).toBe(false);
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

  it.effect("reads no PR open only on gh's own empty answer, never on an unready Pr.status", () =>
    Effect.gen(function* () {
      const { tree } = setup();
      const { boundPr: _, ...unbound } = thread();
      const calls: Array<{ args: ReadonlyArray<string>; cwd: string }> = [];
      expect(
        yield* checkWorktree(tree, unbound, true, true).pipe(withGh(ghOut(0, "[]"), calls)),
      ).toEqual({ clean: true, pushed: true, prSettled: false, noPrOpen: true });
      expect(calls.map((call) => call.args)).toEqual([openPrArgs({ branch: "feat/x" })]);
      // `Pr.status` answers `undefined` when gh isn't ready: that must never read as "none".
      const unready: ReadonlyArray<[string, ReturnType<typeof withGh>]> = [
        ["gh signed out", withGh(ghOut(1, ""), [], undefined)],
        ["gh not installed", withGh("missing", [], undefined)],
        ["gh timing out", withGh(ghOut(-1, ""), [], undefined)],
        ["an open PR", withGh(ghOut(0, '[{"number":5}]'), [], undefined)],
      ];
      for (const [what, layer] of unready) {
        const check = yield* checkWorktree(tree, unbound, true, true).pipe(layer);
        expect(check.noPrOpen, what).toBe(false);
        expect(sweepStep({ free: false, remove: true, withoutPr: true }, check), what).toBe(
          undefined,
        );
      }
      // A detached HEAD, as a reviewer's, is looked up by its commit.
      const head = run(tree, "rev-parse", "HEAD").trim();
      run(tree, "checkout", "-q", "--detach");
      const detached: Array<{ args: ReadonlyArray<string>; cwd: string }> = [];
      yield* checkWorktree(tree, unbound, true, true).pipe(withGh(ghOut(0, "[]"), detached));
      expect(detached.map((call) => call.args)).toEqual([openPrArgs({ head })]);
    }),
  );

  it.effect(
    "keeps a detached HEAD under a ref before its worktree goes, and nothing for a branch",
    () =>
      Effect.gen(function* () {
        const { repo, tree } = setup();
        expect(yield* keepDetachedHead(tree, "t-1").pipe(Effect.provide(ProcLive))).toBe(true);
        expect(run(repo, "for-each-ref", SWEPT_REFS)).toBe("");
        // A reviewer's detached HEAD with a commit only a remote branch holds.
        run(tree, "checkout", "-q", "--detach");
        write(nodePath.join(tree, "fix.txt"), "fix\n");
        run(tree, "add", "-A");
        run(tree, "commit", "-qm", "review fix");
        run(tree, "push", "-q", "origin", "HEAD:refs/heads/review-fix");
        const head = run(tree, "rev-parse", "HEAD").trim();
        expect(yield* keepDetachedHead(tree, "t-1").pipe(Effect.provide(ProcLive))).toBe(true);
        run(repo, "worktree", "remove", tree);
        // The remote branch is deleted and pruned: the ref still holds the commit.
        run(repo, "push", "-q", "origin", "--delete", "review-fix");
        run(repo, "fetch", "-q", "--prune", "origin");
        expect(run(repo, "rev-parse", `${SWEPT_REFS}/t-1`).trim()).toBe(head);
        // Somewhere git can't run: refuses, and the sweep keeps the worktree.
        expect(
          yield* keepDetachedHead(nodePath.join(repo, "no-such"), "t-2").pipe(
            Effect.provide(ProcLive),
          ),
        ).toBe(false);
      }),
  );

  it.effect(
    "reads untracked files hidden by status.showUntrackedFiles=no, and git keeps them",
    () =>
      Effect.gen(function* () {
        const { repo, tree } = setup();
        run(tree, "config", "status.showUntrackedFiles", "no");
        write(nodePath.join(tree, "report.md"), "uncommitted report\n");
        // The user's own status hides it.
        expect(run(tree, "status", "--porcelain")).toBe("");
        const check = yield* checkWorktree(tree, thread(), true).pipe(withPr(badge("MERGED")));
        expect(check.clean).toBe(false);
        expect(sweepStep({ free: true, remove: true }, check)).toBeUndefined();
        // And the removal the sweep and the close share refuses it on its own.
        const removed = yield* removeWorktreeDir(repo, tree, false).pipe(
          Effect.provide(ProcLive),
          Effect.result,
        );
        expect(removed._tag).toBe("Failure");
        expect(fs.readFileSync(nodePath.join(tree, "report.md"), "utf8")).toBe(
          "uncommitted report\n",
        );
      }),
  );

  it.effect.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
    "never touches a file in a worktree a process works in, node_modules included",
    () =>
      Effect.gen(function* () {
        const { tree } = setup();
        const deps = nodePath.join(tree, "node_modules", "a");
        write(nodePath.join(deps, "index.js"), "a\n");
        // A process the threads know nothing about, like an agent's or a dev server's, works in it.
        const child = spawn("sleep", ["60"], { cwd: deps, stdio: "ignore" });
        try {
          yield* Effect.promise(
            () => new Promise<void>((resolve) => child.once("spawn", () => resolve())),
          );
          expect(yield* processInside(tree).pipe(Effect.provide(ProcLive))).toBe(true);
          expect(yield* freeUnlessInUse(tree, []).pipe(Effect.provide(ProcLive))).toBeUndefined();
          expect(fs.existsSync(nodePath.join(deps, "index.js"))).toBe(true);
        } finally {
          child.kill();
        }
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve) =>
              child.exitCode !== null || child.signalCode !== null
                ? resolve()
                : child.once("exit", () => resolve()),
            ),
        );
        // With it gone, the same step frees them.
        expect(yield* processInside(tree).pipe(Effect.provide(ProcLive))).toBe(false);
        expect(yield* freeUnlessInUse(tree, []).pipe(Effect.provide(ProcLive))).toBe(1);
        expect(fs.existsSync(nodePath.join(tree, "node_modules"))).toBe(false);
      }),
    15_000,
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
