import {
  effectiveCheckout,
  HostId,
  hostOf,
  type Thread,
  type ThreadId,
  type ThreadWake,
  type WorkerLedgerEntry,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import { ServerConfig } from "../config.ts";
import { RemoteHosts, type RemoteHostsShape } from "../host/remote-hosts.ts";
import { privateJsonFile } from "../http/remote-sessions.ts";
import { Orchestration } from "../orchestration/service.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { ThreadPorts } from "../ports/service.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { DAY_MS } from "../zone-time.ts";
import {
  addSample,
  classifyMachine,
  closeWake,
  type IdleSpan,
  type IdleThreadFacts,
  KEEP_MS,
  limitOnWake,
  lookAtWake,
  type MachineKind,
  type OpenWake,
  pruneSpans,
  RESUME_GIVE_UP_MS,
  resumeSegments,
  type ResumeTiming,
  SAMPLE_EVERY_MS,
  summarize,
} from "./idle-measure.ts";
import { releasableWorkers } from "./worker-machine-release.ts";

const FILE = "idle-measure.json";
const FILE_MOST = 8 * 1024 * 1024;
const SPANS_MOST = 20_000;
const WAKES_MOST = 5_000;
const LOOK_EVERY = "1 second";
const SUMMARY_EVERY = "1 hour";
const WEEK_MS = 7 * DAY_MS;

interface Kept {
  spans: ReadonlyArray<IdleSpan>;
  wakes: ReadonlyArray<ResumeTiming>;
}

const keptMeasurements = (dataDir: string | undefined) => {
  const file = dataDir === undefined ? undefined : privateJsonFile(dataDir, FILE, FILE_MOST);
  let kept: Kept = { spans: [], wakes: [] };
  try {
    const read = file?.read() as
      | { version?: unknown; spans?: unknown; wakes?: unknown }
      | undefined;
    if (read?.version === 1 && Array.isArray(read.spans) && Array.isArray(read.wakes))
      kept = { spans: read.spans as IdleSpan[], wakes: read.wakes as ResumeTiming[] };
  } catch {
    kept = { spans: [], wakes: [] };
  }
  return {
    get: () => kept,
    set: (next: Kept, now: number) => {
      kept = {
        spans: pruneSpans(next.spans, now - KEEP_MS).slice(-SPANS_MOST),
        wakes: next.wakes.filter((wake) => wake.wakeAt >= now - KEEP_MS).slice(-WAKES_MOST),
      };
      return Effect.try(() => file?.write({ version: 1, ...kept })).pipe(
        Effect.catch((error) =>
          Effect.logWarning("idle machine measurements could not be kept").pipe(
            Effect.annotateLogs({ reason: String(error) }),
          ),
        ),
      );
    },
  };
};

const quietly = (what: string) =>
  Effect.catchCause((cause) => Effect.logWarning(`the idle machine ${what} failed`, cause));

type Machine = ReturnType<RemoteHostsShape["list"]>[number];

const onDemandWorkerKind = (machine: Machine): MachineKind | undefined =>
  machine.onDemand !== "worker"
    ? undefined
    : machine.via !== undefined
      ? "relayed"
      : machine.owner !== undefined
        ? "hosted"
        : undefined;

const facts = (
  thread: Thread,
  summary: NonNullable<Effect.Success<ReturnType<ThreadRuntimes["Service"]["summaryOf"]>>>,
  entry: WorkerLedgerEntry | undefined,
  plainWakes: ReadonlyArray<ThreadWake>,
  terminalBusy: boolean | undefined,
): IdleThreadFacts => {
  const atRest = summary.status !== "running" && summary.status !== "starting";
  const wakes = entry === undefined ? plainWakes : (entry.wakes ?? []);
  const prs = [
    ...(thread.boundPr === undefined ? [] : [thread.boundPr]),
    ...(thread.extraPrs ?? []),
  ];
  return {
    status: summary.status,
    compacting: summary.compaction !== undefined,
    subagents: atRest && summary.activity !== undefined,
    queued: summary.queue.length,
    pendingRequests: summary.pendingRequests.length,
    background: summary.background?.length ?? 0,
    terminalBusy,
    wakes: wakes.map((wake) => ({
      ...(wake.onPr === undefined ? {} : { onPr: wake.onPr }),
      ...(wake.condition === undefined ? {} : { condition: wake.condition.kind }),
    })),
    runWatches: thread.runWatches?.length ?? 0,
    prMonitored:
      entry?.pr?.monitored === true ||
      (entry?.morePrs ?? []).some((pr) => pr.monitored === true) ||
      prs.some((pr) => pr.monitor || pr.reviewMonitor === true),
    limitWait: thread.limitWait !== undefined && thread.limitWait.cancelled !== true,
    reportStands: entry?.reportStands === true,
    reported: entry?.lastReport !== undefined,
    worker: thread.spawnedBy !== undefined,
    saveFailed: thread.savedWork?.lastFailure !== undefined,
  };
};

/**
 * Measures worker machines started on demand, observe only (`idle-measure.ts`): once a minute
 * whether each could have been away and what held it, and each cold wake's timeline from the
 * session that wanted it to the first turn on it. Kept in `remote-access/idle-measure.json` for
 * two weeks; an hourly log line `idle machine measurement` says what the last week and hour came
 * to, and each wake's timeline is logged as `machine resume timing`. With no such machines it
 * does nothing; it never stops, starts or holds anything.
 */
export const IdleMeasureLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const remote = Option.getOrUndefined(yield* Effect.serviceOption(RemoteHosts));
    if (remote === undefined) return;
    const config = Option.getOrUndefined(yield* Effect.serviceOption(ServerConfig));
    const ports = Option.getOrUndefined(yield* Effect.serviceOption(ThreadPorts));
    const orchestration = yield* Orchestration;
    const store = yield* ThreadStore;
    const runtimes = yield* ThreadRuntimes;
    const kept = keptMeasurements(
      config === undefined || config.databaseFile === ":memory:" ? undefined : config.dataDir,
    );
    const measured = () =>
      remote.list().flatMap((machine) => {
        const kind = onDemandWorkerKind(machine);
        return kind === undefined ? [] : [{ machine, kind }];
      });

    const sample = Effect.gen(function* () {
      const machines = measured();
      if (machines.length === 0) return;
      const now = Date.now();
      const online = new Set(
        machines.flatMap(({ machine }) => (machine.onlineSince === undefined ? [] : [machine.id])),
      );
      const threads = (yield* store.listThreads).filter(
        (thread) => !(thread.spawnedBy === undefined && thread.parked === true),
      );
      const entries = new Map<ThreadId, WorkerLedgerEntry>();
      const finished = new Set<ThreadId>();
      const workspaces = new Set(
        threads.flatMap((thread) =>
          thread.workspaceId !== undefined && online.has(hostOf(effectiveCheckout(thread)))
            ? [thread.workspaceId]
            : [],
        ),
      );
      for (const workspace of workspaces) {
        const ledger = yield* orchestration.ledger(workspace).pipe(Effect.option);
        if (Option.isNone(ledger)) continue;
        for (const id of releasableWorkers(ledger.value.features)) finished.add(id);
        for (const feature of ledger.value.features)
          for (const worker of feature.workers) entries.set(worker.threadId, worker);
      }
      const plainWakes = yield* store.listThreadWakes;
      let spans = kept.get().spans;
      for (const { machine, kind } of machines) {
        const up = online.has(machine.id);
        const atWork = threads.filter(
          (thread) => hostOf(effectiveCheckout(thread)) === machine.id && !finished.has(thread.id),
        );
        const each: IdleThreadFacts[] = [];
        if (up)
          for (const thread of atWork) {
            const summary = yield* runtimes.summaryOf(thread.id);
            if (summary === undefined) continue;
            const terminalBusy =
              ports === undefined ? undefined : yield* ports.terminalBusyNow(thread.id);
            each.push(
              facts(
                thread,
                summary,
                entries.get(thread.id),
                plainWakes.filter((wake) => wake.threadId === thread.id),
                terminalBusy,
              ),
            );
          }
        spans = addSample(spans, { name: machine.name, kind }, classifyMachine(up, each), now);
      }
      yield* kept.set({ ...kept.get(), spans }, now);
    });

    const open = new Map<string, OpenWake>();
    const record = (timing: ResumeTiming) =>
      Effect.gen(function* () {
        yield* kept.set({ ...kept.get(), wakes: [...kept.get().wakes, timing] }, Date.now());
        yield* Effect.logInfo("machine resume timing").pipe(
          Effect.annotateLogs({
            machine: timing.machine,
            kind: timing.kind,
            outcome: timing.outcome,
            wakeAt: new Date(timing.wakeAt).toISOString(),
            ...resumeSegments(timing),
          }),
        );
      });
    const look = Effect.gen(function* () {
      const now = Date.now();
      for (const { machine, kind } of measured()) {
        const id = HostId.make(machine.id);
        const before = open.get(machine.id);
        const after = lookAtWake(
          before,
          {
            name: machine.name,
            kind,
            ...(machine.onlineSince === undefined ? {} : { onlineSince: machine.onlineSince }),
            ...(remote.stops.wantedSince(id) === undefined
              ? {}
              : { wantedSince: remote.stops.wantedSince(id)! }),
            settled: !remote.stops.owes(id) && !remote.stops.holding(id),
          },
          now,
        );
        if (after === undefined) continue;
        if (now - after.wakeAt > RESUME_GIVE_UP_MS) {
          open.delete(machine.id);
          yield* record(closeWake(after, now, "abandoned"));
        } else open.set(machine.id, after);
      }
    });
    const onWakeOf = (thread: Thread, act: (wake: OpenWake) => Effect.Effect<void>) =>
      Effect.suspend(() => {
        const wake = open.get(hostOf(effectiveCheckout(thread)));
        return wake === undefined ? Effect.void : act(wake);
      });
    const scope = yield* Effect.scope;
    const later = (effect: Effect.Effect<void>) => Effect.asVoid(Effect.forkIn(effect, scope));
    yield* runtimes.observe({
      onTurnStart: (thread) =>
        onWakeOf(thread, (wake) =>
          Effect.suspend(() => {
            const now = Date.now();
            const id = hostOf(effectiveCheckout(thread));
            open.delete(id);
            const onlineSince = remote.list().find((machine) => machine.id === id)?.onlineSince;
            const ready = lookAtWake(
              wake,
              {
                name: wake.machine,
                kind: wake.kind,
                ...(onlineSince === undefined ? {} : { onlineSince }),
                settled: true,
              },
              now,
            )!;
            return later(record(closeWake(ready, now, "turn")));
          }),
        ),
      onLimitWait: (thread, _wait, ended) =>
        onWakeOf(thread, (wake) =>
          Effect.sync(() => {
            open.set(
              hostOf(effectiveCheckout(thread)),
              limitOnWake(wake, ended === undefined, Date.now()),
            );
          }),
        ),
    });

    const summary = Effect.gen(function* () {
      const { spans, wakes } = kept.get();
      if (spans.length === 0 && wakes.length === 0) return;
      const now = Date.now();
      yield* Effect.logInfo("idle machine measurement").pipe(
        Effect.annotateLogs({
          week: JSON.stringify(summarize(spans, wakes, now - WEEK_MS, now)),
          hour: JSON.stringify(summarize(spans, wakes, now - 60 * 60_000, now)),
        }),
      );
    });

    yield* sample.pipe(
      quietly("sample"),
      Effect.repeat(Schedule.spaced(SAMPLE_EVERY_MS)),
      Effect.forkScoped,
    );
    yield* look.pipe(
      quietly("wake look"),
      Effect.repeat(Schedule.spaced(LOOK_EVERY)),
      Effect.forkScoped,
    );
    yield* summary.pipe(
      quietly("summary"),
      Effect.delay("5 minutes"),
      Effect.repeat(Schedule.spaced(SUMMARY_EVERY)),
      Effect.forkScoped,
    );
  }),
);
