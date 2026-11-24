import { AppToolError, type ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { OnDemand } from "../embedding/on-demand.ts";
import type { SignedInWorkers } from "../embedding/signed-in-workers.ts";
import type { RemoteHosts } from "../host/remote-hosts.ts";
import type { WorkerHosts } from "../host/worker-host.ts";
import type { ThreadStore } from "../persistence/thread-store.ts";
import { isLiveWorker } from "./ledger.ts";
import type { Orchestration } from "./service.ts";

const unread = (tool: string) => () =>
  new AppToolError({ tool, message: "The workspace's workers can't be read now." });

/** What the sandbox planner reads: the tools' own services, as `tools.ts` has them. */
export interface WorkerSandboxDeps {
  readonly orchestration: Orchestration["Service"];
  readonly store: ThreadStore["Service"];
  readonly onDemand: OnDemand["Service"] | undefined;
  readonly signedIn: SignedInWorkers["Service"] | undefined;
  readonly workerHosts: WorkerHosts["Service"] | undefined;
  readonly joined: () => ReturnType<RemoteHosts["Service"]["list"]>;
}

type Store = WorkerSandboxDeps["store"];

const workspaceOf = (store: Store, caller: ThreadId, tool: string) =>
  store.getThread(caller).pipe(
    Effect.mapError(unread(tool)),
    Effect.map((thread) => thread.workspaceId),
  );

/** The charter of the workspace `caller` orchestrates, or works in. Undefined: it has none. */
export const charterOf = (store: Store, caller: ThreadId, tool: string) =>
  Effect.gen(function* () {
    const workspaceId = yield* workspaceOf(store, caller, tool);
    if (workspaceId === undefined) return undefined;
    return Option.getOrUndefined(yield* store.getWorkspace(workspaceId).pipe(Effect.option))
      ?.charter;
  });

/**
 * Every open thread, and which workers of `caller`'s workspace the ledger reads as finished: what
 * decides who counts against a machine's cap.
 */
export const placedThreads = (
  { store, orchestration }: Pick<WorkerSandboxDeps, "store" | "orchestration">,
  caller: ThreadId,
  tool: string,
) =>
  Effect.gen(function* () {
    const threads = yield* store.listThreads.pipe(Effect.mapError(unread(tool)));
    const workspaceId = yield* workspaceOf(store, caller, tool);
    const ledger =
      workspaceId === undefined
        ? undefined
        : Option.getOrUndefined(yield* orchestration.ledger(workspaceId).pipe(Effect.option));
    return {
      threads,
      finished: new Set(
        (ledger?.features ?? [])
          .flatMap((feature) => feature.workers)
          .filter((worker) => !isLiveWorker(worker))
          .map((worker) => worker.threadId),
      ),
    };
  });
