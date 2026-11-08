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
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import { spawnLocalHost } from "./child.ts";
import { filesOn, type HostFiles } from "./files.ts";

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
  /** The host by id; `HostUnavailable` for one that isn't paired or isn't connected now. */
  get(id: HostId): Effect.Effect<WorkerHost, HostUnavailable>;
  /** The host a record (a checkout, a worker) is on, where an absent `hostId` is this machine. */
  of(record: { readonly hostId?: HostId | undefined }): Effect.Effect<WorkerHost, HostUnavailable>;
}

interface MachineParts {
  readonly files: HostFiles;
  readonly scan: HostPorts["scan"];
  readonly hello?: HostHello;
}

/**
 * This machine's folders and port scan through the host process, in a scope of its own: a host
 * that doesn't start or answer is closed at once and the server keeps `inServer`. One that
 * stops later hands its reads back to `inServer` from then on, rather than failing them.
 */
const throughHostProcess = (inServer: MachineParts) =>
  Effect.gen(function* () {
    const scope = yield* Scope.fork(yield* Effect.scope);
    const started = yield* spawnLocalHost.pipe(Scope.provide(scope), Effect.exit);
    if (Exit.isFailure(started)) {
      yield* Scope.close(scope, Exit.void);
      const reason = Cause.squash(started.cause);
      yield* Effect.logWarning("worker host: its process didn't start; it runs in the server").pipe(
        Effect.annotateLogs({ reason: reason instanceof Error ? reason.message : String(reason) }),
      );
      return inServer;
    }
    const host = started.value;
    yield* Effect.logInfo("worker host: running as its own process").pipe(
      Effect.annotateLogs({ pid: host.hello.pid }),
    );
    const either =
      <Args extends ReadonlyArray<unknown>, A, E>(
        viaHost: (...args: Args) => Effect.Effect<A, E>,
        local: (...args: Args) => Effect.Effect<A, E>,
      ) =>
      (...args: Args): Effect.Effect<A, E> =>
        // Chosen when the read runs, so an effect built before the host went still falls back.
        Effect.suspend(() => (host.gone() ? local(...args) : viaHost(...args)));
    const parts: MachineParts = {
      files: {
        list: either(host.files.list, inServer.files.list),
        search: either(host.files.search, inServer.files.search),
        names: either(host.files.names, inServer.files.names),
      },
      scan: Effect.suspend(() => (host.gone() ? inServer.scan : host.scan)),
      hello: host.hello,
    };
    return parts;
  });

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

  /** This machine only, built from the services already in the server. */
  static readonly layerLocal: Layer.Layer<
    WorkerHosts,
    never,
    AgentHosts | CheckoutService | Worktrees | GitStateRuntime | Proc | HostTerminals
  > = Layer.suspend(() =>
    WorkerHosts.layerLocalWith({ hostProcess: process.env["GRAM_HOST_PROCESS"] === "1" }),
  );

  /**
   * This machine, with `hostProcess` reading its folders and scanning its ports through the host
   * running as its own process (`gram-host`), over the host protocol. A host process that can't
   * start, or answers on another protocol version, leaves those parts in the server, as without
   * it. Its other parts move to the host process one at a time.
   */
  static readonly layerLocalWith = (options: {
    readonly hostProcess: boolean;
  }): Layer.Layer<
    WorkerHosts,
    never,
    AgentHosts | CheckoutService | Worktrees | GitStateRuntime | Proc | HostTerminals
  > =>
    Layer.effect(
      WorkerHosts,
      Effect.gen(function* () {
        const proc = yield* Proc;
        const inServer: MachineParts = {
          files: filesOn(proc),
          scan: liveScan.pipe(Effect.provideService(Proc, proc)),
        };
        const machine = options.hostProcess ? yield* throughHostProcess(inServer) : inServer;
        return WorkerHosts.fromHosts({
          id: LOCAL_HOST_ID,
          sessions: yield* AgentHosts,
          checkouts: yield* CheckoutService,
          worktrees: yield* Worktrees,
          git: yield* GitStateRuntime,
          files: machine.files,
          terminals: yield* HostTerminals,
          ports: { scan: machine.scan },
          process: machine.hello,
        });
      }),
    );

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
