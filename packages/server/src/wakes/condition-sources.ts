/**
 * The condition kinds Gram can wait on (`WakeCondition`), one `WakeConditionSource` each. A new kind
 * is a source here and a line in `WakeConditionSourcesLive`; the engine (`conditions.ts`) runs them.
 */
import { AppToolError, type Thread, type ThreadId, type ThreadStatus } from "@gram/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { EventHub } from "../events/event-hub.ts";
import { folderExists } from "../fs/folders.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { BranchHeads } from "./branch-heads.ts";
import {
  type ConditionLook,
  WakeConditionSources,
  type WakeConditionSource,
} from "./conditions.ts";

const met = (facts: Readonly<Record<string, string>>): ConditionLook => ({ met: true, facts });
const notMet = (seen?: Readonly<Record<string, string>>): ConditionLook =>
  seen === undefined ? { met: false } : { met: false, seen: { ...seen } };

const refuse = (message: string) => new AppToolError({ tool: "schedule_wake", message });

/** A folder of the thread's to run gh in: its checkout, or its repo's main one. */
const folderOf = (thread: Thread) =>
  Effect.gen(function* () {
    const cwd = thread.checkout.path;
    return (yield* folderExists(cwd)) || thread.checkout.repoRoot === undefined
      ? cwd
      : thread.checkout.repoRoot;
  });

/** How long one branch's head, read for one wake, answers for the others on it. */
const HEAD_READ_REUSE_MS = 20_000;

/**
 * `branchMoved`: the head of a repo's branch changes. Set, it reads the head as the baseline, its
 * default branch's when none is named; each poll reads it again (once per branch, however many wait
 * on it) and fires on a head that differs, or on the branch being deleted. The debounce lets a
 * burst of merges land, and the notice names the head it settled on.
 */
export const branchMovedSource = Effect.gen(function* () {
  const heads = yield* BranchHeads;
  const store = yield* ThreadStore;
  const reads = new Map<
    string,
    { readonly at: number; readonly head: string | null | undefined }
  >();

  const headOf = (cwd: string, repo: string, branch: string) =>
    Effect.gen(function* () {
      const key = `${repo.toLowerCase()}\u0000${branch}`;
      const now = yield* Clock.currentTimeMillis;
      const kept = reads.get(key);
      if (kept !== undefined && now - kept.at < HEAD_READ_REUSE_MS) return kept.head;
      const head = yield* heads.head(cwd, repo, branch);
      if (head !== undefined) reads.set(key, { at: now, head });
      return head;
    });

  const source: WakeConditionSource<"branchMoved"> = {
    kind: "branchMoved",
    pollEvery: Duration.minutes(2),
    debounce: Duration.seconds(30),
    arm: (caller, spec) =>
      Effect.gen(function* () {
        const cwd = yield* folderOf(caller);
        const branch = spec.branch ?? (yield* heads.defaultBranch(cwd, spec.repo));
        if (branch === undefined) {
          return yield* refuse(
            `GitHub couldn't say what ${spec.repo}'s default branch is; name the \`branch\`.`,
          );
        }
        const head = yield* heads.head(cwd, spec.repo, branch);
        if (head === null) return yield* refuse(`${spec.repo} has no branch ${branch}.`);
        // Unreadable now: the first look that reads it is the baseline.
        return {
          spec: { ...spec, branch },
          ...(head === undefined ? {} : { seen: { head } }),
        };
      }),
    look: (wake) =>
      Effect.gen(function* () {
        const branch = wake.spec.branch;
        if (branch === undefined) return undefined;
        const waiter = yield* store.getThread(wake.threadId).pipe(Effect.option);
        if (Option.isNone(waiter)) return undefined;
        const head = yield* headOf(yield* folderOf(waiter.value), wake.spec.repo, branch);
        if (head === undefined) return undefined;
        const facts = { repo: wake.spec.repo, branch };
        if (head === null) return met({ ...facts, head: "deleted" });
        const before = wake.seen?.head;
        if (before === undefined) return notMet({ head });
        if (head === before) return notMet();
        return met({ ...facts, head, previous: before });
      }),
  };
  return source;
});

/** At rest: the thread runs no turn and waits on nothing. */
const AT_REST: ReadonlyArray<ThreadStatus> = ["idle", "cold", "ended"];

/**
 * `threadFinished`: another thread is done with its work. It reports `done`, or is marked completed,
 * or is at rest after a report of any kind; each counts only after the wake was set. A thread that
 * is archived or closed ends the wait too, and says so. Set on one that is archived, or at rest with
 * `done` as its latest report, it is refused as finished already. Its thread's upserts and the
 * workspace's reports ask for a look; the debounce lets a thread that reported and kept going show
 * it isn't at rest.
 */
export const threadFinishedSource = Effect.gen(function* () {
  const store = yield* ThreadStore;
  const runtimes = yield* ThreadRuntimes;
  const hub = yield* EventHub;
  /** The threads some wake waits on, which their upserts are let through for. */
  const targets = new Set<ThreadId>();

  const lastReport = (thread: Thread) =>
    thread.workspaceId === undefined
      ? Effect.succeed(undefined)
      : store
          .latestWorkerReports(thread.workspaceId, [thread.id])
          .pipe(Effect.map((reports) => reports[0]?.report));

  const atRest = (threadId: ThreadId) =>
    runtimes.status(threadId).pipe(
      Effect.map((status) => AT_REST.includes(status)),
      Effect.orElseSucceed(() => false),
    );

  const source: WakeConditionSource<"threadFinished"> = {
    kind: "threadFinished",
    pollEvery: Duration.minutes(2),
    debounce: Duration.seconds(20),
    arm: (caller, spec) =>
      Effect.gen(function* () {
        if (spec.threadId === caller.id) return yield* refuse("A thread can't wait for itself.");
        const target = yield* store.getThread(spec.threadId).pipe(Effect.option);
        if (Option.isNone(target)) return yield* refuse(`No thread has the id ${spec.threadId}.`);
        const title = target.value.title;
        if (target.value.parked) return yield* refuse(`"${title}" is archived already.`);
        const report = yield* lastReport(target.value);
        if (report?.state === "done" && (yield* atRest(target.value.id))) {
          return yield* refuse(`"${title}" reported done already and is at rest.`);
        }
        targets.add(spec.threadId);
        return { spec };
      }),
    look: (wake) =>
      Effect.gen(function* () {
        const threadId = wake.spec.threadId;
        targets.add(threadId);
        const found = yield* store.getThread(threadId).pipe(Effect.option);
        const facts = (outcome: string, title?: string): Record<string, string> => ({
          thread: threadId,
          ...(title === undefined ? {} : { title }),
          outcome,
        });
        if (Option.isNone(found)) return met(facts("closed"));
        const target = found.value;
        if (target.parked) return met(facts("archived", target.title));
        if (target.completedAt !== undefined && target.completedAt >= wake.setAt) {
          return met(facts("marked completed", target.title));
        }
        const report = yield* lastReport(target);
        if (report === undefined || report.at < wake.setAt) return notMet();
        if (report.state === "done") {
          return met(facts("reported done", target.title));
        }
        if (yield* atRest(threadId)) {
          return met(facts(`at rest after a ${report.state} report`, target.title));
        }
        return notMet();
      }),
    changes: hub
      .internalEvents(
        (event) =>
          event.type === "orchestration.changed" ||
          ((event.type === "thread.upsert" || event.type === "thread.removed") &&
            targets.has(event.type === "thread.upsert" ? event.thread.id : event.threadId)),
        "thread finished wakes",
      )
      .pipe(Stream.debounce(Duration.seconds(2))),
  };
  return source;
});

/** Every kind's source, for `WakeConditionsLive`. */
export const WakeConditionSourcesLive = Layer.effect(
  WakeConditionSources,
  Effect.all([branchMovedSource, threadFinishedSource]),
);
