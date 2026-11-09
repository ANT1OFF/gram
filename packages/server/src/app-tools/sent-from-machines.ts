import { AppToolError, effectiveCheckout, hostOf } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { attachmentsDir } from "../attachments/attachments.ts";
import { ServerConfig } from "../config.ts";
import { machineNames } from "../host/machine-name.ts";
import { WorkerHosts } from "../host/worker-host.ts";
import type { SentFromMachines } from "./file-tools.ts";

const fail = (message: string) => new AppToolError({ tool: "send_file", message });

/**
 * `send_file`'s way to the machines joined to this Gram, over the worker hosts and attachments
 * folder of the server it runs in; `undefined` in a layer without them, where a thread on another
 * machine has its files refused.
 */
export const sentFromMachinesHere: Effect.Effect<SentFromMachines | undefined> = Effect.gen(
  function* () {
    const hosts = Option.getOrUndefined(yield* Effect.serviceOption(WorkerHosts));
    const config = Option.getOrUndefined(yield* Effect.serviceOption(ServerConfig));
    if (hosts === undefined || config === undefined) return undefined;
    const nameOf = yield* machineNames;
    return {
      dir: attachmentsDir(config.dataDir),
      readsFor: (thread) => {
        const id = hostOf(effectiveCheckout(thread));
        const name = nameOf(id);
        return hosts.get(id).pipe(
          Effect.mapError(() =>
            fail(`This thread's files are on ${name}, which can't be reached now.`),
          ),
          Effect.flatMap((host) =>
            host.reads === undefined
              ? Effect.fail(
                  fail(
                    `gram-host on ${name} is older than this Gram, so it can't send files. Run the install command there again to update it.`,
                  ),
                )
              : Effect.succeed({ name, reads: host.reads }),
          ),
        );
      },
    };
  },
);
