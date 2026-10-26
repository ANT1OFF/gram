// The workflow-run monitor (`run_monitor`): a thread names a GitHub Actions run it waits on, a
// release candidate's build or a deploy, and is sent one message when the run completes. The PR
// monitors wake an agent for a PR's checks; nothing did for a run that belongs to no PR, so agents
// followed one with `gh run watch` inside a turn, where nothing reaches them and a watcher that
// died went unnoticed for hours.
//
// Watches live on the thread (`Thread.runWatches`), so a restart picks them up and a run that
// completed while the app was down is told at the first look. Every lookup is one bounded REST
// `gh api` through `Proc`, whose headers keep the allowance's count true, made once a poll for each
// run however many threads watch it, and the polls are paced to the background share of it like the
// PR sweeps. With nothing watched the loop waits for a watch rather than reading every thread.

import {
  AppToolError,
  MAX_RUN_WATCHES,
  type RunWatch,
  type Thread,
  type ThreadId,
} from "@gram/contracts";
import { ghApi, gitFailMsg, originOwnerRepo, Proc } from "@gram/git";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { EventHub } from "../events/event-hub.ts";
import { upsertsChanging } from "../events/upsert-changes.ts";
import { folderExists } from "../fs/folders.ts";
import { asBackground, GhBudget } from "../github/budget.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { GitServerConfig } from "./platform.ts";
import { makeKeyedLock } from "./keyed-lock.ts";

/** Whether `list` watches `watch`'s run. */
const has = (list: ReadonlyArray<RunWatch>, watch: RunWatch) =>
  list.some((w) => w.runId === watch.runId && w.repo === watch.repo);

/** How often watched runs are looked up when the config doesn't say. */
const RUN_POLL_INTERVAL = Duration.minutes(1);

/** How many sent completions are remembered for an archive to put their watches back. */
const TOLD_KEPT = 200;

/** The failed jobs a completion message names before it counts the rest. */
const FAILED_JOBS_NAMED = 5;

const REPO = /^[\w.-]+\/[\w.-]+$/;

/** A run as the REST API gives it; only what a message says is read. */
const RestRun = Schema.Struct({
  id: Schema.Int,
  status: Schema.NullOr(Schema.String),
  conclusion: Schema.optionalKey(Schema.NullOr(Schema.String)),
  name: Schema.optionalKey(Schema.NullOr(Schema.String)),
  display_title: Schema.optionalKey(Schema.NullOr(Schema.String)),
  html_url: Schema.optionalKey(Schema.NullOr(Schema.String)),
  head_branch: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

const RunView = Schema.Struct({
  databaseId: Schema.Int,
  status: Schema.String,
  conclusion: Schema.optionalKey(Schema.String),
  workflowName: Schema.optionalKey(Schema.String),
  displayTitle: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
  headBranch: Schema.optionalKey(Schema.String),
});
export type RunView = typeof RunView.Type;

const RunJobs = Schema.Struct({
  jobs: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      conclusion: Schema.optionalKey(Schema.NullOr(Schema.String)),
    }),
  ),
});

const viewOf = (run: typeof RestRun.Type): RunView => ({
  databaseId: run.id,
  status: run.status ?? "",
  ...(run.conclusion == null ? {} : { conclusion: run.conclusion }),
  ...(run.name == null ? {} : { workflowName: run.name }),
  ...(run.display_title == null ? {} : { displayTitle: run.display_title }),
  ...(run.html_url == null ? {} : { url: run.html_url }),
  ...(run.head_branch == null ? {} : { headBranch: run.head_branch }),
});

const decodeRestRun = Schema.decodeUnknownOption(Schema.fromJsonString(RestRun));
const decodeRestRuns = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ workflow_runs: Schema.Array(RestRun) })),
);
const decodeJobs = Schema.decodeUnknownOption(Schema.fromJsonString(RunJobs));
const decodeWorkflows = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      workflows: Schema.Array(Schema.Struct({ id: Schema.Int, name: Schema.String })),
    }),
  ),
);
const decodeRun = (json: string) => Option.map(decodeRestRun(json), viewOf);
const decodeRuns = (json: string) =>
  Option.map(decodeRestRuns(json), (page) => page.workflow_runs.map(viewOf));

/** A run named by its id, or by its page's URL, which also says its repo. */
export const parseRunRef = (
  text: string,
): { readonly repo?: string; readonly runId: number } | undefined => {
  const trimmed = text.trim();
  const url = /github\.com\/([\w.-]+\/[\w.-]+)\/actions\/runs\/(\d+)/.exec(trimmed);
  if (url !== null) return { repo: url[1]!, runId: Number(url[2]) };
  return /^\d+$/.test(trimmed) ? { runId: Number(trimmed) } : undefined;
};

/** The run as a message names it: its workflow and title. */
const runName = (run: Pick<RunView, "workflowName" | "displayTitle" | "databaseId">) =>
  [run.workflowName, run.displayTitle]
    .filter((part) => part !== undefined && part !== "")
    .join(": ") || `run ${run.databaseId}`;

/** What a thread is sent when a run it watches completes. */
const runDoneText = (
  watch: Pick<RunWatch, "repo" | "runId">,
  run: RunView,
  failedJobs: ReadonlyArray<string>,
): string => {
  const conclusion =
    run.conclusion === undefined || run.conclusion === "" ? "done" : run.conclusion;
  const shown = failedJobs.slice(0, FAILED_JOBS_NAMED);
  const more = failedJobs.length - shown.length;
  const failed =
    shown.length === 0 ? "" : ` Failed: ${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}.`;
  return `Workflow run "${runName(run)}" (${watch.repo} #${watch.runId}) completed: ${conclusion}.${failed}${run.url === undefined ? "" : ` ${run.url}`}`;
};

const refuse = (message: string) => new AppToolError({ tool: "run_monitor", message });

/** GitHub no longer has the run: deleted, or never in that repo. */
const GONE = /not found|could not find|HTTP 404/i;

interface RunWatchInput {
  /** The run's id or its page's URL; without it, the latest run of `workflow`. */
  readonly run?: string | undefined;
  readonly repo?: string | undefined;
  readonly workflow?: string | undefined;
  readonly branch?: string | undefined;
}

export interface RunMonitorShape {
  /**
   * Watches a run for `threadId`: the watch it set, or, for a run already completed, the run as it
   * ended and no watch. Fails with the tool's error when the run can't be found.
   */
  readonly watch: (
    threadId: ThreadId,
    input: RunWatchInput,
  ) => Effect.Effect<{ readonly watch?: RunWatch; readonly completed?: string }, AppToolError>;
  /** Stops watching one run, or with no id every run; how many watches went. */
  readonly unwatch: (threadId: ThreadId, runId: number | undefined) => Effect.Effect<number>;
  /** One look at every watched run; the poll loop runs it, and tests call it. */
  readonly poll: Effect.Effect<void>;
}

export class RunMonitor extends Context.Service<RunMonitor, RunMonitorShape>()(
  "@gram/server/RunMonitor",
) {}

/** A thread waiting on a run, with its own watch of it. */
interface Watcher {
  readonly thread: Thread;
  readonly watched: RunWatch;
}

const withWatches = (thread: Thread, watches: ReadonlyArray<RunWatch>): Thread => {
  const { runWatches: _, ...rest } = thread;
  return watches.length === 0 ? rest : { ...rest, runWatches: watches };
};

export const RunMonitorLive = Layer.effect(
  RunMonitor,
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    const runtimes = yield* ThreadRuntimes;
    const hub = yield* EventHub;
    const proc = yield* Proc;
    const budget = yield* GhBudget;
    const config = yield* GitServerConfig;

    /**
     * Threads that may have a watch, each with the mark count it was last marked at. A thread is
     * marked by an upsert that shows it watching, or by a watch set here, and let go only by a poll
     * that read it unwatched before it was marked again: upserts can be published out of order, so
     * one can add a thread but never lose one.
     */
    const candidates = new Map<ThreadId, number>();
    let marks = 0;
    /** Open while any thread may have a watch; the poll loop waits on it otherwise. */
    const anyWatched = Latch.makeUnsafe(false);
    const mark = (threadId: ThreadId) => {
      candidates.set(threadId, ++marks);
      anyWatched.openUnsafe();
    };

    const api = (cwd: string, path: string) =>
      ghApi(cwd, [path]).pipe(Effect.provideService(Proc, proc), asBackground);

    const view = (cwd: string, repo: string, runId: number) =>
      api(cwd, `repos/${repo}/actions/runs/${runId}`);

    /**
     * What the REST API takes for `workflow`: a file name or an id as it is; a workflow's own name,
     * as `gh run list --workflow` takes it, looked up among the repo's workflows.
     */
    const workflowId = (cwd: string, repo: string, workflow: string) =>
      Effect.gen(function* () {
        if (/^\d+$/.test(workflow) || /\.ya?ml$/i.test(workflow)) return workflow;
        const out = yield* api(cwd, `repos/${repo}/actions/workflows?per_page=100`);
        const listed = out.status === 0 ? decodeWorkflows(out.stdout) : Option.none();
        const named = Option.isSome(listed)
          ? listed.value.workflows.find((w) => w.name.toLowerCase() === workflow.toLowerCase())
          : undefined;
        if (named === undefined) {
          return yield* refuse(
            `No workflow named "${workflow}" in ${repo}; pass its file name, such as release.yml.`,
          );
        }
        return String(named.id);
      });

    const failedJobs = (cwd: string, repo: string, runId: number) =>
      api(cwd, `repos/${repo}/actions/runs/${runId}/jobs?per_page=100`).pipe(
        Effect.map((out) => {
          const decoded = out.status === 0 ? decodeJobs(out.stdout) : Option.none();
          return Option.isNone(decoded)
            ? []
            : decoded.value.jobs
                .filter((job) => job.conclusion === "failure" || job.conclusion === "timed_out")
                .map((job) => job.name);
        }),
        Effect.orElseSucceed((): ReadonlyArray<string> => []),
      );

    const watch: RunMonitorShape["watch"] = (threadId, input) =>
      Effect.gen(function* () {
        const thread = yield* store
          .getThread(threadId)
          .pipe(Effect.mapError((e) => refuse(e.message)));
        const cwd = thread.checkout.path;
        const ref = input.run === undefined ? undefined : parseRunRef(input.run);
        if (input.run !== undefined && ref === undefined) {
          return yield* refuse(`"${input.run}" is neither a run id nor a run's URL.`);
        }
        if (ref === undefined && input.workflow === undefined) {
          return yield* refuse(
            "Name the run (`run`: its id or URL), or a `workflow` to watch its latest run.",
          );
        }
        const repo =
          ref?.repo ??
          input.repo ??
          thread.boundPr?.repo ??
          (yield* originOwnerRepo(cwd).pipe(Effect.provideService(Proc, proc)));
        if (repo === undefined || !REPO.test(repo)) {
          return yield* refuse(
            "Can't tell which repository the run is in; pass `repo` as owner/repo.",
          );
        }
        const found =
          ref === undefined
            ? yield* Effect.gen(function* () {
                const workflow = yield* workflowId(cwd, repo, input.workflow!);
                const branch =
                  input.branch === undefined ? "" : `&branch=${encodeURIComponent(input.branch)}`;
                const out = yield* api(
                  cwd,
                  `repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs?per_page=1${branch}`,
                );
                if (out.status !== 0)
                  return yield* refuse(gitFailMsg(out, "listing the workflow's runs failed"));
                const runs = decodeRuns(out.stdout);
                const latest = Option.isSome(runs) ? runs.value[0] : undefined;
                if (latest === undefined) {
                  return yield* refuse(
                    `No run of ${input.workflow} in ${repo}${input.branch === undefined ? "" : ` on ${input.branch}`} yet.`,
                  );
                }
                return latest;
              })
            : yield* Effect.gen(function* () {
                const out = yield* view(cwd, repo, ref.runId);
                if (out.status !== 0)
                  return yield* refuse(gitFailMsg(out, "looking the run up failed"));
                const decoded = decodeRun(out.stdout);
                if (Option.isNone(decoded)) {
                  return yield* refuse(`gh said nothing readable about run ${ref.runId}.`);
                }
                return decoded.value;
              });
        const target = { repo, runId: found.databaseId };
        if (found.status === "completed") {
          const failed =
            found.conclusion === "success" ? [] : yield* failedJobs(cwd, repo, found.databaseId);
          return { completed: runDoneText(target, found, failed) };
        }
        const set: RunWatch = {
          ...target,
          name: runName(found),
          ...(found.url === undefined ? {} : { url: found.url }),
          since: yield* Clock.currentTimeMillis,
        };
        let refused: string | undefined;
        yield* runtimes
          .updateThread(threadId, (t) => {
            const watches = t.runWatches ?? [];
            if (watches.some((w) => w.runId === set.runId && w.repo === set.repo)) return t;
            if (watches.length >= MAX_RUN_WATCHES) {
              refused = `A thread watches at most ${MAX_RUN_WATCHES} runs at once; stop one first.`;
              return t;
            }
            return withWatches(t, [...watches, set]);
          })
          .pipe(Effect.mapError((e) => refuse(e.message)));
        if (refused !== undefined) return yield* refuse(refused);
        mark(threadId);
        return { watch: set };
      }).pipe(
        Effect.catchTags({
          ProcSpawnError: (e) => Effect.fail(refuse(e.message)),
          ProcTimeout: (e) => Effect.fail(refuse(e.message)),
        }),
      );

    const drop = (threadId: ThreadId, gone: (watch: RunWatch) => boolean) =>
      Effect.gen(function* () {
        let dropped = 0;
        yield* runtimes
          .updateThread(threadId, (t) => {
            const watches = t.runWatches ?? [];
            const kept = watches.filter((w) => !gone(w));
            dropped = watches.length - kept.length;
            return dropped === 0 ? t : withWatches(t, kept);
          })
          .pipe(Effect.ignore);
        return dropped;
      });

    /** The watch each sent completion was for, by thread and notice key, for an archive to put back. */
    const told = new Map<string, RunWatch>();

    /** One per thread: a stop and a completion's check-and-send never interleave. */
    const locks = makeKeyedLock<ThreadId>();
    const serial = locks.withLock;

    const unwatch: RunMonitorShape["unwatch"] = (threadId, runId) =>
      serial(
        threadId,
        drop(threadId, (w) => runId === undefined || w.runId === runId),
      );

    /**
     * Tells `thread` its run is over, or gone, then stops watching it: only while the watch is still
     * there and the thread isn't archived, read just before, so a lookup that outlived a stop or an
     * archive delivers nothing. The notice goes before the watch does, so a restart between them
     * tells it twice rather than never.
     */
    const finish = (thread: Thread, watched: RunWatch, text: string, failed: boolean) =>
      serial(
        thread.id,
        Effect.gen(function* () {
          const same = (w: RunWatch) => w.runId === watched.runId && w.repo === watched.repo;
          const key = `run:${watched.repo}#${watched.runId}`;
          const current = yield* store.getThread(thread.id).pipe(Effect.option);
          if (Option.isNone(current) || current.value.parked) return;
          if (!(current.value.runWatches ?? []).some(same)) return;
          // An agent that can't start fails the send with the notice already queued, which counts
          // as told; any other failure took nothing, and the watch stays for the next poll.
          const accepted = yield* runtimes.sendNotice(thread.id, key, { text }).pipe(
            Effect.as(true),
            Effect.catch((e) =>
              Effect.logWarning("run monitor notice not sent").pipe(
                Effect.annotateLogs({ threadId: thread.id, error: e.message }),
                Effect.as(e._tag === "AgentUnavailable"),
              ),
            ),
          );
          if (!accepted) return;
          // Archived just after the send was taken: a notice still queued is taken back, as the
          // archive's own sweep does below, and the watch stays for the thread's return.
          const after = yield* store.getThread(thread.id).pipe(Effect.option);
          if (Option.isSome(after) && after.value.parked) {
            return yield* runtimes.dropNotices(thread.id, (queued) => queued === key);
          }
          told.set(`${thread.id}|${key}`, watched);
          // Only a completion still queued is ever put back, so the oldest are let go.
          if (told.size > TOLD_KEPT) told.delete(told.keys().next().value!);
          yield* drop(thread.id, same);
          yield* hub.publish({
            type: "notify",
            kind: failed ? "error" : "done",
            title: `${watched.name ?? `Run ${watched.runId}`} ${failed ? "didn't succeed" : "finished"}`,
            body: thread.title,
            threadId: thread.id,
          });
        }),
      );

    /** Tells each watcher in turn, each under its own thread's lock and checks. */
    const tell = (watchers: ReadonlyArray<Watcher>, text: string, failed: boolean) =>
      Effect.forEach(watchers, ({ thread, watched }) => finish(thread, watched, text, failed), {
        discard: true,
      });

    /** One lookup of a run, and of its failed jobs, for every thread that watches it. */
    const look = (repo: string, runId: number, watchers: ReadonlyArray<Watcher>) =>
      Effect.gen(function* () {
        // The API path names the repo, so any watcher's checkout does as the directory gh runs in,
        // as long as it is there: `gh` can't start in a folder that was deleted under its thread.
        const there = yield* Effect.findFirst(watchers, ({ thread }) =>
          folderExists(thread.checkout.path),
        );
        if (Option.isNone(there)) return;
        const cwd = there.value.thread.checkout.path;
        const out = yield* view(cwd, repo, runId);
        if (out.status !== 0) {
          if (!GONE.test(out.stderr)) return;
          return yield* tell(
            watchers,
            `Workflow run ${repo} #${runId} can't be found any more, so it is no longer watched.`,
            true,
          );
        }
        const decoded = decodeRun(out.stdout);
        if (Option.isNone(decoded) || decoded.value.status !== "completed") return;
        const ended = decoded.value;
        const failed = ended.conclusion !== "success" && ended.conclusion !== "skipped";
        const jobs = failed ? yield* failedJobs(cwd, repo, runId) : [];
        yield* tell(watchers, runDoneText({ repo, runId }, ended, jobs), failed);
      }).pipe(
        // A lookup gh couldn't make is tried at the next poll.
        Effect.catch((e) =>
          Effect.logDebug("run monitor lookup failed").pipe(
            Effect.annotateLogs({ repo, runId, watchers: watchers.length, error: e.message }),
          ),
        ),
      );

    /** How many runs the last poll found watched, which paces the next. */
    let looked = 0;

    const poll: RunMonitorShape["poll"] = Effect.gen(function* () {
      if (candidates.size === 0) return;
      const readAt = marks;
      const runs = new Map<string, Array<Watcher>>();
      for (const threadId of candidates.keys()) {
        const read = yield* store.getThread(threadId).pipe(Effect.option);
        // An archived thread's watches wait for it to come back, and its upsert marks it again.
        const thread = Option.isSome(read) && !read.value.parked ? read.value : undefined;
        const watches = thread?.runWatches ?? [];
        if (thread === undefined || watches.length === 0) {
          if ((candidates.get(threadId) ?? 0) <= readAt) candidates.delete(threadId);
          continue;
        }
        for (const watched of watches) {
          const key = `${watched.repo}#${watched.runId}`;
          const watchers = runs.get(key);
          if (watchers === undefined) runs.set(key, [{ thread, watched }]);
          else watchers.push({ thread, watched });
        }
      }
      looked = runs.size;
      if (runs.size === 0) return;
      if (!(yield* budget.admit("core", "background")).allowed) return;
      yield* Effect.forEach(
        runs.values(),
        (watchers) => look(watchers[0]!.watched.repo, watchers[0]!.watched.runId, watchers),
        { concurrency: 2, discard: true },
      );
    });

    // A completion still queued when its thread is archived isn't for an agent anyone woke: it is
    // taken back and its watch put back, so the thread is told again once it returns. The thread
    // is read again rather than taken from the event, which may be older than the queue. Only an
    // archived thread's upsert, and once more each time its watches change, which may free room.
    yield* hub.serverEvents(Effect.succeed({ type: "threads.snapshot", threads: [] })).pipe(
      Stream.filter(
        upsertsChanging((t) => (t.parked ? JSON.stringify(t.runWatches ?? []) : "open")),
      ),
      Stream.runForEach((event) =>
        event.type !== "thread.upsert"
          ? Effect.void
          : Effect.gen(function* () {
              const threadId = event.thread.id;
              if (!(yield* store.getThread(threadId)).parked) return;
              // Read without taking anything: the predicate keeps every item.
              const queued: Array<string> = [];
              yield* runtimes.dropNotices(threadId, (key) => {
                if (key.startsWith("run:")) queued.push(key);
                return false;
              });
              if (queued.length === 0) return;
              const now = yield* Clock.currentTimeMillis;
              const back = queued.flatMap((key): Array<readonly [string, RunWatch]> => {
                const kept = told.get(`${threadId}|${key}`);
                const parsed = /^run:([\w.-]+\/[\w.-]+)#(\d+)$/.exec(key);
                if (kept !== undefined) return [[key, kept]];
                return parsed === null
                  ? []
                  : [[key, { repo: parsed[1]!, runId: Number(parsed[2]), since: now }]];
              });
              // In one turn of the thread's lock, so no completion lands between them: the watch goes
              // back first, durably, then the completion is taken back; an exit between them leaves
              // the run watched, never neither. The archive is asked again inside it. Only those
              // whose watch is there afterwards are taken: one that didn't fit under the cap stays
              // queued, held while the thread is archived and sent once it is back.
              yield* serial(
                threadId,
                Effect.gen(function* () {
                  const parked = yield* store.getThread(threadId);
                  if (!parked.parked) return;
                  const watches = parked.runWatches ?? [];
                  const missing = back.map(([, w]) => w).filter((w) => !has(watches, w));
                  const next = [...watches, ...missing].slice(0, MAX_RUN_WATCHES);
                  // Only when one fits: every write is an upsert this sweep hears again, and a full
                  // list would have it write the same thread for as long as it stays archived.
                  let kept = watches;
                  if (next.length > watches.length) {
                    const updated = yield* runtimes
                      .updateThread(threadId, (t) => {
                        const current = t.runWatches ?? [];
                        const add = missing.filter((w) => !has(current, w));
                        return add.length === 0
                          ? t
                          : withWatches(t, [...current, ...add].slice(0, MAX_RUN_WATCHES));
                      })
                      .pipe(Effect.option);
                    if (Option.isNone(updated)) return;
                    kept = updated.value.runWatches ?? [];
                  }
                  const keys = new Set(back.filter(([, w]) => has(kept, w)).map(([key]) => key));
                  if (keys.size > 0) yield* runtimes.dropNotices(threadId, (key) => keys.has(key));
                }),
              );
            }).pipe(Effect.ignore),
      ),
      Effect.forkScoped,
    );

    // Marked as their upserts are published, and from the store once for the watches a restart
    // finds. Started at once, so the stream has subscribed before the store is read and no write
    // falls between them.
    yield* hub
      .internalEvents(
        (event) =>
          event.type === "thread.upsert" &&
          !event.thread.parked &&
          (event.thread.runWatches ?? []).length > 0,
      )
      .pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            if (event.type === "thread.upsert") mark(event.thread.id);
          }),
        ),
        Effect.forkScoped({ startImmediately: true }),
      );
    for (const thread of yield* store.listThreads) {
      if (!thread.parked && (thread.runWatches ?? []).length > 0) mark(thread.id);
    }

    const base = config.runPollInterval ?? RUN_POLL_INTERVAL;
    yield* Effect.gen(function* () {
      yield* Effect.suspend(() => {
        if (candidates.size > 0) return Effect.void;
        anyWatched.closeUnsafe();
        return anyWatched.await;
      });
      // Stretched as the allowance runs low, by what a poll of this many runs costs.
      const cost = looked === 0 ? candidates.size : looked;
      yield* Effect.sleep(yield* budget.paceBackground("core", base, cost));
      yield* poll;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("run monitor poll failed").pipe(
          Effect.annotateLogs({ cause: Cause.pretty(cause) }),
        ),
      ),
      Effect.forever,
      Effect.forkScoped,
    );

    return RunMonitor.of({ watch, unwatch, poll });
  }),
);
