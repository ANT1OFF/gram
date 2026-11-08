import { type HostId, hostOf, HostUnavailable, LOCAL_HOST_ID } from "@gram/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AgentHosts } from "../runtime/agent-hosts.ts";
import { CheckoutService, type CheckoutServiceShape } from "../runtime/hooks.ts";

/**
 * One machine's worth of the work that touches a checkout: the agent sessions that run in it and
 * the checkouts themselves. The rest of the server reaches a machine only through this, so that a
 * machine can later be another process or another computer without its callers changing.
 *
 * The local host is today's code, so a call on it is a function call. Owners move behind it one at
 * a time, each with its invariants: sessions and checkouts first; worktree listing, git, files,
 * terminals and ports after them.
 */
export interface WorkerHost {
  /** `local` for this machine (`LOCAL_HOST_ID`); a paired machine's id otherwise. */
  readonly id: HostId;
  /** The agent CLIs this machine runs, by kind. */
  readonly sessions: AgentHosts["Service"];
  /** Creating, releasing, restoring and checking the presence of this machine's checkouts. */
  readonly checkouts: CheckoutServiceShape;
}

export interface WorkerHostsShape {
  /** This machine's host, always present. */
  readonly local: WorkerHost;
  /** The host by id; `HostUnavailable` for one that isn't paired or isn't connected now. */
  get(id: HostId): Effect.Effect<WorkerHost, HostUnavailable>;
  /** The host a record (a checkout, a worker) is on, where an absent `hostId` is this machine. */
  of(record: { readonly hostId?: HostId | undefined }): Effect.Effect<WorkerHost, HostUnavailable>;
}

/** The machines this server can place work on. Only this one, until machines can be paired. */
export class WorkerHosts extends Context.Service<WorkerHosts, WorkerHostsShape>()(
  "@gram/server/WorkerHosts",
) {
  /** The hosts given, `local` among them; any other id is unavailable. */
  static readonly fromHosts = (local: WorkerHost, others: ReadonlyArray<WorkerHost> = []) => {
    const byId = new Map<HostId, WorkerHost>([
      [local.id, local],
      ...others.map((h) => [h.id, h] as const),
    ]);
    const get = (id: HostId) => {
      const host = byId.get(id);
      return host === undefined
        ? Effect.fail(new HostUnavailable({ hostId: id, message: `No machine "${id}" is paired.` }))
        : Effect.succeed(host);
    };
    return WorkerHosts.of({ local, get, of: (record) => get(hostOf(record)) });
  };

  /** This machine only, built from the agent hosts and checkout service already in the server. */
  static readonly layerLocal: Layer.Layer<WorkerHosts, never, AgentHosts | CheckoutService> =
    Layer.effect(
      WorkerHosts,
      Effect.gen(function* () {
        return WorkerHosts.fromHosts({
          id: LOCAL_HOST_ID,
          sessions: yield* AgentHosts,
          checkouts: yield* CheckoutService,
        });
      }),
    );
}
