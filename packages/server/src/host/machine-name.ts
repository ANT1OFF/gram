import type { HostId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { RemoteHosts } from "./remote-hosts.ts";

/**
 * The name a joined machine was given, for messages about it whether or not it is online; its id
 * when it isn't joined here (any more), or in a layer without joined machines.
 */
export const machineNames = Effect.map(
  Effect.serviceOption(RemoteHosts),
  (remote) => (id: HostId) => Option.getOrUndefined(remote)?.machines.get(id)?.name ?? id,
);
