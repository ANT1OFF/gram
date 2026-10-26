import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_CHARTER,
  ORCHESTRATOR_HAS_NO_PR,
  type Autonomy,
  type GitState,
  type PrReview,
  type PrStatus,
  type ReviewThread,
  type Thread,
  type ThreadId,
  type WorkspaceId,
} from "@gram/contracts";
import { applySuggestion, Pr, ReviewActionError } from "@gram/git";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { AppToolRegistry } from "../app-tools/registry.ts";
import { gitPlatformTest } from "../git/platform.ts";
import { GitStatePublisher } from "../git/publisher.ts";
import { PrReviews } from "../git/review.ts";
import { eventually, removeDir, run, tempDir } from "../git/test-repo.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { RuntimeTestLayer } from "../runtime/test-harness.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { ReviewAppToolsLive } from "./review-tools.ts";
import { Babysit, BabysitLive } from "./service.ts";

const HEAD = "a".repeat(40);

const botThread = (
  id: string,
  severity: ReviewThread["severity"],
  isResolved = false,
): ReviewThread => ({
  id,
  path: "src/app.ts",
  line: 3,
  isResolved,
  isOutdated: false,
  severity,
  byBot: true,
  comments: [
    {
      id: `${id}_c`,
      author: "example-code-review",
      body: `[${severity}] Finding ${id}.`,
      createdAt: "2026-09-16T10:00:00Z",
      url: `https://github.com/acme/web/pull/12#${id}`,
    },
  ],
});

/** A thread a person started, on the same PR. */
const humanThread: ReviewThread = {
  id: "PRRT_H",
  path: "src/app.ts",
  line: 7,
  isResolved: false,
  isOutdated: false,
  severity: "finding",
  byBot: false,
  comments: [
    {
      id: "PRRT_H_c",
      author: "priya",
      body: "Could this be a map?",
      createdAt: "2026-09-16T10:00:00Z",
      url: "https://github.com/acme/web/pull/12#PRRT_H",
    },
  ],
};

const ownReview = (): PrReview => ({
  available: true,
  pr: {
    number: 12,
    url: "https://github.com/acme/web/pull/12",
    headRefOid: HEAD,
    reviewDecision: "CHANGES_REQUESTED",
    mergeStateStatus: "BLOCKED",
    state: "OPEN",
    viewerDidAuthor: true,
  },
  threads: [
    botThread("PRRT_1", "suggestion"),
    botThread("PRRT_2", "blocker"),
    botThread("PRRT_3", "blocker", true),
    humanThread,
  ],
});

const world: {
  review: PrReview;
  /** The PR the checkout's branch opened, as the publisher shows it. */
  published: PrStatus | undefined;
  ancestry: Map<string, boolean>;
  calls: Array<string>;
  /** Makes the next PR comment fail, as a dropped network call would. */
  failComment: boolean;
  /** The next PR comment waits here once it has started, then posts or fails as this does. */
  holdComment: Deferred.Deferred<void, ReviewActionError> | undefined;
  commentsStarted: number;
} = {
  review: ownReview(),
  published: undefined,
  ancestry: new Map(),
  calls: [],
  failComment: false,
  holdComment: undefined,
  commentsStarted: 0,
};

const badge: PrStatus = {
  number: 12,
  state: "OPEN",
  url: "https://github.com/acme/web/pull/12",
  title: "t",
  isDraft: false,
  checks: "passing",
  headMatches: true,
  aheadOfPr: false,
  headRefOid: HEAD,
};

const state = (): GitState => ({
  repo: true,
  worktree: false,
  head: HEAD,
  changesToken: "c",
  changedFiles: 0,
  behindBase: 0,
  aheadBase: 0,
  conflicts: false,
  ...(world.published === undefined ? {} : { pr: world.published }),
});

const FakePublisher = Layer.succeed(GitStatePublisher, {
  stateFor: () => Effect.sync(state),
  badgeFor: () => Effect.sync(() => world.published),
  extraBadgesFor: () => Effect.succeed([]),
  stateForThread: () => Effect.sync(state),
  reconcile: () => Effect.void,
  checksRead: () => Effect.void,
  refresh: () => Effect.void,
  sweep: Effect.void,
  sync: Effect.void,
  hold: () => Effect.succeed(Effect.void),
  observe: () => Effect.void,
  watchPrs: () => Effect.void,
  watchedBadge: () => Effect.succeed(undefined),
  lookupPr: () => Effect.succeed(Option.none()),
});

const MockPr = Layer.succeed(Pr, {
  status: () => Effect.succeed(badge),
  checks: () => Effect.succeed([]),
  prime: () => Effect.void,
  seenChecks: () => Effect.succeed(undefined),
  detail: () => Effect.succeed({ available: true }),
});

const FakeReviews = Layer.succeed(PrReviews, {
  fetch: () => Effect.sync(() => world.review),
  reply: (_workTree, reviewThreadId, body) =>
    Effect.sync(() => {
      world.calls.push(`reply ${reviewThreadId} ${body}`);
      return { id: "PRRC_9", author: "me", body, createdAt: "2026-09-16T10:02:00Z", url: "u" };
    }),
  resolve: (_workTree, reviewThreadId) =>
    Effect.sync(() => void world.calls.push(`resolve ${reviewThreadId}`)),
  comment: (_workTree, repo, number, body) =>
    Effect.gen(function* () {
      world.commentsStarted += 1;
      const hold = world.holdComment;
      world.holdComment = undefined;
      if (hold !== undefined) yield* Deferred.await(hold);
      if (world.failComment) {
        world.failComment = false;
        return yield* new ReviewActionError({ message: "offline" });
      }
      world.calls.push(`comment ${repo}#${number} ${body}`);
    }),
  applySuggestion,
  rerun: () => Effect.void,
  isPushed: (_workTree, sha, head) => Effect.sync(() => world.ancestry.get(`${sha}>${head}`)),
});

const TestLayer = ReviewAppToolsLive.pipe(
  Layer.provideMerge(BabysitLive),
  Layer.provideMerge(FakePublisher),
  Layer.provideMerge(RuntimeTestLayer),
  Layer.provideMerge(gitPlatformTest({ pr: MockPr, prReviews: FakeReviews })),
);

/** A thread in `default` mode bound to #12, with its tools as the in-process host sees them. */
const boundThread = Effect.gen(function* () {
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
  world.review = ownReview();
  world.published = badge;
  world.ancestry = new Map();
  world.calls = [];
  world.failComment = false;
  world.holdComment = undefined;
  world.commentsStarted = 0;
  const dir = tempDir();
  yield* Effect.addFinalizer(() => Effect.sync(() => removeDir(dir)));
  const runtimes = yield* ThreadRuntimes;
  const registry = yield* AppToolRegistry;
  const thread = yield* runtimes.create({
    projectRoot: dir,
    checkout: { kind: "main", path: dir },
    // The settings default is `auto`, which waives the cards these tests are about.
    mode: "default",
  });
  yield* Effect.addFinalizer(() => runtimes.close(thread.id).pipe(Effect.ignore));
  yield* runtimes.updateThread(thread.id, (t) => ({
    ...t,
    boundPr: { repo: "acme/web", number: 12, monitor: false },
  }));
  const tool = (name: string) => {
    const found = registry.forThread(thread.id).find((t) => t.descriptor.name === name);
    if (found === undefined) throw new Error(`no app tool ${name}`);
    return found;
  };
  return { id: thread.id, dir, tool };
});

/** Makes `threadId` its orchestrator's worker in a workspace at `autonomy`, in `mode`. */
const asWorker = (threadId: ThreadId, autonomy: Autonomy, mode: Thread["mode"]) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    const runtimes = yield* ThreadRuntimes;
    const workspaceId = "w1" as WorkspaceId;
    const orchestrator = "orch" as ThreadId;
    const { projectId } = yield* store.getThread(threadId);
    yield* store.putWorkspace({
      workspace: {
        id: workspaceId,
        name: "Shop",
        projectIds: [projectId],
        homeProjectId: projectId,
        orchestratorThreadId: orchestrator,
        createdAt: 1,
      },
      charter: { ...DEFAULT_CHARTER, autonomy },
    });
    yield* runtimes.updateThread(threadId, (t) => ({
      ...t,
      mode,
      workspaceId,
      spawnedBy: { threadId: orchestrator, feature: "f" },
    }));
  });

const answerCard = (threadId: ThreadId, name: string, decision: "allow" | "deny") =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    const runtimes = yield* ThreadRuntimes;
    const request = yield* eventually(
      "the approval card",
      store.listRequests(threadId).pipe(Effect.map((requests) => requests[0])),
    );
    expect(request).toMatchObject({ toolName: `mcp__gram__${name}`, scopes: ["once"] });
    yield* runtimes.respond(threadId, request.id, { kind: "approval", decision, scope: "once" });
    yield* eventually(
      "the card to clear",
      store.listRequests(threadId).pipe(Effect.map((requests) => requests.length === 0)),
    );
    return request;
  });

describe("review app tools", () => {
  it.live("read the review state and the unresolved threads without a card", () =>
    Effect.gen(function* () {
      const { tool } = yield* boundThread;
      expect(yield* tool("pr_review_state").run({})).toMatchObject({
        pr: { number: 12, viewerDidAuthor: true },
      });
      const listed = (yield* tool("pr_review_threads").run({})) as {
        threads: ReadonlyArray<{ id: string }>;
      };
      expect(listed.threads.map((t) => t.id)).toEqual(["PRRT_1", "PRRT_2", "PRRT_H"]);
      const all = (yield* tool("pr_review_threads").run({ includeResolved: true })) as {
        threads: ReadonlyArray<{ id: string }>;
      };
      expect(all.threads).toHaveLength(4);
      expect(tool("pr_reply_to_thread").descriptor.class).toBe("outwardGated");
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.live("read another thread's review state by id", () =>
    Effect.gen(function* () {
      const { id } = yield* boundThread;
      const runtimes = yield* ThreadRuntimes;
      const registry = yield* AppToolRegistry;
      const dir = tempDir();
      yield* Effect.addFinalizer(() => Effect.sync(() => removeDir(dir)));
      const reader = yield* runtimes.create({
        projectRoot: dir,
        checkout: { kind: "main", path: dir },
      });
      yield* Effect.addFinalizer(() => runtimes.close(reader.id).pipe(Effect.ignore));
      const reviewState = registry
        .forThread(reader.id)
        .find((t) => t.descriptor.name === "pr_review_state")!;
      expect(yield* reviewState.run({ threadId: id })).toMatchObject({
        pr: { number: 12, viewerDidAuthor: true },
      });
      const unknown = yield* reviewState.run({ threadId: "nobody" }).pipe(Effect.flip);
      expect(unknown).toMatchObject({ _tag: "AppToolError", tool: "pr_review_state" });
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.live("ask on every write outside babysit mode", () =>
    Effect.gen(function* () {
      const { id, tool } = yield* boundThread;
      const reply = yield* Effect.forkScoped(
        tool("pr_reply_to_thread").run({ reviewThreadId: "PRRT_1", body: "Thanks" }),
      );
      expect(yield* answerCard(id, "pr_reply_to_thread", "allow")).toMatchObject({
        description:
          "Reply to the review thread on src/app.ts:3 of acme/web#12. Asked because this thread is in Ask mode.",
      });
      expect(yield* Fiber.join(reply)).toMatchObject({ resolved: false });
      expect(world.calls).toEqual(["reply PRRT_1 Thanks"]);

      const resolve = yield* Effect.forkScoped(
        tool("pr_resolve_thread").run({ reviewThreadId: "PRRT_1" }),
      );
      yield* answerCard(id, "pr_resolve_thread", "deny");
      expect(yield* Fiber.join(resolve).pipe(Effect.flip)).toMatchObject({
        approvalRequired: true,
      });
      expect(world.calls).toEqual(["reply PRRT_1 Thanks"]);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.live(
    "babysit covers the user's own open PR, but declining a blocker or another's PR still asks",
    () =>
      Effect.gen(function* () {
        const { id, tool } = yield* boundThread;
        const store = yield* ThreadStore;
        yield* (yield* Babysit).setEnabled(id, true);

        expect(
          yield* tool("pr_reply_to_thread").run({
            reviewThreadId: "PRRT_1",
            body: "Out of scope for this PR.",
          }),
        ).toMatchObject({ resolved: false });
        expect(yield* store.listRequests(id)).toEqual([]);

        world.ancestry.set(`abcdef1>${HEAD}`, true);
        expect(
          yield* tool("pr_reply_to_thread").run({
            reviewThreadId: "PRRT_2",
            body: "Fixed in abcdef1: handled the empty case.",
          }),
        ).toMatchObject({ resolved: true });
        expect(world.calls).toEqual([
          "reply PRRT_1 Out of scope for this PR.",
          "reply PRRT_2 Fixed in abcdef1: handled the empty case.",
          "resolve PRRT_2",
        ]);
        expect((yield* store.getThread(id)).babysit).toMatchObject({
          handled: ["PRRT_2"],
          declined: ["PRRT_1"],
        });

        const decline = yield* Effect.forkScoped(
          tool("pr_reply_to_thread").run({ reviewThreadId: "PRRT_2", body: "Won't fix." }),
        );
        yield* answerCard(id, "pr_reply_to_thread", "allow");
        yield* Fiber.join(decline);

        expect(yield* tool("pr_request_rereview").run({})).toEqual({ command: "/agent review" });
        const again = yield* Effect.forkScoped(tool("pr_request_rereview").run({}));
        yield* answerCard(id, "pr_request_rereview", "deny");
        expect(yield* Fiber.join(again).pipe(Effect.flip)).toMatchObject({
          approvalRequired: true,
        });

        world.review = { ...ownReview(), pr: { ...ownReview().pr!, viewerDidAuthor: false } };
        const others = yield* Effect.forkScoped(
          tool("pr_reply_to_thread").run({ reviewThreadId: "PRRT_1", body: "Noted." }),
        );
        yield* answerCard(id, "pr_reply_to_thread", "allow");
        yield* Fiber.join(others);
      }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.live("auto never asks to answer the bot, covers a person's thread as babysit does", () =>
    Effect.gen(function* () {
      const { id, tool } = yield* boundThread;
      const store = yield* ThreadStore;
      const runtimes = yield* ThreadRuntimes;
      const decline = { reviewThreadId: "PRRT_2", body: "Won't fix." };

      yield* runtimes.updateThread(id, (t) => ({ ...t, mode: "auto" as const }));
      yield* tool("pr_reply_to_thread").run({ reviewThreadId: "PRRT_1", body: "Thanks" });
      yield* tool("pr_reply_to_thread").run(decline);
      yield* tool("pr_resolve_thread").run({ reviewThreadId: "PRRT_1" });
      yield* tool("pr_reply_to_thread").run({ reviewThreadId: "PRRT_H", body: "Done." });
      expect(yield* store.listRequests(id)).toEqual([]);
      const unfixed = yield* Effect.forkScoped(
        tool("pr_resolve_thread").run({ reviewThreadId: "PRRT_H" }),
      );
      expect(yield* answerCard(id, "pr_resolve_thread", "deny")).toMatchObject({
        description:
          "Resolve the review thread on src/app.ts:7 of acme/web#12. Asked because a person started this review thread.",
      });
      yield* Fiber.join(unfixed).pipe(Effect.flip);

      expect(yield* tool("pr_request_rereview").run({})).toEqual({ command: "/agent review" });
      const again = yield* Effect.forkScoped(tool("pr_request_rereview").run({}));
      yield* answerCard(id, "pr_request_rereview", "deny");
      expect(yield* Fiber.join(again).pipe(Effect.flip)).toMatchObject({ approvalRequired: true });

      for (const pr of [{ viewerDidAuthor: false }, { state: "CLOSED" as const }]) {
        world.review = { ...ownReview(), pr: { ...ownReview().pr!, ...pr } };
        const others = yield* Effect.forkScoped(
          tool("pr_reply_to_thread").run({ reviewThreadId: "PRRT_1", body: "Noted." }),
        );
        expect(yield* answerCard(id, "pr_reply_to_thread", "deny")).toMatchObject({
          description: expect.stringContaining("the pull request isn't the user's open PR"),
        });
        yield* Fiber.join(others).pipe(Effect.flip);
      }
      world.review = ownReview();

      yield* runtimes.updateThread(id, (t) => ({ ...t, mode: "bypassPermissions" as const }));
      yield* tool("pr_resolve_thread").run({ reviewThreadId: "PRRT_H" });
      expect(yield* store.listRequests(id)).toEqual([]);
      expect(world.calls).toEqual([
        "reply PRRT_1 Thanks",
        "reply PRRT_2 Won't fix.",
        "resolve PRRT_1",
        "reply PRRT_H Done.",
        "comment acme/web#12 /agent review",
        "resolve PRRT_H",
      ]);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.live("a worker at full autonomy in bypass is never asked on its own PR", () =>
    Effect.gen(function* () {
      const { id, tool } = yield* boundThread;
      const store = yield* ThreadStore;
      yield* asWorker(id, "full", "bypassPermissions");
      yield* tool("pr_reply_to_thread").run({ reviewThreadId: "PRRT_2", body: "Won't fix." });
      yield* tool("pr_resolve_thread").run({ reviewThreadId: "PRRT_1" });
      yield* tool("pr_request_rereview").run({});
      yield* tool("pr_request_rereview").run({});
      expect(yield* store.listRequests(id)).toEqual([]);
      expect(world.calls).toEqual([
        "reply PRRT_2 Won't fix.",
        "resolve PRRT_1",
        "comment acme/web#12 /agent review",
        "comment acme/web#12 /agent review",
      ]);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.live("a worker at publish autonomy in auto answers the bot unasked, as a plain thread", () =>
    Effect.gen(function* () {
      const { id, tool } = yield* boundThread;
      const store = yield* ThreadStore;
      yield* asWorker(id, "publish", "auto");
      yield* tool("pr_reply_to_thread").run({ reviewThreadId: "PRRT_2", body: "Won't fix." });
      yield* tool("pr_resolve_thread").run({ reviewThreadId: "PRRT_1" });
      yield* tool("pr_reply_to_thread").run({ reviewThreadId: "PRRT_H", body: "Done." });
      expect(yield* store.listRequests(id)).toEqual([]);
      const unfixed = yield* Effect.forkScoped(
        tool("pr_resolve_thread").run({ reviewThreadId: "PRRT_H" }),
      );
      yield* answerCard(id, "pr_resolve_thread", "deny");
      yield* Fiber.join(unfixed).pipe(Effect.flip);
      expect(yield* tool("pr_request_rereview").run({})).toEqual({ command: "/agent review" });
      const again = yield* Effect.forkScoped(tool("pr_request_rereview").run({}));
      yield* answerCard(id, "pr_request_rereview", "deny");
      yield* Fiber.join(again).pipe(Effect.flip);
      expect(world.calls).toEqual([
        "reply PRRT_2 Won't fix.",
        "resolve PRRT_1",
        "reply PRRT_H Done.",
        "comment acme/web#12 /agent review",
      ]);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.live("a worker answers the bot unasked on a PR it bound from another worktree", () =>
    Effect.gen(function* () {
      const { id, dir, tool } = yield* boundThread;
      const store = yield* ThreadStore;
      const runtimes = yield* ThreadRuntimes;
      yield* asWorker(id, "full", "bypassPermissions");
      run(dir, "init", "-q");
      run(dir, "remote", "add", "origin", "git@github.com:acme/web.git");
      // The checkout's branch still shows its first PR, merged; #12 was opened from elsewhere.
      world.published = {
        ...badge,
        number: 11,
        url: "https://github.com/acme/web/pull/11",
        state: "MERGED",
      };
      yield* tool("pr_reply_to_thread").run({ reviewThreadId: "PRRT_2", body: "Won't fix." });
      yield* tool("pr_resolve_thread").run({ reviewThreadId: "PRRT_2" });
      expect(yield* store.listRequests(id)).toEqual([]);

      world.published = undefined;
      yield* tool("pr_reply_to_thread").run({ reviewThreadId: "PRRT_1", body: "Thanks" });
      expect(yield* store.listRequests(id)).toEqual([]);

      // A PR in a repo other than the checkout's asks.
      run(dir, "remote", "set-url", "origin", "git@github.com:acme/other.git");
      const elsewhere = yield* Effect.forkScoped(
        tool("pr_reply_to_thread").run({ reviewThreadId: "PRRT_1", body: "Again" }),
      );
      yield* answerCard(id, "pr_reply_to_thread", "deny");
      yield* Fiber.join(elsewhere).pipe(Effect.flip);
      run(dir, "remote", "set-url", "origin", "git@github.com:acme/web.git");

      // It isn't the branch's own PR, so a person's thread and a re-review ask on every call.
      const person = yield* Effect.forkScoped(
        tool("pr_reply_to_thread").run({ reviewThreadId: "PRRT_H", body: "Done." }),
      );
      yield* answerCard(id, "pr_reply_to_thread", "deny");
      yield* Fiber.join(person).pipe(Effect.flip);
      const rereview = yield* Effect.forkScoped(tool("pr_request_rereview").run({}));
      yield* answerCard(id, "pr_request_rereview", "deny");
      yield* Fiber.join(rereview).pipe(Effect.flip);

      // Ask mode asks, whatever the autonomy.
      yield* runtimes.updateThread(id, (t) => ({ ...t, mode: "default" as const }));
      const asked = yield* Effect.forkScoped(
        tool("pr_resolve_thread").run({ reviewThreadId: "PRRT_1" }),
      );
      yield* answerCard(id, "pr_resolve_thread", "deny");
      yield* Fiber.join(asked).pipe(Effect.flip);
      expect(world.calls).toEqual([
        "reply PRRT_2 Won't fix.",
        "resolve PRRT_2",
        "reply PRRT_1 Thanks",
      ]);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.live("a supervised worker is asked on every write, in auto and in bypass", () =>
    Effect.gen(function* () {
      const { id, tool } = yield* boundThread;
      const runtimes = yield* ThreadRuntimes;
      yield* asWorker(id, "supervised", "auto");
      const covered = yield* Effect.forkScoped(
        tool("pr_reply_to_thread").run({ reviewThreadId: "PRRT_1", body: "Thanks" }),
      );
      expect(yield* answerCard(id, "pr_reply_to_thread", "allow")).toMatchObject({
        description: expect.stringContaining(
          "Asked because this worker's workspace autonomy isn't publish or full.",
        ),
      });
      yield* Fiber.join(covered);
      yield* runtimes.updateThread(id, (t) => ({ ...t, mode: "bypassPermissions" as const }));
      const bypassed = yield* Effect.forkScoped(tool("pr_request_rereview").run({}));
      yield* answerCard(id, "pr_request_rereview", "deny");
      yield* Fiber.join(bypassed).pipe(Effect.flip);
      expect(world.calls).toEqual(["reply PRRT_1 Thanks"]);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.live("an orchestrator's review tools refuse, and it reads a worker's review by id", () =>
    Effect.gen(function* () {
      const { id: worker } = yield* boundThread;
      const { id, tool } = yield* boundThread;
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const registry = yield* AppToolRegistry;
      yield* runtimes.updateThread(id, (t) => ({ ...t, role: "orchestrator" as const }));
      const calls: ReadonlyArray<readonly [string, object]> = [
        ["pr_review_state", {}],
        ["pr_review_threads", {}],
        ["pr_reply_to_thread", { reviewThreadId: "PRRT_1", body: "Thanks" }],
        ["pr_resolve_thread", { reviewThreadId: "PRRT_1" }],
        ["pr_request_rereview", {}],
        ["pr_review_monitor", {}],
      ];
      for (const [name, input] of calls) {
        const refused = yield* tool(name).run(input).pipe(Effect.flip);
        expect(refused.message, name).toBe(ORCHESTRATOR_HAS_NO_PR);
      }
      expect(yield* store.listRequests(id)).toEqual([]);
      expect((yield* store.getThread(id)).boundPr).toBeUndefined();
      expect(world.calls).toEqual([]);

      const offered = registry.forThread(id, "orchestrator").map((t) => t.descriptor.name);
      expect(offered).toContain("pr_review_state");
      for (const [name] of calls.slice(1)) expect(offered).not.toContain(name);
      expect(yield* tool("pr_review_state").run({ threadId: worker })).toMatchObject({
        pr: { number: 12 },
      });
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.live("a PR is a worker's own only if its branch opened it and the user did", () =>
    Effect.gen(function* () {
      const { id, tool } = yield* boundThread;
      const runtimes = yield* ThreadRuntimes;
      yield* asWorker(id, "full", "bypassPermissions");
      // `pr_bind` takes any PR: the same number in another repo is not the one the branch opened.
      yield* runtimes.updateThread(id, (t) => ({
        ...t,
        boundPr: { repo: "acme/other", number: 12, monitor: false },
      }));
      const elsewhere = yield* Effect.forkScoped(
        tool("pr_reply_to_thread").run({ reviewThreadId: "PRRT_1", body: "Noted." }),
      );
      yield* answerCard(id, "pr_reply_to_thread", "deny");
      yield* Fiber.join(elsewhere).pipe(Effect.flip);

      yield* runtimes.updateThread(id, (t) => ({
        ...t,
        boundPr: { repo: "acme/web", number: 12, monitor: false },
      }));
      world.review = { ...ownReview(), pr: { ...ownReview().pr!, viewerDidAuthor: false } };
      const others = yield* Effect.forkScoped(
        tool("pr_resolve_thread").run({ reviewThreadId: "PRRT_1" }),
      );
      yield* answerCard(id, "pr_resolve_thread", "deny");
      yield* Fiber.join(others).pipe(Effect.flip);

      for (const pr of [{ state: "MERGED" as const }, { number: 13 }]) {
        world.review = { ...ownReview(), pr: { ...ownReview().pr!, ...pr } };
        const closed = yield* Effect.forkScoped(
          tool("pr_reply_to_thread").run({ reviewThreadId: "PRRT_1", body: "Noted." }),
        );
        yield* answerCard(id, "pr_reply_to_thread", "deny");
        yield* Fiber.join(closed).pipe(Effect.flip);
      }

      // Nor does a review thread of another PR reach this one's tools.
      world.review = ownReview();
      const unknown = yield* tool("pr_reply_to_thread")
        .run({ reviewThreadId: "PRRT_elsewhere", body: "Hi" })
        .pipe(Effect.flip);
      expect(unknown).toMatchObject({ message: "unknown review thread PRRT_elsewhere" });
      expect(world.calls).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.live("a head gets one uncarded re-review, whoever asks first, unless the post fails", () =>
    Effect.gen(function* () {
      const { id, tool } = yield* boundThread;
      const store = yield* ThreadStore;
      const runtimes = yield* ThreadRuntimes;
      yield* runtimes.updateThread(id, (t) => ({ ...t, mode: "auto" as const }));

      world.failComment = true;
      yield* tool("pr_request_rereview").run({}).pipe(Effect.flip);
      expect((yield* store.getThread(id)).rereviewRequestedOn).toBeUndefined();

      const both = yield* Effect.forkScoped(
        Effect.all([tool("pr_request_rereview").run({}), tool("pr_request_rereview").run({})], {
          concurrency: "unbounded",
          mode: "result",
        }),
      );
      yield* answerCard(id, "pr_request_rereview", "deny");
      const results = yield* Fiber.join(both);
      expect(results.filter((r) => r._tag === "Success")).toHaveLength(1);
      expect(world.calls).toEqual(["comment acme/web#12 /agent review"]);
      expect((yield* store.getThread(id)).rereviewRequestedOn).toBe(HEAD);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.live("an interrupted or failed re-review gives the head's uncarded request back", () =>
    Effect.gen(function* () {
      const { id, tool } = yield* boundThread;
      const store = yield* ThreadStore;
      const runtimes = yield* ThreadRuntimes;
      yield* runtimes.updateThread(id, (t) => ({ ...t, mode: "auto" as const }));
      const started = (n: number) =>
        eventually(
          `comment ${n} to start`,
          Effect.sync(() => world.commentsStarted === n),
        );

      world.holdComment = yield* Deferred.make<void, ReviewActionError>();
      const interrupted = yield* Effect.forkScoped(tool("pr_request_rereview").run({}));
      yield* started(1);
      expect((yield* store.getThread(id)).rereviewRequestedOn).toBe(HEAD);
      yield* Fiber.interrupt(interrupted);
      expect((yield* store.getThread(id)).rereviewRequestedOn).toBeUndefined();

      // A second call waits for the first rather than asking and posting beside it, so the first
      // one's rollback can't undo a request that went out.
      const hold = yield* Deferred.make<void, ReviewActionError>();
      world.holdComment = hold;
      const failing = yield* Effect.forkScoped(tool("pr_request_rereview").run({}));
      yield* started(2);
      const waiting = yield* Effect.forkScoped(tool("pr_request_rereview").run({}));
      yield* Deferred.fail(hold, new ReviewActionError({ message: "offline" }));
      yield* Fiber.join(failing).pipe(Effect.flip);
      expect(yield* Fiber.join(waiting)).toEqual({ command: "/agent review" });
      expect(yield* store.listRequests(id)).toEqual([]);

      const third = yield* Effect.forkScoped(tool("pr_request_rereview").run({}));
      yield* answerCard(id, "pr_request_rereview", "deny");
      yield* Fiber.join(third).pipe(Effect.flip);
      expect(world.calls).toEqual(["comment acme/web#12 /agent review"]);
      expect((yield* store.getThread(id)).rereviewRequestedOn).toBe(HEAD);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.live("pr_review_monitor turns the monitor on for the bound PR", () =>
    Effect.gen(function* () {
      const { id, tool } = yield* boundThread;
      expect(yield* tool("pr_review_monitor").run({})).toMatchObject({ reviewMonitor: true });
      expect((yield* (yield* ThreadStore).getThread(id)).boundPr).toEqual({
        repo: "acme/web",
        number: 12,
        monitor: false,
        reviewMonitor: true,
      });
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});
