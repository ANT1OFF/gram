import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_CHARTER,
  WorkspaceId,
  type PrStatus,
  type ThreadId,
  type ProjectId,
} from "@gram/contracts";
import { Pr, Proc } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadStore } from "../persistence/thread-store.ts";
import { RuntimeTestLayer } from "../runtime/test-harness.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { waitReal } from "../orchestration/test-harness.ts";
import { LocalChecks, LOCAL_CHECK_ISOLATION, type LocalCheck } from "./local-checks.ts";
import { MergeWhenReady, MergeWhenReadyLive } from "./merge-when-ready.ts";
import { GitRefresh } from "./platform.ts";
import { GitStatePublisher } from "./publisher.ts";

// Invented commits: two PRs of one repository, each checked locally on the same base.
const BASE = "b".repeat(40);
const MOVED = "c".repeat(40);
const HEADS: Record<number, string> = { 5: "5".repeat(40), 6: "6".repeat(40) };

const badgeOf = (number: number, base: string): PrStatus => ({
  number,
  state: "OPEN",
  url: `https://github.com/example/project/pull/${number}`,
  title: `PR ${number}`,
  isDraft: false,
  // No CI: only Gram's own check can let either merge.
  checks: "none",
  headMatches: true,
  aheadOfPr: false,
  headRefOid: HEADS[number]!,
  baseRefOid: base,
  baseRef: "main",
  headRef: `feat/${number}`,
  mergeState: "CLEAN",
});

describe("merges onto one base from two workspaces", () => {
  it.live.each([
    ["the second's check runs again on the moved base", true],
    ["a read that still names the old base launches nothing", false],
  ] as const)("launch one at a time: %s", (_name, moves) =>
    Effect.gen(function* () {
      const dirs = [5, 6].map(() => mkdtempSync(join(tmpdir(), "gram-merge-base-")));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true }))),
      );
      // GitHub as these PRs see it: the base moves when one merges, unless its reads lag.
      let base = BASE;
      const merged: Array<number> = [];
      let reads = 0;
      const proc = Layer.succeed(Proc, {
        run: (_bin, args) =>
          Effect.sync(() => {
            if (args[0] === "pr" && args[1] === "merge") {
              merged.push(Number(args[2]));
              if (moves) base = MOVED;
            }
            return { status: 0, stdout: "", stderr: "", truncated: false };
          }),
      });
      // Each fresh read waits a moment for the other's: unserialized, both read the old base.
      const provider = Layer.succeed(Pr, {
        status: (_cwd: string, bound?: { readonly number: number }) =>
          Effect.gen(function* () {
            reads++;
            const read = badgeOf(bound!.number, base);
            const until = Date.now() + 400;
            const others = () => reads < 2;
            while (others() && Date.now() < until) yield* Effect.sleep("10 millis");
            return read;
          }),
      } as unknown as Pr["Service"]);
      const passes = new Map<string, LocalCheck>();
      const ensured: Array<[string, string]> = [];
      const pass = (head: string, on: string): LocalCheck => {
        const key = `${head}:${on}`;
        if (!passes.has(key))
          passes.set(key, {
            head,
            base: on,
            tree: "d".repeat(40),
            status: "passed",
            command: "invented-check",
            isolation: LOCAL_CHECK_ISOLATION,
            startedAt: 1,
            finishedAt: 2,
            host: "invented",
          });
        return passes.get(key)!;
      };
      const checks = Layer.succeed(LocalChecks, {
        configuration: () =>
          Effect.succeed({
            project: "invented",
            config: { isolation: LOCAL_CHECK_ISOLATION, command: "invented-check" },
            reason: "local check configured for invented",
          }),
        // Both heads passed on the old base, and nothing else has a check yet.
        lookup: (_dir, head, on) =>
          Effect.succeed(head !== undefined && on === BASE ? pass(head, on) : undefined),
        ensure: (_dir, head, on) =>
          Effect.sync(() => {
            ensured.push([head, on]);
            return { ...pass(head, on), status: "running" as const };
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
      const badges = new Map<ThreadId, PrStatus>();
      const publisher = Layer.succeed(GitStatePublisher, {
        // The badges still name the old base: the publisher hasn't read the merge yet.
        badgeFor: (thread) => Effect.succeed(badges.get(thread.id)),
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
        Layer.provideMerge(provider),
        Layer.provideMerge(proc),
        Layer.provideMerge(publisher),
        Layer.provideMerge(checks),
        Layer.provideMerge(GitRefresh.layer),
        Layer.provideMerge(RuntimeTestLayer),
      );
      yield* Effect.gen(function* () {
        const runtimes = yield* ThreadRuntimes;
        const store = yield* ThreadStore;
        const threads: Array<ThreadId> = [];
        for (const [index, number] of [5, 6].entries()) {
          const thread = yield* runtimes.create({
            projectRoot: dirs[index]!,
            checkout: { kind: "main", path: dirs[index]! },
          });
          yield* Effect.addFinalizer(() => runtimes.close(thread.id).pipe(Effect.ignore));
          // Each in a workspace of its own.
          const workspaceId = Schema.decodeUnknownSync(WorkspaceId)(`base-lock-${number}`);
          yield* store.putWorkspace({
            workspace: {
              id: workspaceId,
              name: `Workspace ${number}`,
              projectIds: [thread.projectId as ProjectId],
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
              number,
              monitor: true,
              mergeWhenReady: { method: "squash", allowedBy: "user", setAt: 1 },
            },
          }));
          badges.set(thread.id, badgeOf(number, BASE));
          threads.push(thread.id);
        }
        const service = yield* MergeWhenReady;
        yield* Effect.all(
          threads.map((id) => service.check(id)),
          { concurrency: "unbounded" },
        );
        yield* waitReal(
          "a second merge, or the other's look after the first",
          Effect.sync(() =>
            moves ? merged.length > 1 || ensured.some(([, on]) => on === MOVED) : reads > 2,
          ),
        );
        // Let both attempts settle, each behind its thread's lock.
        for (const id of threads) yield* service.mutate(id, Effect.void);
        expect(merged).toHaveLength(1);
        const other = merged[0] === 5 ? 6 : 5;
        // The PR that didn't merge stays armed; with the base moved, its check was started again
        // on the new base, and never on the old one.
        expect(ensured).toEqual(moves ? expect.arrayContaining([[HEADS[other]!, MOVED]]) : []);
        expect(ensured.filter(([, on]) => on === BASE)).toEqual([]);
        expect(
          (yield* store.getThread(threads[other === 5 ? 0 : 1]!)).boundPr?.mergeWhenReady,
        ).toBeDefined();
      }).pipe(Effect.scoped, Effect.provide(layer));
    }).pipe(Effect.scoped),
  );
});
