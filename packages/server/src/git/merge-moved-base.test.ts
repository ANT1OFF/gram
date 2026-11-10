import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_CHARTER,
  WorkspaceId,
  type PrStatus,
  type ProjectId,
  type ThreadId,
} from "@gram/contracts";
import { Pr, Proc, ProcTimeout } from "@gram/git";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveMergeFenceTool } from "../app-tools/resolve-merge-fence.ts";
import { approvalFor, bindAppTools } from "../app-tools/registry.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { captureLogs } from "@gram/agents/testing/logs";
import { RuntimeTestLayer } from "../runtime/test-harness.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { waitReal } from "../orchestration/test-harness.ts";
import { LocalChecks, LOCAL_CHECK_ISOLATION, type LocalCheck } from "./local-checks.ts";
import type { EventHub } from "../events/event-hub.ts";
import { type MergeFreezes, MergeFreezesNone } from "./merge-freezes.ts";
import { MergeRecheckMs, MergeWhenReady, MergeWhenReadyLive } from "./merge-when-ready.ts";
import { GitRefresh } from "./platform.ts";
import { GitStatePublisher } from "./publisher.ts";

// Invented commits. GitHub's `baseRefOid` is the base a PR last synced with: it stays at RECORDED
// until the PR is pushed to, while the branch's tip moves with every merge.
const RECORDED = "e".repeat(40);
const headOf = (number: number) => String(number).repeat(40);
const tipAfter = (merges: number) =>
  merges === 0 ? RECORDED : String.fromCharCode(0x60 + merges).repeat(40);

const badgeOf = (number: number, tip: string): PrStatus => ({
  number,
  state: "OPEN",
  url: `https://github.com/example/project/pull/${number}`,
  title: `PR ${number}`,
  isDraft: false,
  // No CI: only Gram's own check can let any of them merge.
  checks: "none",
  headMatches: true,
  aheadOfPr: false,
  headRefOid: headOf(number),
  baseRefOid: RECORDED,
  baseTipOid: tip,
  baseRef: "main",
  headRef: `feat/${number}`,
  mergeState: "CLEAN",
});

const record = (head: string, base: string, status: LocalCheck["status"]): LocalCheck => ({
  head,
  base,
  tree: "d".repeat(40),
  status,
  command: "invented-check",
  isolation: LOCAL_CHECK_ISOLATION,
  startedAt: 1,
  ...(status === "running" ? {} : { finishedAt: 2 }),
  host: "invented",
});

const ok = (stdout = "") => ({ status: 0, stdout, stderr: "", truncated: false });

/** Lost: `gh` timed out. Reset: it exited 1. Hung: it never answers, until it is interrupted. */
type LaunchFate =
  | "lost-applied"
  | "lost-unapplied"
  | "reset-applied"
  | "refused"
  | "hung-applied"
  | "queued";

interface Options {
  readonly numbers: ReadonlyArray<number>;
  /** Passes Gram already holds: every PR on the recorded base, as the armed PRs of the stall had. */
  readonly passed?: ReadonlyArray<readonly [number, string]>;
  /** What a check ends with; a pass unless this says otherwise. */
  readonly outcome?: (head: string, base: string) => "passed" | "failed";
  /** What GitHub's merge does to the tip; by default it moves. */
  readonly stuckTip?: boolean;
  /** What becomes of the nth merge launched; by default GitHub applies it and answers. */
  readonly launch?: (nth: number) => LaunchFate | undefined;
  /** What `gh pr view` says of a PR's state; by default the truth. */
  readonly stateRead?: () => string;
  readonly headRead?: () => string;
  readonly branchTip?: () => string | undefined;
  readonly branchRead?: () => Effect.Effect<void>;
  /** The wait between rechecks; short by default. */
  readonly recheckMs?: number;
  /** How long GitHub takes to answer a read. */
  readonly readMs?: number;
  /** The synthetic runner's clock before check preparation; wall time by default. */
  readonly checkNow?: () => number;
  /** A read that fails, for the PR it names. */
  readonly unreadable?: (number: number) => boolean;
}

/** Armed PRs of one repository under solo, in a GitHub and a check runner that these tests drive. */
const scenario = <E, R>(
  options: Options,
  body: (world: {
    readonly service: MergeWhenReady["Service"];
    readonly restart: Effect.Effect<MergeWhenReady["Service"]>;
    readonly store: ThreadStore["Service"];
    readonly threads: ReadonlyArray<ThreadId>;
    /** The PRs merged on GitHub, whatever Gram heard of it. */
    readonly merged: ReadonlyArray<number>;
    /** The PRs Gram launched a merge of, in order. */
    readonly launches: ReadonlyArray<number>;
    /** The base moves on, as a read that had lagged catches up. */
    readonly moveTip: () => void;
    /** Every check started, in order. */
    readonly ensured: ReadonlyArray<readonly [string, string]>;
    /** The most checks that ran at once. */
    readonly mostAtOnce: () => number;
    readonly notices: () => Effect.Effect<ReadonlyArray<string>>;
    /** Ends the check of that head on that base, as `Options.outcome` says. */
    readonly finish: (head: string, base: string) => Effect.Effect<void>;
    readonly running: () => ReadonlyArray<string>;
    readonly tip: () => string;
  }) => Effect.Effect<void, E, R>,
) =>
  Effect.gen(function* () {
    const dirs = options.numbers.map(() => mkdtempSync(join(tmpdir(), "gram-moved-base-")));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true }))),
    );
    let merges = 0;
    const tip = () => tipAfter(merges);
    const merged: Array<number> = [];
    const launches: Array<number> = [];
    const proc = Layer.succeed(Proc, {
      run: (_bin, args) =>
        Effect.suspend(() => {
          const number = Number(args[2]);
          if (args[0] === "pr" && args[1] === "view")
            return Effect.succeed(
              ok(
                args.includes("state,headRefOid")
                  ? JSON.stringify({
                      state: options.stateRead?.() ?? (merged.includes(number) ? "MERGED" : "OPEN"),
                      headRefOid: options.headRead?.() ?? headOf(number),
                    })
                  : (options.stateRead?.() ?? (merged.includes(number) ? "MERGED" : "OPEN")),
              ),
            );
          if (args[0] === "api" && args[1]?.includes("/branches/"))
            return Effect.succeed(
              options.branchTip !== undefined && options.branchTip() === undefined
                ? { ...ok(), status: 1 }
                : ok(JSON.stringify({ commit: { sha: options.branchTip?.() ?? tip() } })),
            ).pipe(Effect.tap(() => options.branchRead?.() ?? Effect.void));

          if (args[0] !== "pr" || args[1] !== "merge") return Effect.succeed(ok());
          launches.push(number);
          const fate = options.launch?.(launches.length);
          if (fate !== "lost-unapplied" && fate !== "refused" && fate !== "queued") {
            merged.push(number);
            if (options.stuckTip !== true) merges++;
          }
          if (fate === "hung-applied") return Effect.never;
          if (fate === "lost-applied" || fate === "lost-unapplied")
            return Effect.fail(new ProcTimeout({ bin: "gh", message: "invented: timed out" }));
          return Effect.succeed(
            fate === "reset-applied" || fate === "refused"
              ? {
                  ...ok(),
                  status: 1,
                  stderr:
                    fate === "refused"
                      ? "GraphQL: Pull Request is not mergeable (mergePullRequest)"
                      : "invented: gh failed",
                }
              : ok(),
          );
        }),
    });
    const current = (number: number): PrStatus => ({
      ...badgeOf(number, tip()),
      state: merged.includes(number) ? "MERGED" : "OPEN",
    });
    const provider = Layer.succeed(Pr, {
      status: (_cwd: string, bound?: { readonly number: number }) =>
        options.unreadable?.(bound!.number) === true
          ? Effect.fail({ message: "invented: GitHub unreachable" })
          : Effect.sleep(Duration.millis(options.readMs ?? 0)).pipe(
              Effect.map(() => current(bound!.number)),
            ),
    } as unknown as Pr["Service"]);
    const records = new Map<string, LocalCheck>();
    for (const [number, base] of options.passed ?? [])
      records.set(`${headOf(number)}:${base}`, record(headOf(number), base, "passed"));
    const listeners = new Map<string, Array<(check: LocalCheck) => Effect.Effect<void>>>();
    const ensured: Array<readonly [string, string]> = [];
    let mostAtOnce = 0;
    const checks = Layer.succeed(LocalChecks, {
      configuration: () =>
        Effect.succeed({
          project: "invented",
          config: { isolation: LOCAL_CHECK_ISOLATION, command: "invented-check" },
          reason: "local check configured for invented",
        }),
      lookup: (_dir, head, base) => Effect.sync(() => records.get(`${head}:${base}`)),
      ensure: (_dir, head, base, { onDone, after }) =>
        Effect.sync(() => {
          const key = `${head}:${base}`;
          const known = records.get(key);
          if (known?.status === "running") listeners.get(key)!.push(onDone);
          if (
            known !== undefined &&
            !(known.status === "passed" && after !== undefined && known.startedAt <= after)
          )
            return known;
          ensured.push([head, base]);
          // This fake skips real check preparation. Its new start must be later than the
          // reconciliation cutoff even if both happen in the same wall-clock millisecond.
          const running = {
            ...record(head, base, "running"),
            startedAt: Math.max(options.checkNow?.() ?? Date.now(), (after ?? 0) + 1),
          };
          records.set(key, running);
          listeners.set(key, [onDone]);
          mostAtOnce = Math.max(mostAtOnce, listeners.size);
          return running;
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
      // Caught up: merge-base-lock.test.ts has a publisher that hasn't.
      badgeFor: (thread) =>
        Effect.sync(() =>
          thread.boundPr === undefined ? undefined : current(thread.boundPr.number),
        ),
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
      Layer.provideMerge(MergeFreezesNone),
      Layer.provideMerge(provider),
      Layer.provideMerge(proc),
      Layer.provideMerge(publisher),
      Layer.provideMerge(checks),
      Layer.provideMerge(GitRefresh.layer),
      Layer.provideMerge(Layer.succeed(MergeRecheckMs, options.recheckMs ?? 20)),
      Layer.provideMerge(RuntimeTestLayer),
      Layer.provideMerge(captureLogs({ printWarnings: false }).layer),
    );
    yield* Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const threads: Array<ThreadId> = [];
      for (const [index, number] of options.numbers.entries()) {
        const thread = yield* runtimes.create({
          projectRoot: dirs[index]!,
          checkout: { kind: "main", path: dirs[index]! },
        });
        yield* Effect.addFinalizer(() => runtimes.close(thread.id).pipe(Effect.ignore));
        const workspaceId = Schema.decodeUnknownSync(WorkspaceId)(`moved-base-${number}`);
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
            mergeWhenReady: { method: "squash", allowedBy: "user", setAt: index + 1 },
          },
        }));
        threads.push(thread.id);
      }
      const service = yield* MergeWhenReady;
      const scope = yield* Effect.scope;
      const restartContext = yield* Effect.context<
        | ThreadStore
        | ThreadRuntimes
        | GitStatePublisher
        | EventHub
        | Proc
        | Pr
        | GitRefresh
        | MergeFreezes
      >();
      yield* body({
        service,
        restart: Effect.map(
          Layer.buildWithScope(Layer.fresh(MergeWhenReadyLive), scope).pipe(
            Effect.provide(restartContext),
          ),
          (context) => Context.get(context, MergeWhenReady),
        ),
        store,
        threads,
        merged,
        launches,
        moveTip: () => {
          merges++;
        },
        ensured,
        mostAtOnce: () => mostAtOnce,
        tip,
        running: () => [...listeners.keys()],
        notices: () =>
          Effect.gen(function* () {
            const texts: Array<string> = [];
            for (const id of threads)
              for (const message of yield* store.listMessages(id))
                texts.push(JSON.stringify(message));
            return texts;
          }),
        finish: (head, base) =>
          Effect.gen(function* () {
            const key = `${head}:${base}`;
            const ended = {
              ...record(head, base, options.outcome?.(head, base) ?? "passed"),
              startedAt: records.get(key)?.startedAt ?? 1,
            };
            records.set(key, ended);
            const waiting = listeners.get(key) ?? [];
            listeners.delete(key);
            for (const done of waiting) yield* done(ended);
          }),
      });
    }).pipe(Effect.scoped, Effect.provide(layer));
  }).pipe(Effect.scoped);

const ids = (head: string) => Number(head[0]);

/** #5's turn left standing for a recheck's while after its pass, its merge refused; the others queue on it. */
const lingering = (world: {
  readonly service: MergeWhenReady["Service"];
  readonly threads: ReadonlyArray<ThreadId>;
  readonly launches: ReadonlyArray<number>;
  readonly running: () => ReadonlyArray<string>;
  readonly finish: (head: string, base: string) => Effect.Effect<void>;
}) =>
  Effect.gen(function* () {
    yield* world.service.check(world.threads[0]!);
    yield* waitReal(
      "the first's check runs and holds the turn",
      Effect.sync(() => world.running().some((key) => ids(key) === 5)),
    );
    for (const id of world.threads.slice(1)) yield* world.service.check(id);
    yield* world.finish(headOf(5), RECORDED);
    yield* waitReal(
      "the first's merge refused",
      Effect.sync(() => world.launches.includes(5)),
    );
  });

const disarm = (store: ThreadStore["Service"], id: ThreadId) =>
  store.updateThread(id, (t) => {
    if (t.boundPr === undefined) return t;
    const { mergeWhenReady: _gone, ...rest } = t.boundPr;
    return { ...t, boundPr: rest };
  });

const waitsOn = (store: ThreadStore["Service"], id: ThreadId, number: number) =>
  Effect.map(
    store.getThread(id),
    (t) => t.boundPr?.mergeWaiting?.why.includes(`project#${number}, whose merge`) === true,
  );

describe("armed merges on a base that moved", () => {
  it.live("one merges and the next doesn't stall on the base GitHub recorded for it", () =>
    scenario(
      {
        numbers: [5, 6],
        passed: [
          [5, RECORDED],
          [6, RECORDED],
        ],
      },
      ({ service, threads, merged, ensured, finish, tip }) =>
        Effect.gen(function* () {
          yield* service.check(threads[0]!);
          yield* waitReal(
            "the first merged",
            Effect.sync(() => merged.length === 1),
          );
          // Its pass was on the old tip: the check runs again on the real one, and then it merges.
          yield* waitReal(
            "the second's check on the new tip",
            Effect.sync(() => ensured.length === 1),
          );
          expect(ensured).toEqual([[headOf(6), tip()]]);
          yield* finish(headOf(6), tip());
          yield* waitReal(
            "the second merged",
            Effect.sync(() => merged.length === 2),
          );
          expect(merged).toEqual([5, 6]);
        }),
    ),
  );

  it.live("a queue of N costs N checks, one at a time", () =>
    scenario(
      { numbers: [5, 6, 7], passed: [[5, RECORDED]] },
      ({ service, threads, merged, ensured, finish, mostAtOnce, running }) =>
        Effect.gen(function* () {
          yield* service.check(threads[0]!);
          yield* waitReal(
            "the first merged",
            Effect.sync(() => merged.length === 1),
          );
          for (const expected of [2, 3]) {
            yield* waitReal(
              "one check running",
              Effect.sync(() => running().length === 1),
            );
            const [head, base] = running()[0]!.split(":");
            yield* finish(head!, base!);
            yield* waitReal(
              "that PR merged",
              Effect.sync(() => merged.length === expected),
            );
          }
          expect(merged.toSorted()).toEqual([5, 6, 7]);
          expect(ensured).toHaveLength(2);
          expect(mostAtOnce()).toBe(1);
        }),
    ),
  );

  it.live("the merged PR's own state doesn't cut off the look at the others", () =>
    scenario(
      { numbers: [5, 6, 7], passed: [[5, RECORDED]], readMs: 40 },
      ({ service, threads, merged, running }) =>
        Effect.gen(function* () {
          yield* service.check(threads[0]!);
          yield* waitReal(
            "the first merged",
            Effect.sync(() => merged.length === 1),
          );
          // What the publisher does when it reads the merge: stops that thread's attempt.
          yield* service.check(threads[0]!);
          yield* waitReal(
            "the next PR's check",
            Effect.sync(() => running().length === 1),
          );
        }),
    ),
  );

  it.live("a failed check hands the turn on, and the failed PR stays armed", () =>
    scenario(
      {
        numbers: [5, 6, 7],
        passed: [[5, RECORDED]],
        outcome: (head) => (ids(head) === 6 ? "failed" : "passed"),
      },
      ({ service, store, threads, merged, finish, running }) =>
        Effect.gen(function* () {
          yield* service.check(threads[0]!);
          yield* waitReal(
            "the first merged",
            Effect.sync(() => merged.length === 1),
          );
          yield* waitReal(
            "one check running",
            Effect.sync(() => running().length === 1),
          );
          const first = running()[0]!.split(":");
          expect(ids(first[0]!)).toBe(6);
          yield* finish(first[0]!, first[1]!);
          yield* waitReal(
            "the next PR's check",
            Effect.sync(() => running().some((key) => ids(key) === 7)),
          );
          const next = running()[0]!.split(":");
          yield* finish(next[0]!, next[1]!);
          yield* waitReal(
            "the next PR merged",
            Effect.sync(() => merged.includes(7)),
          );
          expect(merged).not.toContain(6);
          expect((yield* store.getThread(threads[1]!)).boundPr?.mergeWhenReady).toBeDefined();
        }),
    ),
  );

  describe("a turn whose holder is no longer armed", () => {
    // #5 takes the turn, its check passes, and its merge is refused: it stays armed and keeps the
    // turn for a recheck's while (long here), its check no longer running. The others queue on it.
    const LINGER = { passed: [], launch: () => "refused" as const, recheckMs: 60_000 };

    it.live("passes on once the holder's PR merged, so the next doesn't wait forever", () =>
      scenario({ numbers: [5, 6], ...LINGER }, (world) =>
        Effect.gen(function* () {
          const { service, store, threads, ensured } = world;
          yield* lingering(world);
          yield* service.check(threads[1]!);
          expect(yield* waitsOn(store, threads[1]!, 5)).toBe(true);
          // Merged by someone else, say: its intent is gone, its turn left behind.
          yield* disarm(store, threads[0]!);
          yield* service.check(threads[1]!);
          yield* waitReal(
            "the second takes the turn",
            Effect.sync(() => ensured.some(([head]) => ids(head) === 6)),
          );
          expect((yield* store.getThread(threads[1]!)).boundPr?.mergeWaiting).toBeUndefined();
        }),
      ),
    );

    it.live("goes to one of two PRs that find it stale at once, and they don't run together", () =>
      scenario({ numbers: [5, 6, 7], ...LINGER }, (world) =>
        Effect.gen(function* () {
          const { service, store, threads, ensured, mostAtOnce } = world;
          yield* lingering(world);
          yield* disarm(store, threads[0]!);
          // Reading the stale holder takes a while: both look while the other is reading.
          const original = store.getThread;
          store.getThread = (id) =>
            id === threads[0]
              ? Effect.sleep(Duration.millis(30)).pipe(Effect.andThen(original(id)))
              : original(id);
          yield* Effect.all([service.check(threads[1]!), service.check(threads[2]!)], {
            concurrency: "unbounded",
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                store.getThread = original;
              }),
            ),
          );
          yield* waitReal(
            "one takes the turn",
            Effect.sync(() => ensured.some(([head]) => ids(head) !== 5)),
          );
          yield* Effect.sleep(Duration.millis(100));
          const took = ensured.filter(([head]) => ids(head) !== 5).map(([head]) => ids(head));
          expect(took).toHaveLength(1);
          expect(mostAtOnce()).toBe(1);
          const other = took[0] === 6 ? threads[2]! : threads[1]!;
          expect(yield* waitsOn(store, other, took[0]!)).toBe(true);
        }),
      ),
    );

    it.live("stays with its holder when it is re-armed while another PR drops it", () =>
      scenario({ numbers: [5, 6], ...LINGER }, (world) =>
        Effect.gen(function* () {
          const { service, store, threads, ensured } = world;
          yield* lingering(world);
          yield* disarm(store, threads[0]!);
          // The holder is re-armed as #6 comes to drop it: the re-arm wins.
          const rearming = yield* Deferred.make<void>();
          const rearm = yield* service
            .mutate(
              threads[0]!,
              Deferred.succeed(rearming, undefined).pipe(
                Effect.andThen(Effect.sleep(Duration.millis(50))),
                Effect.andThen(
                  store.updateThread(threads[0]!, (t) => ({
                    ...t,
                    boundPr: {
                      ...t.boundPr!,
                      mergeWhenReady: { method: "squash", allowedBy: "user", setAt: 99 },
                    },
                  })),
                ),
              ),
            )
            .pipe(Effect.forkScoped);
          yield* Deferred.await(rearming);
          yield* service.check(threads[1]!);
          yield* Fiber.join(rearm);
          expect(ensured.some(([head]) => ids(head) === 6)).toBe(false);
          expect(yield* waitsOn(store, threads[1]!, 5)).toBe(true);
        }),
      ),
    );

    it.live("stays with a holder whose check still runs, armed or not", () =>
      scenario(
        { numbers: [5, 6], passed: [] },
        ({ service, store, threads, ensured, running, finish, mostAtOnce }) =>
          Effect.gen(function* () {
            yield* service.check(threads[0]!);
            yield* waitReal(
              "the first's check runs",
              Effect.sync(() => running().some((key) => ids(key) === 5)),
            );
            yield* disarm(store, threads[0]!);
            yield* service.check(threads[1]!);
            // Taking it now would run two checks at once; it is handed on as the check ends.
            expect(ensured.some(([head]) => ids(head) === 6)).toBe(false);
            expect(yield* waitsOn(store, threads[1]!, 5)).toBe(true);
            yield* finish(headOf(5), RECORDED);
            yield* waitReal(
              "the second's check, once the first's ended",
              Effect.sync(() => ensured.some(([head]) => ids(head) === 6)),
            );
            expect(mostAtOnce()).toBe(1);
          }),
      ),
    );
  });

  describe("a merge Gram can't say went through", () => {
    const both = [
      [5, RECORDED],
      [6, RECORDED],
    ] as const;

    it.live.each([
      ["its reply was lost", "lost-applied"],
      ["gh exited non-zero after GitHub applied it", "reset-applied"],
    ] as const)("fences the base as an answered merge does: %s", ([, fate]) =>
      scenario(
        {
          numbers: [5, 6],
          passed: both,
          stuckTip: true,
          launch: (nth) => (nth === 1 ? fate : undefined),
        },
        ({ service, store, threads, launches, merged, ensured, finish, moveTip, tip }) =>
          Effect.gen(function* () {
            yield* service.check(threads[0]!);
            yield* waitReal(
              "the first launched",
              Effect.sync(() => launches.length === 1),
            );
            yield* service.check(threads[1]!);
            // GitHub still reads the old tip, so the pass on it is worth nothing.
            yield* waitReal(
              "the second waits on the tip",
              Effect.map(
                store.getThread(threads[1]!),
                (t) => t.boundPr?.mergeWaiting?.why.includes("still reads") === true,
              ),
            );
            expect(launches).toEqual([5]);
            expect(ensured).toEqual([]);
            // The read catches up, and the publisher, seeing the badge's tip move, has it look:
            // its check runs on the new tip, and then it merges.
            moveTip();
            yield* service.check(threads[1]!);
            yield* waitReal(
              "the second's check on the new tip",
              Effect.sync(() => ensured.length === 1),
            );
            expect(ensured).toEqual([[headOf(6), tip()]]);
            yield* finish(headOf(6), tip());
            yield* waitReal(
              "the second merged",
              Effect.sync(() => merged.includes(6)),
            );
            expect(launches).toEqual([5, 6]);
          }),
      ),
    );

    it.live("fences the base when the launch is cut off under way", () =>
      scenario(
        {
          numbers: [5, 6],
          passed: both,
          stuckTip: true,
          launch: (nth) => (nth === 1 ? "hung-applied" : undefined),
        },
        ({ service, store, threads, launches }) =>
          Effect.gen(function* () {
            yield* service.check(threads[0]!);
            yield* waitReal(
              "the first launched",
              Effect.sync(() => launches.length === 1),
            );
            // A look stops the attempt, with `gh` in flight.
            yield* service.check(threads[0]!);
            yield* service.check(threads[1]!);
            yield* waitReal(
              "the second waits on the tip",
              Effect.map(
                store.getThread(threads[1]!),
                (t) => t.boundPr?.mergeWaiting?.why.includes("still reads") === true,
              ),
            );
            expect(launches).toEqual([5]);
          }),
      ),
    );

    it.live("doesn't take an open PR's word for it while GitHub's reads may still lag", () =>
      scenario(
        {
          numbers: [5, 6],
          passed: both,
          stuckTip: true,
          recheckMs: 60_000,
          stateRead: () => "OPEN",
          launch: (nth) => (nth === 1 ? "lost-applied" : undefined),
        },
        ({ service, store, threads, launches }) =>
          Effect.gen(function* () {
            yield* service.check(threads[0]!);
            yield* waitReal(
              "the first launched",
              Effect.sync(() => launches.length === 1),
            );
            yield* service.check(threads[1]!);
            yield* waitReal(
              "the second waits on the outcome",
              Effect.map(
                store.getThread(threads[1]!),
                (t) => t.boundPr?.mergeWaiting?.why.includes("isn't known") === true,
              ),
            );
            expect(launches).toEqual([5]);
          }),
      ),
    );

    it.live("restart preserves a fence while GitHub still reads OPEN at the old tip", () =>
      scenario(
        {
          numbers: [5, 6],
          passed: both,
          stuckTip: true,
          recheckMs: 60_000,
          stateRead: () => "OPEN",
          launch: (nth) => (nth === 1 ? "lost-applied" : undefined),
        },
        ({ service, restart, threads, launches, ensured }) =>
          Effect.gen(function* () {
            yield* service.check(threads[0]!);
            yield* waitReal(
              "first launched",
              Effect.sync(() => launches.length === 1),
            );
            const restored = yield* restart;
            yield* restored.check(threads[1]!);
            yield* Effect.sleep(Duration.millis(100));
            expect(launches).toEqual([5]);
            expect(ensured).toEqual([]);
          }),
      ),
    );

    it.live("the fence is already durable while gh is still in flight", () =>
      scenario(
        {
          numbers: [5, 6],
          passed: both,
          stuckTip: true,
          recheckMs: 60_000,
          stateRead: () => "OPEN",
          launch: (nth) => (nth === 1 ? "hung-applied" : undefined),
        },
        ({ service, restart, threads, launches, store }) =>
          Effect.gen(function* () {
            yield* service.check(threads[0]!);
            yield* waitReal(
              "gh in flight",
              Effect.sync(() => launches.length === 1),
            );
            expect((yield* store.listMergeFences)[0]?.pending).toMatchObject({
              threadId: threads[0]!,
              head: headOf(5),
              tip: RECORDED,
            });
            const restored = yield* restart;
            yield* restored.check(threads[1]!);
            yield* Effect.sleep(Duration.millis(100));
            expect(launches).toEqual([5]);
          }),
      ),
    );

    it.live("timeout stays fenced beyond the interval until a late success is observed", () => {
      let state = "OPEN";
      return scenario(
        {
          numbers: [5, 6],
          passed: both,
          stuckTip: true,
          recheckMs: 20,
          stateRead: () => state,
          launch: (nth) => (nth === 1 ? "lost-applied" : undefined),
        },
        ({ service, store, threads, launches, ensured, moveTip, finish, tip }) =>
          Effect.gen(function* () {
            yield* service.check(threads[0]!);
            yield* waitReal(
              "first launched",
              Effect.sync(() => launches.length === 1),
            );
            yield* service.check(threads[1]!);
            yield* Effect.sleep(Duration.millis(150));
            expect(launches).toEqual([5]);
            expect(ensured).toEqual([]);
            expect((yield* store.getThread(threads[0]!)).boundPr?.mergeWaiting?.why).toContain(
              "fenced",
            );
            state = "MERGED";
            moveTip();
            yield* service.check(threads[1]!);
            yield* waitReal(
              "check on new tip",
              Effect.sync(() => ensured.length === 1),
            );
            expect(ensured).toEqual([[headOf(6), tip()]]);
            yield* finish(headOf(6), tip());
            yield* waitReal(
              "second merge",
              Effect.sync(() => launches.length === 2),
            );
            expect(launches).toEqual([5, 6]);
            expect((yield* store.getThread(threads[0]!)).boundPr?.mergeWaiting).toBeUndefined();
          }),
      );
    });

    it.live("holds everything back while the PR's state can't be read, and says so", () =>
      scenario(
        {
          numbers: [5, 6],
          passed: both,
          stuckTip: true,
          stateRead: () => "",
          launch: (nth) => (nth === 1 ? "lost-applied" : undefined),
        },
        ({ service, store, threads, launches, notices }) =>
          Effect.gen(function* () {
            yield* service.check(threads[0]!);
            yield* waitReal(
              "the first launched",
              Effect.sync(() => launches.length === 1),
            );
            yield* service.check(threads[1]!);
            yield* waitReal(
              "the thread is told",
              Effect.map(notices(), (texts) => texts.some((text) => text.includes("isn't known"))),
            );
            yield* waitReal(
              "the second records its blocked outcome",
              Effect.map(
                store.getThread(threads[1]!),
                (t) => t.boundPr?.mergeWaiting?.why.includes("isn't known") === true,
              ),
            );
            expect(launches).toEqual([5]);
            expect((yield* store.getThread(threads[1]!)).boundPr?.mergeWaiting?.why).toContain(
              "isn't known",
            );
          }),
      ),
    );

    it.live.each([
      ["unapplied timeout", "lost-unapplied", "OPEN", headOf(5)],
      ["closed PR", "lost-applied", "CLOSED", headOf(5)],
      ["another head merged", "lost-applied", "MERGED", headOf(9)],
      ["rejection at another head", "refused", "OPEN", headOf(9)],
    ] as const)("keeps uncertainty fenced: %s", ([, fate, state, head]) =>
      scenario(
        {
          numbers: [5, 6],
          passed: both,
          stuckTip: true,
          recheckMs: 20,
          launch: (nth) => (nth === 1 ? fate : undefined),
          stateRead: () => state,
          headRead: () => head,
        },
        ({ service, threads, launches, store }) =>
          Effect.gen(function* () {
            yield* service.check(threads[0]!);
            yield* waitReal(
              "first launch",
              Effect.sync(() => launches.length === 1),
            );
            yield* service.check(threads[1]!);
            yield* Effect.sleep(Duration.millis(150));
            expect(launches).toEqual([5]);
            expect((yield* store.listMergeFences)[0]?.pending?.head).toBe(headOf(5));
          }),
      ),
    );

    it.live("restart retains a moved tip after the uncertain merge is reconciled", () =>
      scenario(
        {
          numbers: [5, 6],
          passed: both,
          stuckTip: true,
          launch: (nth) => (nth === 1 ? "lost-applied" : undefined),
        },
        ({ service, restart, threads, launches, store }) =>
          Effect.gen(function* () {
            yield* service.check(threads[0]!);
            yield* waitReal(
              "resolved durable move",
              Effect.map(
                store.listMergeFences,
                (rows) =>
                  rows[0]?.pending === undefined && rows[0]?.moved.includes(RECORDED) === true,
              ),
            );
            const restored = yield* restart;
            yield* restored.check(threads[1]!);
            yield* Effect.sleep(Duration.millis(100));
            expect(launches).toEqual([5]);
          }),
      ),
    );

    it.live(
      "an authorized terminal reconciliation releases a different-head manual merge and retires old passes",
      () => {
        let state = "OPEN";
        return scenario(
          {
            numbers: [5, 6],
            passed: [...both, [6, tipAfter(1)]],
            stuckTip: true,
            recheckMs: 60_000,
            stateRead: () => state,
            headRead: () => headOf(9),
            branchTip: () => tipAfter(1),
            launch: (nth) => (nth === 1 ? "lost-applied" : undefined),
          },
          ({ service, restart, store, threads, launches, ensured, moveTip, tip, finish }) =>
            Effect.gen(function* () {
              yield* service.check(threads[0]!);
              yield* waitReal(
                "unknown launch",
                Effect.sync(() => launches.length === 1),
              );
              yield* service.check(threads[1]!);
              yield* waitReal(
                "fenced at the expected head",
                Effect.map(
                  store.getThread(threads[1]!),
                  (t) => t.boundPr?.mergeWaiting?.why.includes("isn't known") === true,
                ),
              );
              // A human merged another head. The automatic expected-head reconciliation must stay put.
              state = "MERGED";
              expect((yield* store.listMergeFences)[0]?.pending?.head).toBe(headOf(5));
              yield* store.updateThread(threads[0]!, (t) => ({
                ...t,
                boundPr: {
                  ...t.boundPr!,
                  mergeWhenReady: { ...t.boundPr!.mergeWhenReady!, hold: "independent review" },
                },
              }));
              expect((yield* store.getThread(threads[0]!)).boundPr?.mergeWaiting?.why).toContain(
                "resolve_merge_fence",
              );
              const result = yield* service.resolveFence(threads[0]!, {
                repo: "example/project",
                number: 5,
                head: headOf(5),
                userApproved: true,
              });
              expect(result.resolved).toBe(true);
              expect(result.base).toBe(tipAfter(1));
              expect((yield* store.getThread(threads[0]!)).boundPr?.mergeWhenReady?.hold).toBe(
                "independent review",
              );
              // Restoration cannot resurrect either the old pass or the pending launch.
              const restored = yield* restart;
              expect((yield* store.listMergeFences)[0]?.pending).toBeUndefined();
              yield* restored.check(threads[1]!);
              yield* Effect.sleep(Duration.millis(100));
              expect(launches).toEqual([5]);
              moveTip();
              yield* restored.check(threads[1]!);
              yield* waitReal(
                "new verification",
                Effect.sync(() => ensured.length === 1),
              );
              expect(ensured).toEqual([[headOf(6), tip()]]);
              yield* finish(headOf(6), tip());
              yield* waitReal(
                "the verified later merge",
                Effect.sync(() => launches.length === 2),
              );
            }),
        );
      },
    );

    it.live.each([
      { suffix: "", sameMillisecond: false },
      { suffix: " when check preparation starts in the cutoff millisecond", sameMillisecond: true },
    ])(
      "a later merge cannot use a new pass on an intermediate lagging base$suffix",
      ({ sameMillisecond }) => {
        let state = "OPEN";
        let checkNow = Date.now;
        return scenario(
          {
            numbers: [5, 6],
            passed: both,
            stuckTip: true,
            recheckMs: 60_000,
            checkNow: () => checkNow(),
            stateRead: () => state,
            headRead: () => headOf(9),
            branchTip: () => tipAfter(2),
            launch: (nth) => (nth === 1 ? "lost-applied" : undefined),
          },
          ({ service, store, threads, launches, ensured, finish, moveTip }) =>
            Effect.gen(function* () {
              yield* service.check(threads[0]!);
              yield* waitReal(
                "uncertain launch",
                Effect.sync(() => launches.length === 1),
              );
              state = "MERGED";
              yield* service.resolveFence(threads[0]!, {
                repo: "example/project",
                number: 5,
                head: headOf(5),
                userApproved: true,
              });
              if (sameMillisecond) {
                const cutoff = (yield* store.listMergeFences)[0]!.verifyAfter!;
                checkNow = () => cutoff;
              }
              // The independent branch read has T2; PR status still lags at intermediate T1.
              moveTip();
              yield* service.check(threads[1]!);
              yield* waitReal(
                "check on intermediate tip",
                Effect.sync(() => ensured.length === 1),
              );
              yield* finish(headOf(6), tipAfter(1));
              yield* waitReal(
                "divergent fresh tip reads block launch",
                Effect.map(
                  store.getThread(threads[1]!),
                  (t) => t.boundPr?.mergeWaiting?.why.includes("couldn't be read") === true,
                ),
              );
              expect(launches).toEqual([5]);
              moveTip();
              yield* service.mutate(threads[1]!, Effect.void);
              yield* waitReal(
                "new check on verified branch tip",
                Effect.sync(() => ensured.length === 2),
              );
              expect(ensured[1]).toEqual([headOf(6), tipAfter(2)]);
              yield* finish(headOf(6), tipAfter(2));
              yield* waitReal(
                "verified merge",
                Effect.sync(() => launches.length === 2),
              );
            }),
        );
      },
    );

    it.live(
      "explicit CLOSED reconciliation clears an acknowledged queue's stale moved-tip barrier",
      () => {
        let state = "OPEN";
        return scenario(
          {
            numbers: [5, 6],
            passed: both,
            stuckTip: true,
            recheckMs: 60_000,
            stateRead: () => state,
            headRead: () => headOf(9),
            launch: (nth) => (nth === 1 ? "queued" : undefined),
          },
          ({ service, store, threads, launches, ensured, finish }) =>
            Effect.gen(function* () {
              yield* service.check(threads[0]!);
              yield* waitReal(
                "acknowledged queue is still fenced",
                Effect.map(
                  store.listMergeFences,
                  (rows) =>
                    rows[0]?.pending !== undefined && rows[0]?.moved.includes(RECORDED) === true,
                ),
              );
              yield* store.updateThread(threads[1]!, (t) => ({
                ...t,
                boundPr: {
                  ...t.boundPr!,
                  mergeWhenReady: { ...t.boundPr!.mergeWhenReady!, hold: "independent hold" },
                },
              }));
              state = "CLOSED";
              yield* service.resolveFence(threads[0]!, {
                repo: "example/project",
                number: 5,
                head: headOf(5),
                userApproved: true,
              });
              expect((yield* store.listMergeFences)[0]?.moved).not.toContain(RECORDED);
              expect((yield* store.getThread(threads[1]!)).boundPr?.mergeWhenReady?.hold).toBe(
                "independent hold",
              );
              yield* Effect.sleep(Duration.millis(2));
              yield* store.updateThread(threads[1]!, (t) => {
                const { hold: _, ...intent } = t.boundPr!.mergeWhenReady!;
                return { ...t, boundPr: { ...t.boundPr!, mergeWhenReady: intent } };
              });
              yield* service.check(threads[1]!);
              yield* waitReal(
                "fresh check on the unchanged base",
                Effect.sync(() => ensured.length === 1),
              );
              expect(ensured).toEqual([[headOf(6), RECORDED]]);
              expect(launches).toEqual([5]);
              yield* finish(headOf(6), RECORDED);
              yield* waitReal(
                "verified later merge",
                Effect.sync(() => launches.length === 2),
              );
            }),
        );
      },
    );

    it.live("terminal reconciliation refuses a worker, OPEN state, and an unreadable base", () => {
      let state = "OPEN";
      let branch: string | undefined;
      return scenario(
        {
          numbers: [5],
          passed: [[5, RECORDED]],
          recheckMs: 60_000,
          stateRead: () => state,
          headRead: () => headOf(9),
          branchTip: () => branch,
          launch: () => "lost-unapplied",
        },
        ({ service, store, threads, launches }) =>
          Effect.gen(function* () {
            const caller = threads[0]!;
            yield* service.check(caller);
            yield* waitReal(
              "unknown launch",
              Effect.sync(() => launches.length === 1),
            );
            const definition = resolveMergeFenceTool(store, service);
            const input = { pr: "example/project#5" };
            const target = yield* definition.resolve!(caller, input);
            expect(
              approvalFor(
                definition.descriptor.class,
                yield* definition.needsApproval!(caller, input, target),
              ),
            ).toBe("forced");
            expect(
              (yield* definition.handle(caller, target, { carded: false }).pipe(Effect.flip))
                .message,
            ).toContain("Only the user");
            const [tool] = bindAppTools([definition], caller);
            expect(
              (yield* tool!.run({ ...input, userApproved: true }).pipe(Effect.flip)).message,
            ).toContain("userApproved");
            expect(
              (yield* definition.handle(caller, target, { carded: true }).pipe(Effect.flip))
                .message,
            ).toContain("merged or closed");
            state = "CLOSED";
            expect(
              (yield* definition.handle(caller, target, { carded: true }).pipe(Effect.flip))
                .message,
            ).toContain("base branch cannot be verified");
            expect((yield* store.listMergeFences)[0]?.pending).toBeDefined();
            branch = RECORDED;
            expect(yield* definition.handle(caller, target, { carded: true })).toMatchObject({
              resolved: true,
              terminal: "CLOSED",
              observedHead: headOf(9),
            });
            expect((yield* store.listMergeFences)[0]?.verifyAfter).toBeTypeOf("number");
            expect((yield* store.listMergeFences)[0]?.pending).toBeUndefined();
            expect(
              (yield* definition.handle(caller, target, { carded: true }).pipe(Effect.flip))
                .message,
            ).toContain("no longer exists");
            expect(launches).toEqual([5]);
          }),
      );
    });

    it.live(
      "only the current owning orchestrator can resolve explicitly without a user card",
      () => {
        let state = "OPEN";
        let branchRead = Effect.void;
        return scenario(
          {
            numbers: [5],
            passed: [[5, RECORDED]],
            recheckMs: 60_000,
            stateRead: () => state,
            branchRead: () => branchRead,
            headRead: () => headOf(9),
            launch: () => "lost-unapplied",
          },
          ({ service, store, threads, launches }) =>
            Effect.gen(function* () {
              const owner = yield* store.getThread(threads[0]!);
              const runtimes = yield* ThreadRuntimes;
              const orchestrator = yield* runtimes.create({
                projectRoot: owner.checkout.path,
                checkout: { kind: "main", path: owner.checkout.path },
              });
              yield* Effect.addFinalizer(() => runtimes.close(orchestrator.id).pipe(Effect.ignore));
              yield* store.updateThread(orchestrator.id, (t) => ({
                ...t,
                role: "orchestrator",
                workspaceId: owner.workspaceId!,
              }));
              yield* store.updateThread(owner.id, (t) => ({
                ...t,
                spawnedBy: { threadId: orchestrator.id, feature: "invented-fence" },
              }));
              yield* store.updateWorkspace(owner.workspaceId!, (s) => ({
                ...s,
                workspace: { ...s.workspace, orchestratorThreadId: orchestrator.id },
                charter: { ...s.charter, autonomy: "full" },
              }));
              yield* service.check(owner.id);
              yield* waitReal(
                "pending",
                Effect.sync(() => launches.length === 1),
              );
              state = "CLOSED";
              const definition = resolveMergeFenceTool(store, service);
              const input = { pr: "example/project#5" };
              const target = yield* definition.resolve!(orchestrator.id, input);
              expect(yield* definition.needsApproval!(orchestrator.id, input, target)).toBe(false);
              yield* store.updateWorkspace(owner.workspaceId!, (s) => ({
                ...s,
                workspace: { ...s.workspace, orchestratorThreadId: owner.id },
              }));
              expect(
                (yield* definition
                  .handle(orchestrator.id, target, { carded: false })
                  .pipe(Effect.flip)).message,
              ).toContain("Only the user");
              yield* store.updateWorkspace(owner.workspaceId!, (s) => ({
                ...s,
                workspace: { ...s.workspace, orchestratorThreadId: orchestrator.id },
              }));
              branchRead = store
                .updateWorkspace(owner.workspaceId!, (s) => ({
                  ...s,
                  workspace: { ...s.workspace, orchestratorThreadId: owner.id },
                }))
                .pipe(Effect.asVoid, Effect.orDie);
              expect(
                (yield* definition
                  .handle(orchestrator.id, target, { carded: false })
                  .pipe(Effect.flip)).message,
              ).toContain("authority or pending fence changed");
              expect((yield* store.listMergeFences)[0]?.pending).toBeDefined();
              branchRead = Effect.void;
              yield* store.updateWorkspace(owner.workspaceId!, (s) => ({
                ...s,
                workspace: { ...s.workspace, orchestratorThreadId: orchestrator.id },
              }));
              expect(
                yield* definition.handle(orchestrator.id, target, { carded: false }),
              ).toMatchObject({ resolved: true });
            }),
        );
      },
    );

    it.live("lets go after a confirmed rejection and an OPEN read at the same head", () =>
      scenario(
        { numbers: [5, 6], passed: both, launch: (nth) => (nth === 1 ? "refused" : undefined) },
        ({ service, threads, merged, launches }) =>
          Effect.gen(function* () {
            yield* service.check(threads[0]!);
            // Not `=== 1`: a lost reply's retry comes a recheck later, and can beat this look.
            yield* waitReal(
              "the first launched",
              Effect.sync(() => launches.length > 0),
            );
            yield* service.check(threads[1]!);
            // No move to fence: the tip is where it was, and the pass on it still stands.
            yield* waitReal(
              "a merge at last",
              Effect.sync(() => merged.length > 0),
            );
            expect(launches).toHaveLength(2);
          }),
      ),
    );
  });

  it.live("a pass that doesn't merge lets the next PR go after a while", () =>
    scenario(
      { numbers: [5, 6, 7], passed: [[5, RECORDED]] },
      ({ service, threads, merged, finish, running }) =>
        Effect.gen(function* () {
          yield* service.check(threads[0]!);
          yield* waitReal(
            "one check running",
            Effect.sync(() => running().length === 1),
          );
          const [head, base] = running()[0]!.split(":");
          const holder = threads[ids(head!) === 6 ? 1 : 2]!;
          // Held while it ran: its pass merges nothing, and the queue can't wait on it.
          const runtimes = yield* ThreadRuntimes;
          yield* runtimes.updateThread(holder, (t) => ({
            ...t,
            boundPr: {
              ...t.boundPr!,
              mergeWhenReady: { ...t.boundPr!.mergeWhenReady!, hold: "invented hold" },
            },
          }));
          yield* finish(head!, base!);
          yield* waitReal(
            "the other PR's check",
            Effect.sync(() => running().length === 1),
          );
          expect(merged).toEqual([5]);
          expect(running()[0]).not.toContain(head!);
        }),
    ),
  );

  it.live("a tip that won't move on says why, on the PR and to the thread, and stays armed", () =>
    scenario(
      {
        numbers: [5, 6],
        passed: [
          [5, RECORDED],
          [6, RECORDED],
        ],
        stuckTip: true,
      },
      ({ service, store, threads, merged, notices }) =>
        Effect.gen(function* () {
          yield* service.check(threads[0]!);
          yield* waitReal(
            "the first merged",
            Effect.sync(() => merged.length === 1),
          );
          yield* waitReal(
            "the second says why it waits",
            Effect.map(
              store.getThread(threads[1]!),
              (t) => t.boundPr?.mergeWaiting?.why.includes("still reads") === true,
            ),
          );
          yield* waitReal(
            "the thread is told",
            Effect.map(notices(), (texts) => texts.some((text) => text.includes("still reads"))),
          );
          expect(merged).toEqual([5]);
          expect((yield* store.getThread(threads[1]!)).boundPr?.mergeWhenReady).toBeDefined();
        }),
    ),
  );

  it.live("GitHub out of reach says why instead of asking again in silence", () =>
    scenario(
      { numbers: [5], passed: [[5, RECORDED]], unreadable: () => true },
      ({ service, store, threads, merged, notices }) =>
        Effect.gen(function* () {
          yield* service.check(threads[0]!);
          yield* waitReal(
            "the thread is told",
            Effect.map(notices(), (texts) =>
              texts.some((text) => text.includes("couldn't be read")),
            ),
          );
          expect(merged).toEqual([]);
          expect((yield* store.getThread(threads[0]!)).boundPr?.mergeWaiting?.why).toContain(
            "couldn't be read",
          );
        }),
    ),
  );
});
