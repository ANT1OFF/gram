import {
  AppToolError,
  effectiveCheckout,
  type HostId,
  hostOf,
  type Thread,
  type ThreadId,
  type ThreadStatus,
  workerPackingOf,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { randomUUID } from "node:crypto";
import { defineAppTool } from "../app-tools/definition.ts";
import type { RemoteHostsShape } from "../host/remote-hosts.ts";
import type { ThreadRuntimesShape } from "../runtime/thread-runtimes-shape.ts";
import { DAY_MS } from "../zone-time.ts";
import { makeRequestResources } from "./request-resources-tool.ts";
import { WorkerSandbox } from "./tool-inputs.ts";
import { moveWorkerTo, WorkerNotMoved } from "./worker-moves.ts";
import { machineCap, packingOn, workersOnMachine } from "./worker-packing.ts";
import { requestWorkerResize } from "./worker-resize.ts";
import {
  charterOf,
  type makeWorkerSandbox,
  placedThreads,
  type WorkerSandboxDeps,
  workerMachineSourceFor,
} from "./worker-sandbox.ts";

const WAITING_MOVE_TRIED_EVERY = "30 seconds";
const WAITING_MOVE_KEPT_MS = DAY_MS;

const failWith = (tool: string) => (message: string) => new AppToolError({ tool, message });

const statusReader = (runtimes: Pick<ThreadRuntimesShape, "status">) => (id: ThreadId) =>
  runtimes.status(id).pipe(Effect.orElseSucceed((): ThreadStatus => "cold"));

const AT_REST: ReadonlySet<ThreadStatus> = new Set(["cold", "idle", "error"]);

export interface WorkerMachineToolsDeps {
  readonly sandbox: WorkerSandboxDeps;
  readonly planner: Effect.Success<ReturnType<typeof makeWorkerSandbox>>;
  readonly runtimes: Pick<ThreadRuntimesShape, "relocate" | "updateThread" | "status">;
  readonly remoteHosts: Pick<RemoteHostsShape, "connection" | "machines" | "stops"> | undefined;
}

/**
 * The tools an orchestrator and its workers manage hosted machines with: `request_resources` (a
 * worker's machine holds more for a heavy step), `worker_machines` (which machines, who is on
 * each, how much room) and `place_worker` (moves a worker between machines, between its turns).
 * Made in the scope the moves that wait for a worker to rest are tried again in: a worker in a
 * turn is moved once its status is cold, idle or error, looked at every half minute, for a day.
 * Nothing runs while no move waits. Those waiting moves are kept in memory, and are lost when
 * this Gram restarts.
 */
export const makeWorkerMachineTools = ({
  sandbox,
  planner,
  runtimes,
  remoteHosts,
}: WorkerMachineToolsDeps): Effect.Effect<
  ReadonlyArray<ReturnType<typeof defineAppTool>>,
  never,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const { store, joined } = sandbox;
    const read = (tool: string, id: ThreadId) =>
      store
        .getThread(id)
        .pipe(Effect.mapError(() => failWith(tool)(`No thread ${id} can be read.`)));
    const machineOf = (thread: Thread) =>
      joined().find((each) => each.id === hostOf(effectiveCheckout(thread)));
    const atRestOrNot = statusReader(runtimes);

    const waiting = new Map<
      ThreadId,
      { readonly orchestratorId: ThreadId; readonly to: WorkerSandbox; readonly since: number }
    >();

    const view = (caller: ThreadId) =>
      Effect.gen(function* () {
        const tool = "worker_machines";
        const fail = failWith(tool);
        const me = yield* read(tool, caller);
        const orchestratorId = me.spawnedBy?.threadId ?? caller;
        const asWorker = me.spawnedBy !== undefined;
        const orchestrator = asWorker ? yield* read(tool, orchestratorId) : me;
        const { threads, finished } = yield* placedThreads(sandbox, orchestratorId, tool);
        const charter = yield* charterOf(store, orchestratorId, tool);
        const found = yield* workerMachineSourceFor(sandbox, orchestratorId, tool);
        const source = found === undefined || "refused" in found ? undefined : found;
        const offer = source === undefined ? undefined : yield* source.sharing;
        const rows =
          offer === undefined || source === undefined ? undefined : yield* source.machines;
        const theirs = threads.filter((thread) => thread.spawnedBy?.threadId === orchestratorId);
        const own = hostOf(effectiveCheckout(orchestrator));
        const hostsOf = new Set(theirs.map((thread) => hostOf(effectiveCheckout(thread))));
        const shown = joined().filter((machine) =>
          asWorker
            ? machine.id === hostOf(effectiveCheckout(me))
            : hostsOf.has(machine.id) ||
              machine.id === own ||
              (source?.theirs(machine) === true &&
                !threads.some(
                  (thread) =>
                    thread.spawnedBy !== undefined &&
                    hostOf(effectiveCheckout(thread)) === machine.id,
                )),
        );
        if (asWorker && shown.length === 0)
          return yield* fail(
            "You run on your orchestrator's machine or this one, not a hosted machine, so there is no machine of workers to show.",
          );
        const statuses = new Map<ThreadId, ThreadStatus>();
        for (const thread of theirs)
          if (
            thread.parked !== true &&
            shown.some((m) => m.id === hostOf(effectiveCheckout(thread)))
          )
            statuses.set(thread.id, yield* atRestOrNot(thread.id));
        const machines = shown.map((machine) => {
          const row = rows?.find((each) => each.name === machine.name);
          const on = theirs.filter(
            (thread) => hostOf(effectiveCheckout(thread)) === machine.id && thread.parked !== true,
          );
          const counted = workersOnMachine(threads, machine.id, finished);
          const hosted = machine.onDemand === "worker";
          const cap = hosted ? machineCap(charter, offer, { row }) : undefined;
          const packing = packingOn(threads, machine.id);
          return {
            name: machine.name,
            online: machine.onlineSince !== undefined,
            ...(machine.id === own ? { orchestrators: true as const } : {}),
            ...(packing === undefined ? {} : { packing }),
            ...(row?.size === undefined ? {} : { size: row.size }),
            ...(row?.held === undefined ? {} : { holds: row.held }),
            ...(row?.architecture === undefined ? {} : { architecture: row.architecture }),
            ...(row?.isolation === undefined ? {} : { isolation: row.isolation }),
            ...(row?.environment === undefined ? {} : { environment: row.environment }),
            ...(cap === undefined ? {} : { cap, room: Math.max(0, cap - counted.length) }),
            ...(row?.usage === undefined ? {} : { usage: row.usage }),
            inTurn: on.filter((thread) => !AT_REST.has(statuses.get(thread.id) ?? "cold")).length,
            workers: on.map((thread) => ({
              threadId: thread.id,
              title: thread.title,
              status: statuses.get(thread.id) ?? "cold",
              ...(finished.has(thread.id) ? { finished: true as const } : {}),
              ...(thread.id === caller ? { you: true as const } : {}),
              ...(waiting.has(thread.id) ? { movesWhenAtRest: true as const } : {}),
            })),
          };
        });
        return {
          machines,
          ...(asWorker
            ? {}
            : {
                default: workerPackingOf(charter),
                ...(charter?.workersPerMachine === undefined
                  ? {}
                  : { workersPerMachine: charter.workersPerMachine }),
              }),
        };
      });

    const move = (orchestratorId: ThreadId, target: Thread, to: WorkerSandbox) =>
      Effect.gen(function* () {
        const tool = "place_worker";
        const fail = failWith(tool);
        if (remoteHosts === undefined)
          return yield* fail("No machines are joined here, so there is nowhere to move a worker.");
        const before = machineOf(target);
        const plan = yield* planner(
          orchestratorId,
          {
            title: target.title,
            feature: target.spawnedBy?.feature ?? "move",
            project: target.projectId,
            clientRequestId: `move:${target.id}:${randomUUID()}`,
          },
          to,
        ).pipe(Effect.mapError((error) => fail(error.message)));
        if (plan === undefined)
          return yield* fail(
            "A worker isn't moved onto its orchestrator's own machine: name a hosted machine for it.",
          );
        if (before !== undefined && before.name === plan.name)
          return { moved: false as const, machine: plan.name };
        const prepared = yield* plan.prepare.pipe(Effect.mapError((error) => fail(error.message)));
        const machine = joined().find((each) => each.name === plan.name);
        if (machine === undefined) {
          yield* prepared.abandon ?? Effect.void;
          return yield* fail(`${plan.name} isn't joined here, so nothing was moved.`);
        }
        const done = yield* moveWorkerTo({ hosts: remoteHosts, runtimes }, target, {
          id: machine.id as HostId,
          name: machine.name,
        }).pipe(Effect.tapError(() => prepared.abandon ?? Effect.void));
        if (!done.moved) return { moved: false as const, machine: plan.name };
        yield* runtimes
          .updateThread(target.id, (current) =>
            current.spawnedBy === undefined
              ? current
              : { ...current, spawnedBy: { ...current.spawnedBy, placement: plan.placement } },
          )
          .pipe(Effect.ignore);
        const seat = target.spawnedBy?.placement?.seat;
        if (before !== undefined && seat !== undefined) {
          const found = yield* workerMachineSourceFor(sandbox, orchestratorId, tool).pipe(
            Effect.option,
          );
          const source =
            found._tag === "None" || found.value === undefined || "refused" in found.value
              ? undefined
              : found.value;
          if (source !== undefined)
            yield* source.seats({ name: before.name, detach: [seat] }).pipe(Effect.ignore);
        }
        return { moved: true as const, machine: plan.name, from: before?.name };
      }).pipe(Effect.scoped);

    const tryWaiting = Effect.gen(function* () {
      for (const [threadId, ask] of waiting) {
        if (Date.now() - ask.since > WAITING_MOVE_KEPT_MS) {
          waiting.delete(threadId);
          continue;
        }
        const thread = yield* store.getThread(threadId).pipe(Effect.option);
        if (thread._tag === "None") {
          waiting.delete(threadId);
          continue;
        }
        if (!AT_REST.has(yield* atRestOrNot(threadId))) continue;
        const moved = yield* move(ask.orchestratorId, thread.value, ask.to).pipe(Effect.result);
        if (
          moved._tag === "Failure" &&
          moved.failure instanceof WorkerNotMoved &&
          moved.failure.busy
        )
          continue;
        waiting.delete(threadId);
        if (moved._tag === "Failure")
          yield* Effect.logWarning("a worker's move that waited for it to rest failed").pipe(
            Effect.annotateLogs({ threadId, reason: moved.failure.message }),
          );
      }
    });
    const scope = yield* Effect.scope;
    let trying = false;
    const queue = (threadId: ThreadId, ask: { orchestratorId: ThreadId; to: WorkerSandbox }) =>
      Effect.suspend(() => {
        waiting.set(threadId, { ...ask, since: Date.now() });
        if (trying) return Effect.void;
        trying = true;
        return Effect.asVoid(
          Effect.forkIn(
            Effect.gen(function* () {
              while (waiting.size > 0) {
                yield* Effect.sleep(WAITING_MOVE_TRIED_EVERY);
                yield* tryWaiting.pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning("the waiting worker moves failed", cause),
                  ),
                );
              }
            }).pipe(Effect.ensuring(Effect.sync(() => void (trying = false)))),
            scope,
          ),
        );
      });

    const workerMachines = defineAppTool({
      descriptor: {
        name: "worker_machines",
        class: "read",
        description:
          "The machines your workers run on (a worker: its own): each one's `packing`, size, `cap`, `room`, `inTurn` count and `workers`; for an orchestrator also its own machine and the workspace's `default`. `machine` names one.",
      },
      audience: ["orchestrator", "worker"],
      input: Schema.Struct({ machine: Schema.optionalKey(Schema.NonEmptyString) }),
      handle: (caller, { machine }) =>
        Effect.map(view(caller), (seen) =>
          machine === undefined
            ? seen
            : { ...seen, machines: seen.machines.filter((each) => each.name === machine) },
        ),
    });

    const placeWorker = defineAppTool({
      descriptor: {
        name: "place_worker",
        class: "self",
        description:
          "Move a worker to another hosted machine between its turns: `threadId` (one of yours) and `to`, as `spawn_worker`'s `sandbox`. A worker may only ask `{\"own\": true}` for itself. One at rest moves now; one in a turn moves when it next rests (`queued`). Its uncommitted work goes through the remote; its running processes don't. `cancel: true` drops a queued move.",
      },
      audience: ["orchestrator", "worker"],
      input: Schema.Struct({
        threadId: Schema.optionalKey(Schema.NonEmptyString),
        to: Schema.optionalKey(WorkerSandbox),
        cancel: Schema.optionalKey(Schema.Boolean),
      }),
      handle: (caller, input) =>
        Effect.gen(function* () {
          const tool = "place_worker";
          const fail = failWith(tool);
          const me = yield* read(tool, caller);
          const asWorker = me.spawnedBy !== undefined;
          const target = asWorker ? me : yield* read(tool, (input.threadId ?? "") as ThreadId);
          if (asWorker && input.threadId !== undefined && input.threadId !== caller)
            return yield* fail("A worker moves only itself: leave out threadId.");
          const orchestratorId = target.spawnedBy?.threadId;
          if (orchestratorId === undefined || (!asWorker && orchestratorId !== caller))
            return yield* fail(`${target.title} is not one of your workers.`);
          if (input.cancel === true) return { cancelled: waiting.delete(target.id) };
          const to = input.to;
          if (to === undefined) return yield* fail("Say where it goes, in `to`.");
          const shares = to.shared === true || to.shareWith !== undefined;
          if (asWorker && (to.own !== true || shares))
            return yield* fail(
              'A worker may only ask for a machine of its own for itself: `to: {"own": true}`. Packing workers together is your orchestrator\'s decision: ask it.',
            );
          if (to.own === false)
            return yield* fail(
              "A worker isn't moved onto its orchestrator's own machine: name a hosted machine for it.",
            );
          if (target.spawnedBy?.placement?.packing === "exclusive" && shares)
            return yield* fail(
              `${target.title} was placed on a machine that is never shared, so it isn't moved onto one it would share.`,
            );
          if (!AT_REST.has(yield* atRestOrNot(target.id))) {
            yield* queue(target.id, { orchestratorId, to });
            return {
              queued: true,
              said: `${target.title} is in a turn, which can't be carried to another machine. It moves when it next rests, and its next turn starts there.`,
            };
          }
          const done = yield* move(orchestratorId, target, to).pipe(
            Effect.catch((error) =>
              error instanceof WorkerNotMoved && error.busy
                ? Effect.as(queue(target.id, { orchestratorId, to }), { queued: true as const })
                : Effect.fail(fail(error.message)),
            ),
          );
          if ("queued" in done)
            return {
              queued: true,
              said: `${target.title} started a turn meanwhile. It moves when it next rests.`,
            };
          waiting.delete(target.id);
          return done.moved
            ? {
                ...done,
                said: `${target.title} now runs on ${done.machine}. Its folders came through the remote; its next session opens there and reads the recent turns.`,
              }
            : { ...done, said: `${target.title} is on ${done.machine} already.` };
        }),
    });

    const requestResources = makeRequestResources((caller, input) =>
      requestWorkerResize(sandbox, caller, input),
    );
    return [requestResources, workerMachines, placeWorker];
  });
