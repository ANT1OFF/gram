// Where `spawn_worker`'s `sandbox` gets a worker a machine of its own, for the orchestrator's
// prompt (`kit.ts`).

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { OnDemand } from "../../embedding/on-demand.ts";
import { SignedInWorkers } from "../../embedding/signed-in-workers.ts";

/** Read from the services there are, once, as the kit is made. */
export const workerMachinesOffered = Effect.gen(function* () {
  const onDemandHosts = Option.getOrUndefined(yield* Effect.serviceOption(OnDemand));
  const signedInWorkers = Option.getOrUndefined(yield* Effect.serviceOption(SignedInWorkers));
  /**
   * Where `spawn_worker`'s `sandbox` gets a worker a machine of its own now, in a few words for the
   * orchestrator's prompt: the embedder's provider, or the hosted server the desktop app is signed
   * in to. Undefined where it gets none, and the prompt then says nothing of it.
   */
  const offered: Effect.Effect<string | undefined> =
    onDemandHosts !== undefined
      ? Effect.succeed("this deployment")
      : signedInWorkers === undefined || !signedInWorkers.port.available
        ? Effect.succeed(undefined)
        : signedInWorkers.source.pipe(
            Effect.map((found) => ("refused" in found ? undefined : found.source.label)),
            Effect.timeoutOption("3 seconds"),
            Effect.map(Option.getOrUndefined),
          );
  return offered;
});
