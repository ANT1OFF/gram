import { AppToolError, effectiveCheckout, hostOf, type ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { resolveWorkerPicks, type WorkerMachineResize } from "../embedding/worker-machines.ts";
import { type WorkerSandboxDeps, workerMachineSourceFor } from "./worker-sandbox.ts";

/**
 * `request_resources`: has the calling worker's machine hold a larger size for a while, or go
 * back, through the provider its orchestrator's machines come from. Where the provider keeps who
 * is on each machine, the ask carries the worker's seat: the hold is then that worker's own, and
 * its going back takes nothing from a worker it shares the machine with.
 */
export const requestWorkerResize = (
  { store, onDemand, signedIn, workerHosts, joined }: Omit<WorkerSandboxDeps, "orchestration">,
  caller: ThreadId,
  input: {
    readonly size: string;
    readonly minutes?: number | undefined;
    readonly reason?: string | undefined;
  },
): Effect.Effect<WorkerMachineResize & { readonly machine: string }, AppToolError> =>
  Effect.gen(function* () {
    const tool = "request_resources";
    const fail = (message: string) => new AppToolError({ tool, message });
    const read = (id: ThreadId) =>
      store.getThread(id).pipe(Effect.mapError(() => fail(`No thread ${id} can be read.`)));
    const target = yield* read(caller);
    const orchestratorId = target.spawnedBy?.threadId;
    const host = hostOf(effectiveCheckout(target));
    const machine = joined().find((each) => each.id === host && each.onDemand === "worker");
    if (orchestratorId === undefined || machine === undefined)
      return yield* fail(
        "You run on a machine that isn't a worker's own, so there is nothing to resize here.",
      );
    const source = yield* workerMachineSourceFor(
      { store, onDemand, signedIn, workerHosts, joined },
      orchestratorId,
      tool,
    );
    if (source === undefined || "refused" in source || !source.theirs(machine))
      return yield* fail(`${machine.name}'s provider can't be reached from here now.`);
    if (source.resize === undefined)
      return yield* fail(`${source.label} doesn't resize its machines.`);
    const wanted = input.size.trim();
    let size: string | null = null;
    if (wanted !== "default") {
      const offered = yield* source.choices;
      const resolved = resolveWorkerPicks(offered?.choices, { size: wanted });
      if ("refused" in resolved) return yield* fail(resolved.refused);
      size = resolved.picks.size ?? wanted;
    }
    const seat = target.spawnedBy?.placement?.seat;
    const seated = seat !== undefined && (yield* source.sharing) !== undefined;
    const answered = yield* source.resize({
      name: machine.name,
      size,
      holdMinutes: input.minutes,
      reason: input.reason,
      ...(seated ? { worker: seat } : {}),
    });
    return { ...answered, machine: machine.name };
  });
