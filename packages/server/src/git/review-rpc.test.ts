import * as fs from "node:fs";
import * as nodePath from "node:path";
import { afterAll, describe, expect, it } from "@effect/vitest";
import type { PrReview, PrStatus, ReviewBot } from "@gram/contracts";
import { applySuggestion, ReviewActionError } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ThreadStore } from "../persistence/thread-store.ts";
import { gitHandlers } from "../rpc/handlers/git.ts";
import { makeRuntimeTestLayer } from "../runtime/test-harness.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { gitPlatformTest } from "./platform.ts";
import { GitStatePublisher, GitStatePublisherLive } from "./publisher.ts";
import { PrReviews } from "./review.ts";
import { hasGit, makeRepo, removeDir, tempDir, write } from "./test-repo.ts";

const calls: Array<{ op: string; args: ReadonlyArray<unknown> }> = [];

const review = (bots: ReadonlyArray<ReviewBot>): PrReview => ({
  available: true,
  pr: {
    number: 12,
    url: "https://github.com/acme/web/pull/12",
    headRefOid: "abc",
    reviewDecision: "CHANGES_REQUESTED",
    mergeStateStatus: "BLOCKED",
  },
  threads: [
    {
      id: "PRRT_1",
      path: "tracked.txt",
      line: 1,
      isResolved: false,
      isOutdated: false,
      severity: "suggestion",
      byBot: true,
      comments: [
        {
          id: "PRRC_1",
          author: bots[0]?.loginPattern ?? "bot",
          body: "[suggestion] Shout.\n```suggestion\nTRACKED\n```",
          createdAt: "2026-09-16T10:00:00Z",
          url: "https://github.com/acme/web/pull/12#discussion_r1",
          suggestion: "TRACKED",
        },
        {
          id: "PRRC_2",
          author: "human-1",
          body: "Agreed",
          createdAt: "2026-09-16T10:01:00Z",
          url: "https://github.com/acme/web/pull/12#discussion_r2",
        },
      ],
    },
    {
      id: "PRRT_2",
      path: "tracked.txt",
      isResolved: false,
      isOutdated: true,
      severity: "blocker",
      byBot: true,
      comments: [
        {
          id: "PRRC_3",
          author: "example-code-review",
          body: "[blocker] Old code.\n```suggestion\nx\n```",
          createdAt: "2026-09-16T10:00:00Z",
          url: "https://github.com/acme/web/pull/12#discussion_r3",
          suggestion: "x",
        },
      ],
    },
  ],
});

/** An open PR's badge that `bots` reviewed. */
const badge = (url: string, number: number, bots: ReadonlyArray<string>): PrStatus => ({
  number,
  state: "OPEN",
  url,
  title: "t",
  isDraft: false,
  checks: "passing",
  headMatches: true,
  aheadOfPr: false,
  review: {
    bots,
    reviewedHead: true,
    roundInFlight: false,
    threads: { unresolved: 0, blockers: 0, suggestions: 0, outdatedUnresolved: 0 },
  },
});

const FakeReviews = Layer.succeed(PrReviews, {
  fetch: (workTree, repo, number, bots) =>
    Effect.sync(() => {
      calls.push({ op: "fetch", args: [workTree, repo, number, bots] });
      return review(bots);
    }),
  reply: (workTree, reviewThreadId, body) =>
    Effect.sync(() => {
      calls.push({ op: "reply", args: [workTree, reviewThreadId, body] });
      return { id: "PRRC_9", author: "me", body, createdAt: "2026-09-16T10:02:00Z", url: "u" };
    }),
  resolve: (workTree, reviewThreadId) =>
    reviewThreadId === "PRRT_gone"
      ? Effect.fail(new ReviewActionError({ message: "Could not resolve to a node" }))
      : Effect.sync(() => void calls.push({ op: "resolve", args: [workTree, reviewThreadId] })),
  comment: (workTree, repo, number, body) =>
    Effect.sync(() => void calls.push({ op: "comment", args: [workTree, repo, number, body] })),
  applySuggestion,
  rerun: () => Effect.fail(new ReviewActionError({ message: "no network in tests" })),
  isPushed: () => Effect.succeed(undefined),
});

const TestLayer = GitStatePublisherLive.pipe(
  Layer.provideMerge(makeRuntimeTestLayer()),
  Layer.provideMerge(gitPlatformTest({ prReviews: FakeReviews })),
);

describe.skipIf(!hasGit)("review-bot RPCs", () => {
  const dirs: Array<string> = [];
  afterAll(() => {
    for (const dir of dirs) removeDir(dir);
  });

  const setup = Effect.gen(function* () {
    const store = yield* ThreadStore;
    yield* store.updateSettings((settings) => ({
      ...settings,
      reviewBots: [
        {
          loginPattern: "example-code-review[bot]",
          rereviewCommand: "/agent review",
          canApprove: true,
        },
      ],
    }));
    const dir = tempDir();
    dirs.push(dir);
    const repo = makeRepo(dir);
    const runtimes = yield* ThreadRuntimes;
    const thread = yield* runtimes.create({
      projectRoot: repo,
      checkout: { kind: "main", path: repo },
    });
    return { repo, thread, handlers: yield* gitHandlers, runtimes };
  });

  it.live("need a PR, then fetch the review for the bound PR with the configured bots", () =>
    Effect.gen(function* () {
      const { repo, thread, handlers, runtimes } = yield* setup;
      calls.length = 0;
      expect(yield* handlers["git.prReview"]({ threadId: thread.id })).toEqual({
        available: true,
        threads: [],
      });
      expect(
        yield* handlers["git.prRequestRereview"]({ threadId: thread.id }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "InvalidState", message: "This thread has no pull request" });

      yield* runtimes.updateThread(thread.id, (t) => ({
        ...t,
        boundPr: { repo: "acme/web", number: 12, monitor: false },
      }));
      const result: PrReview = yield* handlers["git.prReview"]({ threadId: thread.id });
      expect(result.pr?.number).toBe(12);
      expect(calls.at(-1)).toMatchObject({
        op: "fetch",
        args: [repo, "acme/web", 12, [{ loginPattern: "example-code-review[bot]" }]],
      });
    }).pipe(Effect.provide(TestLayer)),
  );

  it.live("apply a suggestion locally and refuse outdated or unknown comments", () =>
    Effect.gen(function* () {
      const { repo, thread, handlers, runtimes } = yield* setup;
      write(nodePath.join(repo, "tracked.txt"), "tracked\nsecond\n");
      yield* runtimes.updateThread(thread.id, (t) => ({
        ...t,
        boundPr: { repo: "acme/web", number: 12, monitor: false },
      }));

      expect(
        yield* handlers["git.prApplySuggestion"]({ threadId: thread.id, commentId: "PRRC_1" }),
      ).toEqual({
        path: "tracked.txt",
        startLine: 1,
        endLine: 1,
      });
      expect(fs.readFileSync(nodePath.join(repo, "tracked.txt"), "utf8")).toBe("TRACKED\nsecond\n");

      expect(
        yield* handlers["git.prApplySuggestion"]({ threadId: thread.id, commentId: "PRRC_3" }).pipe(
          Effect.flip,
        ),
      ).toMatchObject({
        _tag: "InvalidState",
        message: "This suggestion is on outdated code; apply it by hand.",
      });
      expect(
        yield* handlers["git.prApplySuggestion"]({ threadId: thread.id, commentId: "PRRC_2" }).pipe(
          Effect.flip,
        ),
      ).toMatchObject({ _tag: "InvalidState", message: "That comment has no suggestion" });
      expect(
        yield* handlers["git.prApplySuggestion"]({ threadId: thread.id, commentId: "nope" }).pipe(
          Effect.flip,
        ),
      ).toMatchObject({ _tag: "InvalidState", message: "That review comment no longer exists" });
    }).pipe(Effect.provide(TestLayer)),
  );

  it.live("reply, resolve, and request a re-review with the configured command", () =>
    Effect.gen(function* () {
      const { repo, thread, handlers, runtimes } = yield* setup;
      const store = yield* ThreadStore;
      yield* runtimes.updateThread(thread.id, (t) => ({
        ...t,
        boundPr: { repo: "acme/web", number: 12, monitor: false },
      }));
      calls.length = 0;

      const reply = yield* handlers["git.prReplyThread"]({
        threadId: thread.id,
        reviewThreadId: "PRRT_1",
        body: "Fixed in 3f9c2d1",
      });
      expect(reply.body).toBe("Fixed in 3f9c2d1");
      yield* handlers["git.prResolveThread"]({ threadId: thread.id, reviewThreadId: "PRRT_1" });
      expect(
        yield* handlers["git.prResolveThread"]({
          threadId: thread.id,
          reviewThreadId: "PRRT_gone",
        }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "GitError", message: "Could not resolve to a node" });

      expect(yield* handlers["git.prRequestRereview"]({ threadId: thread.id })).toEqual({
        command: "/agent review",
      });
      yield* store.updateSettings((s) => ({
        ...s,
        reviewBots: [
          {
            loginPattern: "acme-reviewer[bot]",
            rereviewCommand: "@acme-reviewer review",
            canApprove: false,
          },
        ],
      }));
      expect(yield* handlers["git.prRequestRereview"]({ threadId: thread.id })).toEqual({
        command: "@acme-reviewer review",
      });
      yield* store.updateSettings((s) => ({ ...s, reviewBots: [] }));
      expect(
        yield* handlers["git.prRequestRereview"]({ threadId: thread.id }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "InvalidState", message: "No review bot is configured" });

      expect(calls.map((c) => c.op)).toEqual(["reply", "resolve", "comment", "comment"]);
      expect(calls[2]?.args).toEqual([repo, "acme/web", 12, "/agent review"]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.live("request a re-review of a PR bound from another repository from its own bot", () =>
    Effect.gen(function* () {
      const { repo, thread, runtimes } = yield* setup;
      const store = yield* ThreadStore;
      // The checkout's own PR is acme/web#12, reviewed by acme's bot; the thread binds acme/api#7.
      const live = yield* GitStatePublisher;
      const handlers = yield* gitHandlers.pipe(
        Effect.provideService(GitStatePublisher, {
          ...live,
          stateFor: (path) =>
            live.stateFor(path).pipe(
              Effect.map((state) =>
                state === undefined
                  ? state
                  : {
                      ...state,
                      pr: badge("https://github.com/acme/web/pull/12", 12, ["acme-reviewer[bot]"]),
                    },
              ),
            ),
          badgeFor: () =>
            Effect.succeed(
              badge("https://github.com/acme/api/pull/7", 7, ["example-code-review[bot]"]),
            ),
        }),
      );
      yield* store.updateSettings((s) => ({
        ...s,
        reviewBots: [
          {
            loginPattern: "acme-reviewer[bot]",
            rereviewCommand: "@acme-reviewer review",
            canApprove: false,
          },
          {
            loginPattern: "example-code-review[bot]",
            rereviewCommand: "/agent review",
            canApprove: true,
          },
        ],
      }));
      yield* runtimes.updateThread(thread.id, (t) => ({
        ...t,
        boundPr: { repo: "acme/api", number: 7, monitor: false },
      }));
      calls.length = 0;

      expect(yield* handlers["git.prRequestRereview"]({ threadId: thread.id })).toEqual({
        command: "/agent review",
      });
      expect(calls).toEqual([{ op: "comment", args: [repo, "acme/api", 7, "/agent review"] }]);
    }).pipe(Effect.provide(TestLayer)),
  );
});
