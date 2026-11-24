import type { RemoteHostsShape } from "../host/remote-hosts.ts";
import type { OnDemandChoices } from "./on-demand.ts";
import type { StartsSent } from "./signed-in-calls.ts";
import type { WorkerMachinePortShape } from "./signed-in-port.ts";
import type { NameLocks, OwedStops } from "./worker-machine-stops.ts";
import type { OfferedModel, ProvidedMachine } from "./worker-machines.ts";

/** What a signed-in server's source works with (`signedInSource`). */
export interface SignedInDeps {
  readonly port: WorkerMachinePortShape;
  readonly hosts: Pick<RemoteHostsShape, "remove" | "providerSaid"> & {
    readonly list: () => ReadonlyArray<ProvidedMachine>;
    /** Its host's hello once online, to refuse one that can't carry app tools; absent in fakes. */
    readonly connection?: RemoteHostsShape["connection"];
    readonly machines: Pick<RemoteHostsShape["machines"], "provision"> &
      Partial<Pick<RemoteHostsShape["machines"], "get" | "setAside">>;
  };
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly everyMs?: number;
  readonly stopRetryMs?: number;
  /** How long a name is kept after a stop no one answered (`UNANSWERED_STOP_HOLD_MS`). */
  readonly unansweredHoldMs?: number;
  /** What each server offered, kept across sources a short while; none kept when left out. */
  readonly offered?: OfferedByServer;
  /** Stops a server never confirmed, for machines not registered here, to ask again later. */
  readonly owed?: OwedStops;
  /** The names a start is on its way for, which no stop owed for an earlier one may end. */
  readonly starting?: Set<string>;
  /** One lock per name, shared with the settling of stops owed (`withName`). */
  readonly locks?: NameLocks;
  /** How long a start the server is unavailable for waits before it is asked again, doubled. */
  readonly startRetryMs?: number;
  /**
   * Names the server says are stopped or failed: not relayed, since no dial wakes one there, until
   * a start of the name wakes it (`forgetReclaimed`, `wakeSignedIn`, `SignedInWorkersLive`).
   */
  readonly asleep?: Set<string>;
  /** The starts sent of each name, shared by every source and pass (`StartsSent`). */
  readonly sent?: StartsSent;
  /**
   * The mark a sign-in at `origin` has now, for one it had: a source made before its sign-in took
   * its organisation's mark finds what was moved to it, and asks and owes under it from then on.
   */
  readonly markOf?: (origin: string, account: string) => string | undefined;
}

/**
 * The choices and models each server offered, kept a short while, by origin and the sign-in they
 * were asked under (`workerMachineIdentity`): another sign-in's offer is never another's.
 */
export type OfferedByServer = Map<
  string,
  {
    readonly at: number;
    readonly value?: OnDemandChoices;
    readonly models?: ReadonlyArray<OfferedModel>;
  }
>;
