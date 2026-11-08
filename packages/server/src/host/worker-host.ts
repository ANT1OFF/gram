import {
  type HostHello,
  type HostId,
  hostOf,
  HostUnavailable,
  LOCAL_HOST_ID,
} from "@gram/contracts";
import { GitStateRuntime, Proc, Worktrees } from "@gram/git";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { filesOn, type HostFiles } from "./files.ts";
import { LocalHostProcess } from "./local-process.ts";
import { RemoteHosts } from "./remote-hosts.ts";
import { machineHosts } from "./remote-worker-host.ts";
import { EventHub } from "../events/event-hub.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { TerminalGate } from "../terminal/gate.ts";

export type { HostFiles } from "./files.ts";
import { liveScan, type PortScan } from "../ports/scan.ts";
import { AgentHosts } from "../runtime/agent-hosts.ts";
import { CheckoutService, type CheckoutServiceShape } from "../runtime/hooks.ts";
import { HostTerminals } from "../terminal/host-terminals.ts";
import type { Terminals } from "../terminal/terminals.ts";

export interface HostPorts {
  /** One sweep of the machine's listening ports and process tree. */
  readonly scan: Effect.Effect<PortScan, unknown>;
}

/** The parts of a machine that its checkouts' work reads and runs on, beside its agents. */
export interface HostMachine {
  /** Listing, creating, removing and restoring the machine's worktrees. */
  readonly worktrees: Worktrees["Service"];
  /** The machine's checkouts' git state, read and watched. */
  readonly git: GitStateRuntime["Service"];
  /** The machine's folders, for the Files panel. */
  readonly files: HostFiles;
  /** The machine's pseudo-terminals. */
  readonly terminals: Terminals;
  /** What listens on the machine's ports, and what runs in its terminals. */
  readonly ports: HostPorts;
}

/** A part a test's host leaves out: reaching it is a defect in the test, named so. */
const missing = <A extends object>(part: string): A =>
  new Proxy({} as A, {
    get: (_, key) =>
      typeof key === "symbol"
        ? undefined
        : () => Effect.die(new Error(`This test's host has no ${part} (${key} was called).`)),
  });

/**
 * One machine's worth of the work that touches a checkout: the agent sessions that run in it and
 * the checkouts themselves. The rest of the server reaches a machine only through this, so that a
 * machine can later be another process or another computer without its callers changing.
 *
 * The local host is today's code, so a call on it is a function call. Owners move behind it one at
 * a time, each with its invariants: sessions and checkouts, then worktrees, git state, the Files
 * panel's reads, terminals and the port scan. What decides whether a caller may reach a path stays
 * with the caller; the host only does the reading and running.
 */
export interface WorkerHost {
  /** `local` for this machine (`LOCAL_HOST_ID`); a paired machine's id otherwise. */
  readonly id: HostId;
  /** The agent CLIs this machine runs, by kind. */
  readonly sessions: AgentHosts["Service"];
  /** Creating, releasing, restoring and checking the presence of this machine's checkouts. */
  readonly checkouts: CheckoutServiceShape;
  readonly worktrees: HostMachine["worktrees"];
  readonly git: HostMachine["git"];
  readonly files: HostMachine["files"];
  readonly terminals: HostMachine["terminals"];
  readonly ports: HostMachine["ports"];
  /** The host process's hello, when this machine's host runs as its own process. */
  readonly process?: HostHello | undefined;
}

export interface WorkerHostsShape {
  /** This machine's host, always present. */
  readonly local: WorkerHost;
  /**
   * The host by id; `HostUnavailable` for one that isn't paired or isn't connected now. Another
   * machine's host lasts only as long as its connection, so look it up for each piece of work.
   */
  get(id: HostId): Effect.Effect<WorkerHost, HostUnavailable>;
  /** The host a record (a checkout, a worker) is on, where an absent `hostId` is this machine. */
  of(record: { readonly hostId?: HostId | undefined }): Effect.Effect<WorkerHost, HostUnavailable>;
}

/**
 * The joined machines' worker hosts, when this server has joined machines (`RemoteHosts`) and the
 * services their hosts are built on; absent in test layers without them.
 */
const joinedMachines = Effect.gen(function* () {
  const remote = Option.getOrUndefined(yield* Effect.serviceOption(RemoteHosts));
  const store = Option.getOrUndefined(yield* Effect.serviceOption(ThreadStore));
  const hub = Option.getOrUndefined(yield* Effect.serviceOption(EventHub));
  const proc = Option.getOrUndefined(yield* Effect.serviceOption(Proc));
  if (remote === undefined || store === undefined || hub === undefined || proc === undefined)
    return undefined;
  return yield* machineHosts(remote, {
    store,
    hub,
    proc,
    agents: yield* AgentHosts,
    gate: Option.getOrUndefined(yield* Effect.serviceOption(TerminalGate)),
  });
});

/** The machines this server can place work on: this one, and the machines joined to it. */
export class WorkerHosts extends Context.Service<WorkerHosts, WorkerHostsShape>()(
  "@gram/server/WorkerHosts",
) {
  /** The hosts given, `local` among them; any other id is unavailable. */
  static readonly fromHosts = (
    local: WorkerHost,
    others: ReadonlyArray<WorkerHost> = [],
    /** The joined machines' hosts, for an id that isn't among `others`. */
    machines?: (id: HostId) => Effect.Effect<WorkerHost, HostUnavailable>,
  ) => {
    const byId = new Map<HostId, WorkerHost>([
      [local.id, local],
      ...others.map((h) => [h.id, h] as const),
    ]);
    const get = (id: HostId) => {
      const host = byId.get(id);
      if (host !== undefined) return Effect.succeed(host);
      return machines === undefined
        ? Effect.fail(new HostUnavailable({ hostId: id, message: `No machine "${id}" is paired.` }))
        : machines(id);
    };
    return WorkerHosts.of({ local, get, of: (record) => get(hostOf(record)) });
  };

  /**
   * This machine only, built from the services already in the server, its folders, worktrees, git
   * state and port scan through `LocalHostProcess`. Agent sessions stay in the server
   * for now.
   */
  static readonly layerLocalOn: Layer.Layer<
    WorkerHosts,
    never,
    AgentHosts | CheckoutService | LocalHostProcess | HostTerminals
  > = Layer.effect(
    WorkerHosts,
    Effect.gen(function* () {
      const { parts } = yield* LocalHostProcess;
      const machines = yield* joinedMachines;
      return WorkerHosts.fromHosts(
        {
          id: LOCAL_HOST_ID,
          sessions: yield* AgentHosts,
          checkouts: yield* CheckoutService,
          worktrees: parts.worktrees,
          git: parts.git,
          files: parts.files,
          terminals: yield* HostTerminals,
          ports: { scan: parts.scan },
          process: parts.hello,
        },
        [],
        machines,
      );
    }),
  );

  /** This machine with a host process of its own, on when `GRAM_HOST_PROCESS=1`. */
  static readonly layerLocal: Layer.Layer<
    WorkerHosts,
    never,
    AgentHosts | CheckoutService | Worktrees | GitStateRuntime | Proc | HostTerminals
  > = WorkerHosts.layerLocalOn.pipe(Layer.provide(LocalHostProcess.layer));

  /** This machine with a host process of its own, on as `hostProcess` says, whatever the environment says. */
  static readonly layerLocalWith = (options: {
    readonly hostProcess: boolean;
  }): Layer.Layer<
    WorkerHosts,
    never,
    AgentHosts | CheckoutService | Worktrees | GitStateRuntime | Proc | HostTerminals
  > => WorkerHosts.layerLocalOn.pipe(Layer.provide(LocalHostProcess.layerWith(options)));

  /**
   * This machine for tests that run agents without the rest of the server: the parts a test layer
   * provides are used, and any it leaves out die with the part's name when reached.
   */
  static readonly layerLocalForTests: Layer.Layer<
    WorkerHosts,
    never,
    AgentHosts | CheckoutService
  > = Layer.effect(
    WorkerHosts,
    Effect.gen(function* () {
      const optional = <I, S extends object>(tag: Context.Key<I, S>, part: string) =>
        Effect.map(
          Effect.serviceOption(tag),
          Option.getOrElse(() => missing<S>(part)),
        );
      const proc = Option.getOrUndefined(yield* Effect.serviceOption(Proc));
      return WorkerHosts.fromHosts({
        id: LOCAL_HOST_ID,
        sessions: yield* AgentHosts,
        checkouts: yield* CheckoutService,
        worktrees: yield* optional(Worktrees, "worktrees"),
        git: yield* optional(GitStateRuntime, "git state"),
        files: proc === undefined ? missing<HostFiles>("files") : filesOn(proc),
        terminals: yield* optional(HostTerminals, "terminals"),
        ports:
          proc === undefined
            ? { scan: Effect.die(new Error("This test's host has no port scan.")) }
            : { scan: liveScan.pipe(Effect.provideService(Proc, proc)) },
      });
    }),
  );
}
