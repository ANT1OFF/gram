import { describe, expect, it } from "@effect/vitest";
import { DEFAULT_CHARTER, WorkspaceId, type PrStatus, type ThreadId } from "@gram/contracts";
import { Pr, Proc } from "@gram/git";
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
import { LocalChecks, LOCAL_CHECK_ISOLATION, type LocalCheck } from "./local-checks.ts";
import { MergeWhenReady, MergeWhenReadyLive } from "./merge-when-ready.ts";
import { GitRefresh } from "./platform.ts";
import { GitStatePublisher } from "./publisher.ts";

// Invented commits of one PR, armed under solo with Gram's own check configured.
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);

const badgeWith = (checks: PrStatus["checks"]): PrStatus => ({
  number: 7,
  state: "OPEN",
  url: "https://github.com/example/project/pull/7",
  title: "PR 7",
  isDraft: false,
  checks,
  headMatches: true,
  aheadOfPr: false,
  headRefOid: HEAD,
  baseRefOid: BASE,
  baseRef: "main",
  headRef: "feat/seven",
  mergeState: checks === "passing" ? "CLEAN" : "UNSTABLE",
});

const ended = (failure: NonNullable<LocalCheck["failure"]>, reason: string): LocalCheck => ({
  head: HEAD,
  base: BASE,
  tree: "c".repeat(40),
  status: "failed",
  command: "invented-check",
  isolation: LOCAL_CHECK_ISOLATION,
  startedAt: 1,
  finishedAt: 2,
  host: "invented",
  reason,
  failure,
});

describe("an armed merge after Gram's own check fails", () => {
  it.live.each([
    ["timed out", ended({ kind: "timed-out" }, "timed out: still running after 90 minutes")],
    ["stopped", ended({ kind: "stopped" }, "Gram quit while it ran")],
    ["failed", ended({ kind: "exited", exitCode: 1 }, "exited 1")],
  ] as const)("merges on CI that went green meanwhile, unarmed again: %s", ([, outcome]) =>
    Effect.gen(function* () {
      const dir = mkdtempSync(join(tmpdir(), "gram-merge-after-check-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
      );
      // CI is running when the merge is armed; Gram's own check starts beside it.
      let badge = badgeWith("pending");
      const merged: Array<ReadonlyArray<string>> = [];
      const proc = Layer.succeed(Proc, {
        run: (_bin, args) =>
          Effect.sync(() => {
            if (args[0] === "pr" && args[1] === "merge") merged.push([...args]);
            return { status: 0, stdout: "", stderr: "", truncated: false };
          }),
      });
      const provider = Layer.succeed(Pr, {
        status: () => Effect.sync(() => badge),
      } as unknown as Pr["Service"]);
      const done: Array<(check: LocalCheck) => Effect.Effect<void>> = [];
      const checks = Layer.succeed(LocalChecks, {
        configuration: () =>
          Effect.succeed({
            project: "invented",
            config: { isolation: LOCAL_CHECK_ISOLATION, command: "invented-check" },
            reason: "local check configured for invented",
          }),
        // No pass: running, then failed.
        lookup: () => Effect.succeed(undefined),
        ensure: (_dir, head, base, options) =>
          Effect.sync(() => {
            done.push(options.onDone);
            return { ...ended({ kind: "stopped" }, ""), head, base, status: "running" as const };
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
        badgeFor: () => Effect.sync(() => badge),
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
        // No badge change is announced: CI went green while the check still ran.
        observe: () => Effect.void,
      });
      const layer = MergeWhenReadyLive.pipe(
        Layer.provideMerge(provider),
        Layer.provideMerge(proc),
        Layer.provideMerge(publisher),
        Layer.provideMerge(checks),
        Layer.provideMerge(GitRefresh.layer),
        Layer.provideMerge(RuntimeTestLayer),
        // Turns and merges log as they go; a warning would be news.
        Layer.provideMerge(captureLogs({ printWarnings: true }).layer),
      );
      yield* Effect.gen(function* () {
        const runtimes = yield* ThreadRuntimes;
        const store = yield* ThreadStore;
        const thread = yield* runtimes.create({
          projectRoot: dir,
          checkout: { kind: "main", path: dir },
        });
        yield* Effect.addFinalizer(() => runtimes.close(thread.id).pipe(Effect.ignore));
        const workspaceId = Schema.decodeUnknownSync(WorkspaceId)("after-check");
        yield* store.putWorkspace({
          workspace: {
            id: workspaceId,
            name: "After check",
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
            repo: "example/project",
            number: 7,
            monitor: true,
            mergeWhenReady: { method: "squash", allowedBy: "user", setAt: 1 },
          },
        }));
        const service = yield* MergeWhenReady;
        yield* service.check(thread.id as ThreadId);
        yield* waitReal(
          "Gram's own check started",
          Effect.sync(() => done.length > 0),
        );
        expect(merged).toEqual([]);
        // Each look while it runs (a badge change, say) listens no more: its end is told once.
        yield* service.check(thread.id as ThreadId);
        yield* service.check(thread.id as ThreadId);
        expect(done).toHaveLength(1);
        // CI passes on the exact head while the check is still running, then the check ends.
        badge = badgeWith("passing");
        yield* done[0]!(outcome);
        yield* waitReal(
          "the merge, with nothing armed again",
          Effect.sync(() => merged.length > 0),
        );
        expect(merged).toEqual([
          [
            "pr",
            "merge",
            "7",
            "--squash",
            "--match-head-commit",
            HEAD,
            "--repo",
            "example/project",
          ],
        ]);
        yield* waitReal(
          "the intent done with",
          store
            .getThread(thread.id)
            .pipe(Effect.map((t) => t.boundPr?.mergeWhenReady === undefined)),
        );
      }).pipe(Effect.scoped, Effect.provide(layer));
    }).pipe(Effect.scoped),
  );
});
