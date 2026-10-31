import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_CHARTER,
  WorkspaceId,
  type PrStatus,
  type ProjectId,
  type ThreadId,
} from "@gram/contracts";
import { Pr, Proc, ProcTimeout } from "@gram/git";
import * as Duration from "effect/Duration";
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
type LaunchFate = "lost-applied" | "lost-unapplied" | "reset-applied" | "refused" | "hung-applied";

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
  /** The wait between rechecks; short by default. */
  readonly recheckMs?: number;
  /** How long GitHub takes to answer a read. */
  readonly readMs?: number;
  /** A read that fails, for the PR it names. */
  readonly unreadable?: (number: number) => boolean;
}

/** Armed PRs of one repository under solo, in a GitHub and a check runner that these tests drive. */
const scenario = <E, R>(
  options: Options,
  body: (world: {
    readonly service: MergeWhenReady["Service"];
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
              ok(options.stateRead?.() ?? (merged.includes(number) ? "MERGED" : "OPEN")),
            );
          if (args[0] !== "pr" || args[1] !== "merge") return Effect.succeed(ok());
          launches.push(number);
          const fate = options.launch?.(launches.length);
          if (fate !== "lost-unapplied" && fate !== "refused") {
            merged.push(number);
            if (options.stuckTip !== true) merges++;
          }
          if (fate === "hung-applied") return Effect.never;
          if (fate === "lost-applied" || fate === "lost-unapplied")
            return Effect.fail(new ProcTimeout({ bin: "gh", message: "invented: timed out" }));
          return Effect.succeed(
            fate === "reset-applied" || fate === "refused"
              ? { ...ok(), status: 1, stderr: "invented: gh failed" }
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
      ensure: (_dir, head, base, { onDone }) =>
        Effect.sync(() => {
          const key = `${head}:${base}`;
          const known = records.get(key);
          if (known?.status === "running") listeners.get(key)!.push(onDone);
          if (known !== undefined) return known;
          ensured.push([head, base]);
          const running = record(head, base, "running");
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
      yield* body({
        service,
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
            const ended = record(head, base, options.outcome?.(head, base) ?? "passed");
            records.set(key, ended);
            const waiting = listeners.get(key) ?? [];
            listeners.delete(key);
            for (const done of waiting) yield* done(ended);
          }),
      });
    }).pipe(Effect.scoped, Effect.provide(layer));
  }).pipe(Effect.scoped);

const ids = (head: string) => Number(head[0]);

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
            expect(launches).toEqual([5]);
            expect((yield* store.getThread(threads[1]!)).boundPr?.mergeWaiting?.why).toContain(
              "isn't known",
            );
          }),
      ),
    );

    it.live.each([
      ["a lost reply it never applied", "lost-unapplied"],
      ["a refusal", "refused"],
    ] as const)("lets go once GitHub had time to show it: %s", ([, fate]) =>
      scenario(
        { numbers: [5, 6], passed: both, launch: (nth) => (nth === 1 ? fate : undefined) },
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
