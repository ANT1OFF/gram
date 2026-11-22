import * as Effect from "effect/Effect";
import type { RemoteHostsShape } from "../host/remote-hosts.ts";
import type { RelayedDial } from "./signed-in-port.ts";

/** Takes one relayed connection as its machine's dial, or ends it with why. */
export const takeRelayedDial = (hosts: RemoteHostsShape, dial: RelayedDial) =>
  Effect.gen(function* () {
    const machine = hosts.machines.list().find((each) => each.name === dial.name);
    if (machine?.via === undefined || machine.via !== dial.origin) {
      dial.end(4401, "unauthorized: machine not joined");
      return;
    }
    const decision = hosts.machines.authorizeConnect(dial.origin, dial.headers, "relayed");
    if (decision.kind === "refused") {
      dial.end(4000 + decision.status, decision.message);
      return;
    }
    if (decision.machine.id !== machine.id) {
      dial.end(4401, "unauthorized: another machine's dial");
      return;
    }
    yield* hosts.attach(hosts.admit(decision.machine, dial.origin), yield* dial.socket);
  });
