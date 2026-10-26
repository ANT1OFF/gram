import { afterAll, describe, expect, it } from "@effect/vitest";
import { initialBabysitState } from "@gram/contracts";
import { Pr, PrActionError, type RepoMergeSettings } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { prHandlers } from "../rpc/handlers/pr.ts";
import { makeRuntimeTestLayer } from "../runtime/test-harness.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { gitPlatformTest } from "./platform.ts";
import { PrActions } from "./pr-actions.ts";
import { GitStatePublisherLive } from "./publisher.ts";
import { eventually, hasGit, makeRepo, removeDir, tempDir } from "./test-repo.ts";

const calls: Array<ReadonlyArray<unknown>> = [];
const settings: RepoMergeSettings = { strategies: ["squash", "rebase"], autoMerge: true };

const FakeActions = Layer.succeed(PrActions, {
  merge: (workTree, repo, number, strategy, auto) =>
    Effect.sync(() => void calls.push(["merge", workTree, repo, number, strategy, auto])).pipe(
      // Like `gh pr merge` timing out after GitHub merged: it acts, then exits non-zero.
      Effect.andThen(
        strategy === "merge"
          ? Effect.fail(new PrActionError({ message: "gh pr merge timed out" }))
          : Effect.void,
      ),
    ),
  setDraft: (workTree, repo, number, draft) =>
    Effect.sync(() => void calls.push(["setDraft", workTree, repo, number, draft])),
  close: (workTree, repo, number) =>
    Effect.sync(() => void calls.push(["close", workTree, repo, number])),
  reopen: (workTree, repo, number) =>
    Effect.sync(() => void calls.push(["reopen", workTree, repo, number])),
  updateBranch: (workTree, repo, number) =>
    Effect.sync(() => void calls.push(["updateBranch", workTree, repo, number])),
  mergeSettings: (workTree, repo) =>
    Effect.sync(() => {
      calls.push(["mergeSettings", workTree, repo]);
      return settings;
    }),
});

/** Badge lookups, counted: the publisher's remote refresh after a write runs one. */
let statusCalls = 0;
const CountingPr = Layer.succeed(Pr, {
  status: () =>
    Effect.sync(() => {
      statusCalls++;
      return undefined;
    }),
  checks: () => Effect.succeed([]),
  prime: () => Effect.void,
  seenChecks: () => Effect.succeed(undefined),
  detail: () => Effect.succeed({ available: false }),
});

const TestLayer = GitStatePublisherLive.pipe(
  Layer.provideMerge(makeRuntimeTestLayer()),
  Layer.provideMerge(gitPlatformTest({ pr: CountingPr, prActions: FakeActions })),
);

describe.skipIf(!hasGit)("pr.* RPCs", () => {
  const dirs: Array<string> = [];
  afterAll(() => {
    for (const dir of dirs) removeDir(dir);
  });

  const setup = Effect.gen(function* () {
    const dir = tempDir();
    dirs.push(dir);
    const repo = makeRepo(dir);
    const runtimes = yield* ThreadRuntimes;
    const thread = yield* runtimes.create({
      projectRoot: repo,
      checkout: { kind: "main", path: repo },
    });
    return { repo, thread, handlers: yield* prHandlers, runtimes };
  });

  it.live("merge, ready, close and reopen the bound PR in its repo", () =>
    Effect.gen(function* () {
      const { repo, thread, handlers, runtimes } = yield* setup;
      const threadId = thread.id;
      expect(
        yield* handlers["pr.merge"]({ threadId, strategy: "squash" }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "InvalidState", message: "This thread has no pull request" });

      yield* runtimes.updateThread(threadId, (t) => ({
        ...t,
        boundPr: { repo: "acme/web", number: 12, monitor: false },
      }));
      calls.length = 0;
      expect(yield* handlers["pr.mergeOptions"]({ threadId })).toEqual({
        strategies: ["squash", "rebase"],
        autoMerge: true,
        babysit: false,
      });
      yield* handlers["pr.merge"]({ threadId, strategy: "squash" });
      yield* handlers["pr.merge"]({ threadId, strategy: "rebase", auto: true });
      yield* handlers["pr.ready"]({ threadId, draft: true });
      yield* handlers["pr.close"]({ threadId });
      yield* handlers["pr.reopen"]({ threadId });
      yield* handlers["pr.updateBranch"]({ threadId });
      expect(calls).toEqual([
        ["mergeSettings", repo, "acme/web"],
        ["merge", repo, "acme/web", 12, "squash", false],
        ["merge", repo, "acme/web", 12, "rebase", true],
        ["setDraft", repo, "acme/web", 12, true],
        ["close", repo, "acme/web", 12],
        ["reopen", repo, "acme/web", 12],
        ["updateBranch", repo, "acme/web", 12],
      ]);

      const lookupsBefore = statusCalls;
      expect(
        yield* handlers["pr.merge"]({ threadId, strategy: "merge" }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "GitError", message: "gh pr merge timed out" });
      expect(calls.at(-1)).toEqual(["merge", repo, "acme/web", 12, "merge", false]);
      // gh can fail after GitHub already merged, so the badge refreshes anyway.
      yield* eventually(
        "a badge refresh after the failed merge",
        Effect.sync(() => statusCalls > lookupsBefore),
      );
    }).pipe(Effect.provide(TestLayer)),
  );

  it.live("refuses auto-merge in babysit mode but still merges by hand", () =>
    Effect.gen(function* () {
      const { repo, thread, handlers, runtimes } = yield* setup;
      const threadId = thread.id;
      yield* runtimes.updateThread(threadId, (t) => ({
        ...t,
        boundPr: { repo: "acme/web", number: 12, monitor: true },
        babysit: initialBabysitState(Date.now()),
      }));
      calls.length = 0;
      expect((yield* handlers["pr.mergeOptions"]({ threadId })).babysit).toBe(true);
      expect(
        yield* handlers["pr.merge"]({ threadId, strategy: "squash", auto: true }).pipe(Effect.flip),
      ).toMatchObject({
        _tag: "InvalidState",
        message: "Auto-merge isn't allowed in babysit mode; merge by hand.",
      });
      yield* handlers["pr.merge"]({ threadId, strategy: "squash" });
      expect(calls.at(-1)).toEqual(["merge", repo, "acme/web", 12, "squash", false]);
    }).pipe(Effect.provide(TestLayer)),
  );
});
