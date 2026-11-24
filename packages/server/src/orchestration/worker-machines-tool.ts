import {
  AppToolError,
  effectiveCheckout,
  hostOf,
  type ThreadId,
  type ThreadStatus,
  workerPackingOf,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { defineAppTool } from "../app-tools/definition.ts";
import type { ThreadRuntimesShape } from "../runtime/thread-runtimes-shape.ts";
import { makeRequestResources } from "./request-resources-tool.ts";
import { machineCap, packingOn, workersOnMachine } from "./worker-packing.ts";
import { requestWorkerResize } from "./worker-resize.ts";
import { charterOf, placedThreads } from "./worker-placed.ts";
import { type WorkerSandboxDeps, workerMachineSourceFor } from "./worker-sandbox.ts";

const failWith = (tool: string) => (message: string) => new AppToolError({ tool, message });

const statusReader = (runtimes: Pick<ThreadRuntimesShape, "status">) => (id: ThreadId) =>
  runtimes.status(id).pipe(Effect.orElseSucceed((): ThreadStatus => "cold"));

const AT_REST: ReadonlySet<ThreadStatus> = new Set(["cold", "idle", "error"]);

export interface WorkerMachineToolsDeps {
  readonly sandbox: WorkerSandboxDeps;
  readonly runtimes: Pick<ThreadRuntimesShape, "status">;
}

/**
 * The tools an orchestrator and its workers look after hosted machines with: `request_resources`
 * (a worker's machine holds more for a heavy step) and `worker_machines` (which machines, who is
 * on each, how much room).
 */
export const makeWorkerMachineTools = ({
  sandbox,
  runtimes,
}: WorkerMachineToolsDeps): Effect.Effect<ReadonlyArray<ReturnType<typeof defineAppTool>>> =>
  Effect.sync(() => {
    const { store, joined } = sandbox;
    const read = (tool: string, id: ThreadId) =>
      store
        .getThread(id)
        .pipe(Effect.mapError(() => failWith(tool)(`No thread ${id} can be read.`)));
    const atRestOrNot = statusReader(runtimes);

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
          const counted = workersOnMachine(threads, machine.id);
          const hosted = machine.onDemand === "worker";
          const cap = hosted ? machineCap(charter, offer, { row }) : undefined;
          const packing = sandbox.claims?.get(machine.name)?.mode ?? packingOn(threads, machine.id);
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

    const requestResources = makeRequestResources((caller, input) =>
      requestWorkerResize(sandbox, caller, input),
    );
    return [requestResources, workerMachines];
  });
