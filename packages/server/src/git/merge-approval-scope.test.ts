import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_CHARTER,
  WorkspaceId,
  type MergeIntent,
  type PrStatus,
  type ThreadId,
} from "@gram/contracts";
import { Pr, Proc } from "@gram/git";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadStore } from "../persistence/thread-store.ts";
import { captureLogs } from "@gram/agents/testing/logs";
import { RuntimeTestLayer } from "../runtime/test-harness.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { waitReal } from "../orchestration/test-harness.ts";
import { LocalChecks, LOCAL_CHECK_ISOLATION } from "./local-checks.ts";
import { MergeFreezesNone } from "./merge-freezes.ts";
import { approvalBlocker, MergeWhenReady, MergeWhenReadyLive } from "./merge-when-ready.ts";
import { GitRefresh } from "./platform.ts";
import { GitStatePublisher } from "./publisher.ts";

// Invented commits of one PR, armed under solo with Gram's own check configured. The thread binds
// the PR from its main checkout, so the PR is not its own: only the user's approval covers it.
const HEAD = "a".repeat(40);
const PUSHED = "d".repeat(40);
const BASE = "b".repeat(40);

const prBadge = (overrides: Partial<PrStatus> = {}): PrStatus => ({
  number: 7,
  state: "OPEN",
  url: "https://github.com/example/project/pull/7",
  title: "PR 7",
  isDraft: false,
  checks: "passing",
  headMatches: true,
  aheadOfPr: false,
  headRefOid: HEAD,
  baseRefOid: BASE,
  baseTipOid: BASE,
  baseRef: "main",
  headRef: "patch-1",
  mergeState: "CLEAN",
  ...overrides,
});

const approvedOn = (fork: boolean): MergeIntent => ({
  method: "squash",
  allowedBy: "user",
  approved: {
    head: HEAD,
    baseRef: "main",
    fork,
    ...(fork ? { headRepo: "outsider/project" } : {}),
  },
  setAt: 1,
});

describe("approvalBlocker", () => {
  it("pins a fork's approval to its head and every approval to its base", () => {
    expect(approvalBlocker(approvedOn(true), prBadge())).toBeUndefined();
    expect(approvalBlocker(approvedOn(true), prBadge({ headRefOid: PUSHED }))).toMatch(
      /head is on a fork \(outsider\/project\) and moved from aaaaaaa, the head the user approved, to ddddddd/,
    );
    expect(approvalBlocker(approvedOn(false), prBadge({ headRefOid: PUSHED }))).toBeUndefined();
    for (const fork of [true, false])
      expect(approvalBlocker(approvedOn(fork), prBadge({ baseRef: "release" }))).toMatch(
        /base changed from main to release after the user approved it; call merge_when_ready again/,
      );
    const { baseRef: _base, ...unknownBase } = prBadge();
    expect(approvalBlocker(approvedOn(false), unknownBase)).toBe("its base branch isn't known yet");
    // An approval recorded before Gram recorded what it covers asks again; autonomy rechecks
    // ownership at launch instead.
    const { approved: _, ...legacy } = approvedOn(false);
    expect(approvalBlocker(legacy, prBadge())).toMatch(/doesn't say which head and base/);
    expect(approvalBlocker({ ...legacy, allowedBy: "autonomy" }, prBadge())).toBeUndefined();
  });
});

/** The merge service over one thread bound to `example/project#7`, armed with `intent`. */
const armed = (intent: MergeIntent, first: PrStatus) =>
  Effect.gen(function* () {
    const dir = mkdtempSync(join(tmpdir(), "gram-merge-approval-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
    );
    const world = {
      badge: first,
      merged: [] as Array<ReadonlyArray<string>>,
      ensured: [] as Array<string>,
    };
    const proc = Layer.succeed(Proc, {
      run: (_bin, args) =>
        Effect.sync(() => {
          if (args[0] === "pr" && args[1] === "merge") world.merged.push([...args]);
          return {
            status: 0,
            stdout:
              args[0] === "pr" && args[1] === "view"
                ? JSON.stringify({
                    state: world.merged.length > 0 ? "MERGED" : "OPEN",
                    headRefOid: world.badge.headRefOid,
                  })
                : "",
            stderr: "",
            truncated: false,
          };
        }),
    });
    const provider = Layer.succeed(Pr, {
      status: () => Effect.sync(() => world.badge),
    } as unknown as Pr["Service"]);
    const checks = Layer.succeed(LocalChecks, {
      configuration: () =>
        Effect.succeed({
          project: "invented",
          config: { isolation: LOCAL_CHECK_ISOLATION, command: "invented-check" },
          reason: "local check configured for invented",
        }),
      lookup: () => Effect.succeed(undefined),
      // Running, never ending: what matters is which heads it was asked to run.
      ensure: (_dir, head, base) =>
        Effect.sync(() => {
          world.ensured.push(head);
          return {
            head,
            base,
            tree: "c".repeat(40),
            status: "running" as const,
            command: "invented-check",
            isolation: LOCAL_CHECK_ISOLATION,
            startedAt: 1,
            host: "invented",
          };
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
      badgeFor: () => Effect.sync(() => world.badge),
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
    const context = yield* Layer.build(layer);
    const runtimes = Context.get(context, ThreadRuntimes);
    const store = Context.get(context, ThreadStore);
    const service = Context.get(context, MergeWhenReady);
    const thread = yield* runtimes.create({
      projectRoot: dir,
      checkout: { kind: "main", path: dir },
    });
    yield* Effect.addFinalizer(() => runtimes.close(thread.id).pipe(Effect.ignore));
    const workspaceId = Schema.decodeUnknownSync(WorkspaceId)("approval-scope");
    yield* store.putWorkspace({
      workspace: {
        id: workspaceId,
        name: "Approval scope",
        projectIds: [thread.projectId],
        homeProjectId: thread.projectId,
        createdAt: 1,
      },
      charter: { ...DEFAULT_CHARTER, mergeReviewPolicy: "solo" },
    });
    yield* runtimes.updateThread(thread.id, (t) => ({
      ...t,
      workspaceId,
      boundPr: { repo: "example/project", number: 7, monitor: true, mergeWhenReady: intent },
    }));
    const look = service.check(thread.id as ThreadId);
    const waiting = store
      .getThread(thread.id)
      .pipe(Effect.map((t) => t.boundPr?.mergeWaiting?.why));
    return { world, look, waiting, store, threadId: thread.id };
  });

/** Long enough for a launch the look started to reach `gh pr merge`, were it to. */
const settle = Effect.sleep("300 millis");

describe("a user's merge approval covers what its card named", () => {
  it.live("a push to a fork after the approval is neither checked nor merged", () =>
    Effect.gen(function* () {
      const { world, look, waiting } = yield* armed(
        approvedOn(true),
        prBadge({ checks: "pending", mergeState: "UNSTABLE" }),
      );
      // The approved head: Gram's own check runs it, as the card said.
      yield* look;
      expect(world.ensured).toEqual([HEAD]);
      // The fork's author pushes: green CI and a clean merge state change nothing.
      world.badge = prBadge({ headRefOid: PUSHED });
      yield* look;
      yield* settle;
      expect(world.ensured).toEqual([HEAD]);
      expect(world.merged).toEqual([]);
      expect(yield* waiting).toMatch(/head is on a fork .* call merge_when_ready again/);
    }).pipe(Effect.scoped),
  );

  it.live("the approved fork head merges, pinned to it", () =>
    Effect.gen(function* () {
      const { world, look } = yield* armed(approvedOn(true), prBadge());
      yield* look;
      yield* waitReal(
        "the merge",
        Effect.sync(() => world.merged.length > 0),
      );
      expect(world.merged[0]).toContain(HEAD);
    }).pipe(Effect.scoped),
  );

  it.live.each([true, false])("a retarget is neither checked nor merged (fork: %s)", (fork) =>
    Effect.gen(function* () {
      const { world, look, waiting } = yield* armed(
        approvedOn(fork),
        prBadge({ baseRef: "release" }),
      );
      yield* look;
      yield* settle;
      expect(world.ensured).toEqual([]);
      expect(world.merged).toEqual([]);
      expect(yield* waiting).toMatch(/base changed from main to release/);
    }).pipe(Effect.scoped),
  );

  it.live("a new head in the repository itself merges on CI, but isn't checked here", () =>
    Effect.gen(function* () {
      const { world, look, waiting } = yield* armed(
        approvedOn(false),
        prBadge({ headRefOid: PUSHED, checks: "pending", mergeState: "UNSTABLE" }),
      );
      // Not the thread's own PR, and not the head the user approved: its code doesn't run here.
      yield* look;
      expect(world.ensured).toEqual([]);
      expect(yield* waiting).toMatch(/doesn't run its own check of ddddddd on this machine/);
      world.badge = prBadge({ headRefOid: PUSHED });
      yield* look;
      yield* waitReal(
        "the merge",
        Effect.sync(() => world.merged.length > 0),
      );
      expect(world.merged[0]).toContain(PUSHED);
      expect(world.ensured).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.live("an approval that doesn't say what it covers merges nothing", () =>
    Effect.gen(function* () {
      const { approved: _, ...legacy } = approvedOn(false);
      const { world, look, waiting } = yield* armed(legacy, prBadge());
      yield* look;
      yield* settle;
      expect(world.ensured).toEqual([]);
      expect(world.merged).toEqual([]);
      expect(yield* waiting).toMatch(/doesn't say which head and base it covers/);
    }).pipe(Effect.scoped),
  );
});
