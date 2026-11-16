// A user's merge_when_ready approval covers the change its card named: the head, the base and the
// repository the head lives in. A fork's new push, a retarget or an approval that recorded none of it
// runs no check of Gram's on this machine and merges nothing until a new card approves again.
import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_CHARTER,
  WorkspaceId,
  type MergeIntent,
  type PrStatus,
  type ThreadId,
} from "@gram/contracts";
import { Pr, Proc } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureLogs } from "@gram/agents/testing/logs";
import { ThreadStore } from "../persistence/thread-store.ts";
import { RuntimeTestLayer } from "../runtime/test-harness.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { waitReal } from "../orchestration/test-harness.ts";
import { LocalChecks, LOCAL_CHECK_ISOLATION, type LocalCheck } from "./local-checks.ts";
import { MergeFreezesNone } from "./merge-freezes.ts";
import { approvalLapse, MergeWhenReady, MergeWhenReadyLive } from "./merge-when-ready.ts";
import { GitRefresh } from "./platform.ts";
import { GitStatePublisher } from "./publisher.ts";

// Invented commits and repositories: example/project's PR 7, from the fork outsider/project.
const APPROVED = "a".repeat(40);
const PUSHED = "e".repeat(40);
const BASE = "b".repeat(40);
const REPO = "example/project";
const FORK = "outsider/project";

const pr = (overrides: Partial<PrStatus> = {}): PrStatus => ({
  number: 7,
  state: "OPEN",
  url: `https://github.com/${REPO}/pull/7`,
  title: "PR 7",
  isDraft: false,
  checks: "pending",
  headMatches: true,
  aheadOfPr: false,
  headRefOid: APPROVED,
  baseRefOid: BASE,
  baseTipOid: BASE,
  baseRef: "main",
  headRef: "feat/seven",
  crossRepository: true,
  headRepo: FORK,
  mergeState: "UNSTABLE",
  ...overrides,
});

/** The badge without GitHub's word on where its head lives. */
const unsaid = (badge: PrStatus): PrStatus => {
  const { crossRepository: _fork, headRepo: _repo, ...rest } = badge;
  return rest;
};

/** Green, clean and allowed: what merges at once unless the approval stops it. */
const green = (overrides: Partial<PrStatus> = {}) =>
  pr({ checks: "passing", mergeState: "CLEAN", ...overrides });

const forkApproval: MergeIntent = {
  method: "squash",
  allowedBy: "user",
  approved: {
    head: APPROVED,
    baseRef: "main",
    headRepo: FORK,
    crossRepository: true,
  },
  setAt: 1,
};

const running = (head: string, base: string): LocalCheck => ({
  head,
  base,
  tree: "c".repeat(40),
  status: "running",
  command: "invented-check",
  isolation: LOCAL_CHECK_ISOLATION,
  startedAt: 1,
  host: "invented",
});

/**
 * One thread in a solo workspace bound to PR 7 with `intent`, Gram's own check configured, the
 * publisher's badge `badge.current` and GitHub's fresh read `fresh.current` (the badge when unset).
 * Its folder is a plain directory: the thread holds no worktree branch of the PR.
 */
const world = <A>(
  intent: MergeIntent,
  first: PrStatus,
  body: (w: {
    readonly service: MergeWhenReady["Service"];
    readonly threadId: ThreadId;
    readonly badge: { current: PrStatus };
    readonly fresh: { current: PrStatus | undefined };
    readonly ensured: Array<string>;
    readonly merged: Array<ReadonlyArray<string>>;
    readonly intent: () => Effect.Effect<MergeIntent | undefined>;
    readonly notices: () => Effect.Effect<string>;
  }) => Effect.Effect<A, unknown, ThreadStore | ThreadRuntimes>,
) =>
  Effect.gen(function* () {
    const dir = mkdtempSync(join(tmpdir(), "gram-merge-approval-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
    );
    const badge = { current: first };
    const fresh: { current: PrStatus | undefined } = { current: undefined };
    const ensured: Array<string> = [];
    const merged: Array<ReadonlyArray<string>> = [];
    const proc = Layer.succeed(Proc, {
      run: (_bin, args) =>
        Effect.sync(() => {
          if (args[0] === "pr" && args[1] === "merge") merged.push([...args]);
          const read = fresh.current ?? badge.current;
          return {
            status: 0,
            stdout:
              args[0] === "pr" && args[1] === "view"
                ? JSON.stringify({
                    number: 7,
                    url: read.url,
                    title: read.title,
                    headRefName: read.headRef,
                    isCrossRepository: read.crossRepository === true,
                    state: merged.length > 0 ? "MERGED" : "OPEN",
                    headRefOid: read.headRefOid,
                  })
                : "",
            stderr: "",
            truncated: false,
          };
        }),
    });
    const provider = Layer.succeed(Pr, {
      status: () => Effect.sync(() => fresh.current ?? badge.current),
    } as unknown as Pr["Service"]);
    const checks = Layer.succeed(LocalChecks, {
      configuration: () =>
        Effect.succeed({
          project: "invented",
          config: {
            isolation: LOCAL_CHECK_ISOLATION,
            command: "invented-check",
          },
          reason: "local check configured for invented",
        }),
      lookup: () => Effect.succeed(undefined),
      ensure: (_dir, head, base) =>
        Effect.sync(() => {
          ensured.push(head);
          return running(head, base);
        }),
      latest: () => undefined,
      sweep: Effect.succeed({
        records: 0,
        logs: 0,
        logBytes: 0,
        work: 0,
        collected: 0,
        repos: 0,
      }),
    });
    const publisher = Layer.succeed(GitStatePublisher, {
      badgeFor: () => Effect.sync(() => badge.current),
      stateFor: () => Effect.succeed(undefined),
      extraBadgesFor: () => Effect.succeed([]),
      watchPrs: () => Effect.void,
      watchedBadge: () => Effect.succeed(undefined),
      lookupPr: () => Effect.succeed(Option.none()),
      stateForThread: () => Effect.succeed(undefined),
      refresh: () => Effect.void,
      reconcile: () => Effect.void,
      checksRead: () => Effect.void,
      sweep: Effect.void,
      sync: Effect.void,
      hold: () => Effect.succeed(Effect.void),
      observe: () => Effect.void,
    });
    const layer = MergeWhenReadyLive.pipe(
      Layer.provide(MergeFreezesNone),
      Layer.provideMerge(provider),
      Layer.provideMerge(proc),
      Layer.provideMerge(publisher),
      Layer.provideMerge(checks),
      Layer.provideMerge(GitRefresh.layer),
      Layer.provideMerge(RuntimeTestLayer),
      Layer.provideMerge(captureLogs({ printWarnings: true }).layer),
    );
    return yield* Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const thread = yield* runtimes.create({
        projectRoot: dir,
        checkout: { kind: "main", path: dir },
      });
      yield* Effect.addFinalizer(() => runtimes.close(thread.id).pipe(Effect.ignore));
      const workspaceId = Schema.decodeUnknownSync(WorkspaceId)("approval-provenance");
      yield* store.putWorkspace({
        workspace: {
          id: workspaceId,
          name: "Approval provenance",
          projectIds: [thread.projectId],
          homeProjectId: thread.projectId,
          createdAt: 1,
        },
        charter: { ...DEFAULT_CHARTER, mergeReviewPolicy: "solo" },
      });
      yield* runtimes.updateThread(thread.id, (t) => ({
        ...t,
        workspaceId,
        boundPr: {
          repo: REPO,
          number: 7,
          monitor: true,
          mergeWhenReady: intent,
        },
      }));
      return yield* body({
        service: yield* MergeWhenReady,
        threadId: thread.id,
        badge,
        fresh,
        ensured,
        merged,
        intent: () =>
          store.getThread(thread.id).pipe(
            Effect.map((t) => t.boundPr?.mergeWhenReady),
            Effect.orDie,
          ),
        notices: () =>
          store.listMessages(thread.id).pipe(
            Effect.map((messages) => messages.map((m) => JSON.stringify(m)).join("\n")),
            Effect.orDie,
          ),
      });
    }).pipe(Effect.scoped, Effect.provide(layer));
  }).pipe(Effect.scoped);

/** A while for anything wrongly started to show: the service's work is in-process and quick. */
const settle = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 300)));

describe("a user's merge approval on a fork PR", () => {
  it.live("checks the exact approved head, and a new fork push neither checks nor merges", () =>
    world(forkApproval, pr(), ({ service, threadId, badge, ensured, merged, intent, notices }) =>
      Effect.gen(function* () {
        yield* service.check(threadId);
        // The head the card named and the user approved: Gram may check it.
        yield* waitReal(
          "the approved head checked",
          Effect.sync(() => ensured.length > 0),
        );
        expect(ensured).toEqual([APPROVED]);
        // The fork author pushes again, and CI (theirs to control) goes green on it.
        badge.current = green({ headRefOid: PUSHED });
        yield* service.check(threadId);
        yield* waitReal("the approval dropped", intent().pipe(Effect.map((i) => i === undefined)));
        yield* service.check(threadId);
        yield* settle;
        expect(ensured).toEqual([APPROVED]);
        expect(merged).toEqual([]);
        const told = yield* notices();
        expect(told).toContain("was dropped");
        expect(told).toContain(`moved its head to ${PUSHED.slice(0, 7)}`);
        expect(told).toContain("new card");
      }),
    ),
  );

  it.live("a fork head that moves between the badge and the launch's fresh read isn't merged", () =>
    world(forkApproval, green(), ({ service, threadId, fresh, ensured, merged, intent }) =>
      Effect.gen(function* () {
        // The badge still shows the approved head; GitHub's fresh read at launch has the new one.
        fresh.current = green({ headRefOid: PUSHED });
        yield* service.check(threadId);
        yield* settle;
        expect(merged).toEqual([]);
        expect(ensured).toEqual([]);
        expect(yield* intent()).toBeDefined();
      }),
    ),
  );

  it.live("an approval stored before Gram recorded its head runs no check and merges nothing", () =>
    world(
      { method: "squash", allowedBy: "user", setAt: 1 },
      pr(),
      ({ service, threadId, badge, ensured, merged, intent, notices }) =>
        Effect.gen(function* () {
          yield* service.check(threadId);
          yield* waitReal(
            "the unpinned approval dropped",
            intent().pipe(Effect.map((i) => i === undefined)),
          );
          badge.current = green();
          yield* service.check(threadId);
          yield* settle;
          expect(ensured).toEqual([]);
          expect(merged).toEqual([]);
          expect(yield* notices()).toContain("its head is on a fork");
        }),
    ),
  );

  it.live("a badge that doesn't say whether the head is a fork's waits, unchecked", () =>
    world(
      { method: "squash", allowedBy: "user", setAt: 1 },
      unsaid(green()),
      ({ service, threadId, ensured, merged, intent }) =>
        Effect.gen(function* () {
          yield* service.check(threadId);
          yield* settle;
          expect(ensured).toEqual([]);
          expect(merged).toEqual([]);
          // Armed still: GitHub's next read may say.
          expect(yield* intent()).toBeDefined();
        }),
    ),
  );

  it.live("an autonomy intent never checks a fork's head", () =>
    world(
      { method: "squash", allowedBy: "autonomy", setAt: 1 },
      pr(),
      ({ service, threadId, ensured, merged, notices }) =>
        Effect.gen(function* () {
          yield* service.check(threadId);
          yield* waitReal(
            "the thread told why no check ran",
            notices().pipe(Effect.map((told) => told.includes("didn't start its own check"))),
          );
          expect(ensured).toEqual([]);
          expect(merged).toEqual([]);
        }),
    ),
  );

  it.live("local_check refuses a fork's head the user didn't approve", () =>
    world(
      {
        ...forkApproval,
        approved: { ...forkApproval.approved!, head: PUSHED },
      },
      pr(),
      ({ service, threadId, ensured }) =>
        Effect.gen(function* () {
          const started = yield* service.runLocalCheck(threadId);
          expect(started).toMatchObject({
            refused: expect.stringContaining("fork"),
          });
          expect(ensured).toEqual([]);
        }),
    ),
  );
});

describe("a user's merge approval and its base", () => {
  const sameRepo: MergeIntent = {
    method: "squash",
    allowedBy: "user",
    approved: {
      head: APPROVED,
      baseRef: "main",
      headRepo: REPO,
      crossRepository: false,
    },
    setAt: 1,
  };
  const ownBranch = { crossRepository: false, headRepo: REPO } as const;

  it.live("a retarget drops it: no check, no merge, until approved again", () =>
    world(
      sameRepo,
      green({ ...ownBranch, baseRef: "release" }),
      ({ service, threadId, ensured, merged, intent, notices }) =>
        Effect.gen(function* () {
          yield* service.check(threadId);
          yield* waitReal(
            "the approval dropped",
            intent().pipe(Effect.map((i) => i === undefined)),
          );
          yield* settle;
          expect(ensured).toEqual([]);
          expect(merged).toEqual([]);
          expect(yield* notices()).toContain("its base changed from main to release");
        }),
    ),
  );

  it.live("a retarget seen only by the launch's fresh read isn't followed", () =>
    world(sameRepo, green(ownBranch), ({ service, threadId, fresh, merged, intent }) =>
      Effect.gen(function* () {
        fresh.current = green({ ...ownBranch, baseRef: "release" });
        yield* service.check(threadId);
        yield* waitReal("the approval dropped", intent().pipe(Effect.map((i) => i === undefined)));
        yield* settle;
        expect(merged).toEqual([]);
      }),
    ),
  );

  it.live("an unpinned approval doesn't follow a retarget at launch", () =>
    world(
      { method: "squash", allowedBy: "user", setAt: 1 },
      green(ownBranch),
      ({ service, threadId, fresh, merged, intent }) =>
        Effect.gen(function* () {
          fresh.current = green({ ...ownBranch, baseRef: "release" });
          yield* service.check(threadId);
          yield* waitReal(
            "the approval dropped",
            intent().pipe(Effect.map((i) => i === undefined)),
          );
          yield* settle;
          expect(merged).toEqual([]);
        }),
    ),
  );

  it.live("a same-repo head that moved merges on CI but isn't checked on this machine", () =>
    world(
      sameRepo,
      pr({ ...ownBranch, headRefOid: PUSHED }),
      ({ service, threadId, badge, ensured, merged, notices }) =>
        Effect.gen(function* () {
          yield* service.check(threadId);
          // The thread holds no branch of it, and the user approved another head.
          yield* waitReal(
            "the thread told why no check ran",
            notices().pipe(Effect.map((told) => told.includes("didn't start its own check"))),
          );
          expect(ensured).toEqual([]);
          badge.current = green({ ...ownBranch, headRefOid: PUSHED });
          yield* service.check(threadId);
          yield* waitReal(
            "the merge on green CI",
            Effect.sync(() => merged.length > 0),
          );
          expect(merged[0]).toContain(PUSHED);
          expect(ensured).toEqual([]);
        }),
    ),
  );
});

describe("approvalLapse", () => {
  it("keeps an approval that still covers the PR and drops one that doesn't", () => {
    expect(approvalLapse(forkApproval, pr(), REPO)).toBeUndefined();
    expect(approvalLapse(forkApproval, pr({ headRefOid: PUSHED }), REPO)).toHaveProperty("drop");
    expect(approvalLapse(forkApproval, pr({ baseRef: "release" }), REPO)).toHaveProperty("drop");
    expect(approvalLapse(forkApproval, pr({ headRepo: "other/project" }), REPO)).toHaveProperty(
      "drop",
    );
    expect(approvalLapse(forkApproval, pr({ crossRepository: false }), REPO)).toHaveProperty(
      "drop",
    );
    expect(approvalLapse(forkApproval, unsaid(pr()), REPO)).toHaveProperty("wait");
    expect(
      approvalLapse({ ...forkApproval, allowedBy: "autonomy" }, pr({ headRefOid: PUSHED }), REPO),
    ).toBeUndefined();
  });
});
