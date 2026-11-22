import { HostId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import type { RemoteHostsShape } from "../host/remote-hosts.ts";
import { parseMachineStatus, providerWordOf } from "./signed-in-calls.ts";
import type { WorkerMachinePortShape } from "./signed-in-port.ts";

const relayedOnline = (hosts: Pick<RemoteHostsShape, "list">): ReadonlySet<string> =>
  new Set(
    hosts
      .list()
      .filter(
        (machine) =>
          machine.via !== undefined &&
          machine.onDemand === "worker" &&
          machine.onlineSince !== undefined,
      )
      .map((machine) => machine.id),
  );

const askAfter = (
  port: WorkerMachinePortShape,
  hosts: Pick<RemoteHostsShape, "list" | "providerSaid">,
  afterMs: number,
  id: string,
) =>
  Effect.gen(function* () {
    yield* Effect.sleep(afterMs);
    const machine = hosts.list().find((each) => each.id === id);
    if (machine?.via === undefined || machine.onlineSince !== undefined) return;
    const answered = yield* port.call(
      machine.via,
      "status",
      { name: machine.name },
      { account: machine.viaAccount },
    );
    if (!answered.ok || answered.status >= 300) return;
    if (hosts.list().find((each) => each.id === id)?.onlineSince !== undefined) return;
    hosts.providerSaid?.(
      HostId.make(id),
      providerWordOf(parseMachineStatus(answered.body), Date.now()),
    );
  }).pipe(Effect.catchCause(() => Effect.void));

/** How long after a relayed machine drops its server is asked what became of it. */
export const ASK_ON_DROP_MS = 20_000;

/**
 * Asks a relayed worker machine's server what became of it, once, `ASK_ON_DROP_MS` after it
 * drops, so its mark says so (reclaimed, paused, failed) soon rather than at the next reclaimed
 * pass. Nothing is asked of one back online by then; nothing acts on the answer but the mark.
 */
export const askOnDrop = (
  port: WorkerMachinePortShape,
  hosts: Pick<RemoteHostsShape, "list" | "watch" | "providerSaid">,
  afterMs: number = ASK_ON_DROP_MS,
) =>
  Effect.gen(function* () {
    const run = yield* FiberSet.makeRuntime<never>();
    let online = relayedOnline(hosts);
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        hosts.watch(() => {
          const now = relayedOnline(hosts);
          for (const id of online) if (!now.has(id)) run(askAfter(port, hosts, afterMs, id));
          online = now;
        }),
      ),
      (unwatch) => Effect.sync(unwatch),
    );
  });
