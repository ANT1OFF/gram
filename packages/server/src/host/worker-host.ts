import {
  embeddingOn,
  type HostHello,
  type HostId,
  hostOf,
  HostUnavailable,
  isLocalHost,
  LOCAL_HOST_ID,
  type ThreadId,
  ThreadNotFound,
} from "@gram/contracts";
import { GitStateRuntime, Proc, Worktrees } from "@gram/git";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import type { HostAttachments, HostFileReads } from "./file-reads.ts";
import type { HostThreadPlaces } from "./thread-places.ts";
import type { HostLoopbackConnection, HostRepoIdentify } from "./protocol.ts";
import { filesOn, type HostFiles } from "./files.ts";
import type { HostFolders } from "./folders.ts";
import { type HeadlessPlacement, headlessLocal, headlessPlacement } from "./headless.ts";
import { LocalHostProcess } from "./local-process.ts";
import { type OwnerOf, ownedMachines, ownersOf } from "./ownership.ts";
import { Embedding } from "../embedding/embedding.ts";
import { RemoteHosts, type RemoteHostsShape } from "./remote-hosts.ts";
import { RESUME_STALL_MS, type StopMarks } from "./stop-marks.ts";
import { type MachineParts, placedHost } from "./placed.ts";
import { machineHosts } from "./remote-worker-host.ts";
import { forwardAppTools } from "./app-tools-forward.ts";
import { McpTokens } from "../app-tools/mcp-tokens.ts";
import { HttpServer } from "../platform/unstable.ts";
import type { HostShared } from "../shared/host-shared.ts";
import { ServerConfig } from "../config.ts";
import { attachmentsDir } from "../attachments/attachments.ts";
import { openerFenced } from "../platform/opener.ts";
import { EventHub } from "../events/event-hub.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { TerminalGate } from "../terminal/gate.ts";

export type { HostFiles } from "./files.ts";
export type { MachineParts } from "./placed.ts";
import { liveScan, type PortScan } from "../ports/scan.ts";
import { AgentHosts } from "../runtime/agent-hosts.ts";
import { CheckoutService, type CheckoutServiceShape } from "../runtime/hooks.ts";
import { HostTerminals } from "../terminal/host-terminals.ts";
import type { Terminals } from "../terminal/terminals.ts";
import { WAKE_WAIT_MS } from "./budgets.ts";

export interface HostPorts {
  /** One sweep of the machine's listening ports and process tree. */
  readonly scan: Effect.Effect<PortScan, unknown>;
  /**
   * Whether a terminal of the thread runs a command on this machine now, by a scan of its own;
   * undefined when that can't be told. Another machine's host has it: this one's terminals are
   * among `ProcessRoots`, which `ThreadPorts` reads.
   */
  readonly terminalBusy?: (threadId: ThreadId) => Effect.Effect<boolean | undefined>;
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
  /** The machine's name as the user gave it; absent for this machine. */
  readonly name?: string | undefined;
  /**
   * Another machine's files read for its threads, scoped there. Absent for this machine, whose
   * threads' files the server reads itself, and for a host whose build doesn't serve them.
   */
  readonly reads?: HostFileReads | undefined;
  /**
   * Another machine's folders, for a one-off thread the user places in one: listed for the picker
   * and checked there. Absent for this machine, whose folders the server lists itself, and for a
   * host whose build doesn't serve them.
   */
  readonly folders?: HostFolders | undefined;
  /** Another machine's store for the files users attach to its sessions; absent as `reads` is. */
  readonly attachments?: HostAttachments | undefined;
  /**
   * Another machine's places for threads started from a profile: a folder of its own made there,
   * a profile's files laid there. Absent for this machine, and for a host whose build has none.
   */
  readonly threadPlaces?: HostThreadPlaces | undefined;
  /**
   * What a worker's worktree on another machine is now, read there to confirm what this machine
   * recorded when it made it. Absent for this machine, and for a host whose build doesn't serve it.
   */
  readonly identify?: HostRepoIdentify | undefined;
  /**
   * Another machine's mirrors of workspaces' shared folders. Absent for this machine, whose threads
   * use the control plane's own folder, and for a host whose build doesn't keep them.
   */
  readonly shared?: HostShared | undefined;
  /**
   * Another machine's loopback ports, reached through its host for the browser a thread there
   * drives on this machine. Absent for this machine, and for a host whose build doesn't serve them.
   */
  readonly loopback?: HostLoopbackConnection | undefined;
}

export interface WorkerHostsShape {
  /** This machine's host, always present. */
  readonly local: WorkerHost;
  /**
   * The host by id; `HostUnavailable` for one that isn't paired or isn't connected now. Another
   * machine's host lasts only as long as its connection, so look it up for each piece of work.
   */
  get(id: HostId): Effect.Effect<WorkerHost, HostUnavailable>;
  /**
   * Every thread's work wherever it is placed, as one host: each call goes to the machine of the
   * thread, checkout or folder it is about (`placedHost`). This machine's host where no thread can
   * be on another one.
   */
  readonly placed: WorkerHost;
  /**
   * One machine's checkouts' git state, worktrees and folders, for a caller that knows which
   * machine a checkout is on (`hostOf`): what `placed` does for a path, without guessing the
   * machine from the path, which two machines can share. Offline, it answers as `placed` does.
   */
  machine(id: HostId): MachineParts;
  /**
   * The machine the threads place `path` on, as `placed` routes it: this one's for a path no thread
   * elsewhere holds, and `undefined` for one more than one machine holds, which a path can't settle.
   */
  placeOf(path: string): Effect.Effect<HostId | undefined>;
  /** The host a record (a checkout, a worker) is on, where an absent `hostId` is this machine. */
  of(record: { readonly hostId?: HostId | undefined }): Effect.Effect<WorkerHost, HostUnavailable>;
  /**
   * Present on a headless Gram, which runs no work itself: the joined machine that takes what
   * names none, or why none can. Absent everywhere else, where that is this machine.
   */
  readonly headless?: HeadlessPlacement | undefined;
  /**
   * The person a joined machine was started for, when an embedder started it for one: such a
   * machine is reached only for them (`ownership.ts`), which `get` already holds to. For what
   * records work there without reaching it, such as a fork in its source's checkout (`admitHost`).
   */
  readonly ownerOf: OwnerOf;
  /**
   * Whether `id` is a machine this server still knows: this one, a host it was given, or a joined
   * machine still paired. A machine removed for good (`POST /machines/remove`) is not, and no session
   * of a thread placed on it can open again until the thread is moved. Without joined machines to
   * ask, every id counts as paired.
   */
  paired(id: HostId): boolean;
}

/** How long a session about to open waits for a stopped machine to be started. */
export { WAKE_WAIT_MS };
const WAKE_LOOK = "500 millis";

/**
 * A joined machine's host for a session about to open. With the hosted features on, a machine
 * that is joined but away is waited for, for `waitMs`: whoever runs the machines stops idle ones
 * with their disks kept (`stop-resume.ts`) and starts one again when it is wanted, which the wait
 * says it is (`RemoteHosts.stops.wanted`). So is one readied to stop and still there, which takes
 * no work until it is stopped and started, or its stop is taken back, and one back after a stop
 * until its threads are resumed (`StopMarks.resuming`), whose folders may not be there before.
 * With them off, and for a machine that isn't joined, an absent machine is unavailable at once,
 * as ever; one there that owes a resume (back on another disk) is waited for all the same.
 *
 * A thread whose folder its machine's resume couldn't put back (`StopMarks.blocked`) opens no
 * session there, and says why at once. Nor does one whose machine's resume made no progress for
 * too long while it waited: no timer opens a session over folders that may still be coming.
 */
export const awaitedMachines =
  (
    get: (id: HostId) => Effect.Effect<WorkerHost, HostUnavailable>,
    remote: Pick<RemoteHostsShape, "machines" | "stops">,
    store: Pick<ThreadStore["Service"], "getSettings">,
    waitMs: number = WAKE_WAIT_MS,
  ) =>
  (id: HostId, threadId?: ThreadId): Effect.Effect<WorkerHost, HostUnavailable> =>
    Effect.gen(function* () {
      const notBack = () =>
        threadId === undefined ? undefined : remote.stops.blocked(id, threadId);
      const blockedNow = notBack();
      if (blockedNow !== undefined)
        return yield* new HostUnavailable({ hostId: id, message: blockedNow });
      const first = yield* get(id).pipe(
        Effect.map((host) => ({ host, away: undefined })),
        Effect.catch((away) => Effect.succeed({ host: undefined, away })),
      );
      const settled = () =>
        !remote.stops.holding(id) &&
        (!remote.stops.resuming(id) ||
          (threadId !== undefined && remote.stops.isThreadBack(id, threadId)));
      if (first.host !== undefined && settled()) return first.host;
      const asIs = first.host === undefined ? Effect.fail(first.away) : Effect.succeed(first.host);
      if (remote.machines.get(id)?.confirmedAt === undefined) return yield* asIs;
      if (!embeddingOn(yield* store.getSettings) && (first.host === undefined || settled()))
        return yield* asIs;
      yield* Effect.logInfo("a session waits for its machine to be started").pipe(
        Effect.annotateLogs({ hostId: id }),
      );
      if (threadId !== undefined) remote.stops.awaiting(id, threadId);
      const stalledNow = () => remote.stops.stalled(id) !== undefined;
      const ready = get(id).pipe(
        Effect.filterOrFail(
          settled,
          () =>
            new HostUnavailable({
              hostId: id,
              message: remote.stops.holding(id)
                ? "That machine is being stopped."
                : "That machine's threads are being put back.",
            }),
        ),
      );
      const stop = (message: string) => new HostUnavailable({ hostId: id, message });
      return yield* remote.stops.wanting(
        id,
        Effect.gen(function* () {
          const since = yield* Clock.currentTimeMillis;
          const host = yield* ready.pipe(
            Effect.retry({
              schedule: Schedule.spaced(WAKE_LOOK),
              while: () =>
                Effect.map(
                  Clock.currentTimeMillis,
                  (at) =>
                    notBack() === undefined &&
                    !stalledNow() &&
                    (at - since < waitMs || remote.stops.resumeRunning(id)),
                ),
            }),
            Effect.catch((error) => Effect.succeed(error)),
          );
          const why = notBack();
          if (why !== undefined) return yield* stop(why);
          if (stalledNow()) {
            yield* Effect.logWarning(
              "a machine's resume made no progress; a session waiting on it wasn't opened",
            ).pipe(
              Effect.annotateLogs({ hostId: id, ...(threadId === undefined ? {} : { threadId }) }),
            );
            return yield* stop(RESUME_STALLED);
          }
          if (host instanceof HostUnavailable) return yield* host;
          return host;
        }),
      );
    });

/**
 * Where a thread stands with its machine's resume, for what would open its session: `wait` while
 * the machine owes one and the thread's folders aren't back, `blocked` when a resume couldn't put
 * them back (`StopMarks.block`), otherwise nothing.
 */
export const restoreGateOf = (
  stops: Pick<StopMarks, "blocked" | "resuming" | "isThreadBack">,
  id: HostId,
  threadId: ThreadId,
): "wait" | "blocked" | undefined => {
  if (stops.blocked(id, threadId) !== undefined) return "blocked";
  return stops.resuming(id) && !stops.isThreadBack(id, threadId) ? "wait" : undefined;
};

/** What a session waiting on a resume that made no progress is told. */
export const RESUME_STALLED = `That machine's threads were being put back, and nothing came back for ${RESUME_STALL_MS / 60_000} minutes, so this session wasn't opened over folders that may not be there. It opens once the machine's resume completes.`;

const joinedMachines = Effect.gen(function* () {
  const remote = Option.getOrUndefined(yield* Effect.serviceOption(RemoteHosts));
  const store = Option.getOrUndefined(yield* Effect.serviceOption(ThreadStore));
  const hub = Option.getOrUndefined(yield* Effect.serviceOption(EventHub));
  const proc = Option.getOrUndefined(yield* Effect.serviceOption(Proc));
  if (remote === undefined || store === undefined || hub === undefined || proc === undefined)
    return undefined;
  const config = Option.getOrUndefined(yield* Effect.serviceOption(ServerConfig));
  const tokens = Option.getOrUndefined(yield* Effect.serviceOption(McpTokens));
  const http = Option.getOrUndefined(yield* Effect.serviceOption(HttpServer.HttpServer));
  const port = () =>
    http !== undefined && "port" in http.address
      ? http.address.port
      : config !== undefined && config.port > 0
        ? config.port
        : undefined;
  const get = yield* machineHosts(remote, {
    store,
    hub,
    proc,
    ...(tokens === undefined ? {} : { appTools: forwardAppTools({ tokens, store, port }) }),
    agents: yield* AgentHosts,
    gate: Option.getOrUndefined(yield* Effect.serviceOption(TerminalGate)),
    ...(config !== undefined && openerFenced(config)
      ? { carriedFrom: attachmentsDir(config.dataDir) }
      : {}),
  });
  const placedBefore = (yield* store.listThreads.pipe(Effect.orElseSucceed(() => []))).some(
    (thread) =>
      [thread.checkout, thread.currentCheckout, ...(thread.extraCheckouts ?? [])].some(
        (checkout) => checkout !== undefined && !isLocalHost(checkout),
      ),
  );
  const ownerOf = ownersOf(remote.machines);
  return {
    get: ownedMachines(ownerOf, get),
    forSession: ownedMachines(ownerOf, awaitedMachines(get, remote, store)),
    any: () => placedBefore || remote.machines.list().length > 0,
    ownerOf,
    paired: (id: HostId) => remote.machines.get(id) !== undefined,
  };
});

const NO_THREADS: Pick<ThreadStore["Service"], "listThreads" | "getThread"> = {
  listThreads: Effect.succeed([]),
  getThread: (threadId) => Effect.fail(new ThreadNotFound({ threadId })),
};

/** The machines this server can place work on: this one, and the machines joined to it. */
export class WorkerHosts extends Context.Service<WorkerHosts, WorkerHostsShape>()(
  "@gram/server/WorkerHosts",
) {
  /** The hosts given, `local` among them; any other id is unavailable. */
  static readonly fromHosts = (
    local: WorkerHost,
    others: ReadonlyArray<WorkerHost> = [],
    machines?: (id: HostId) => Effect.Effect<WorkerHost, HostUnavailable>,
    store?: Pick<ThreadStore["Service"], "listThreads" | "getThread">,
    anyMachines?: () => boolean,
    headless?: HeadlessPlacement,
    sessionMachines?: (
      id: HostId,
      threadId?: ThreadId,
    ) => Effect.Effect<WorkerHost, HostUnavailable>,
    ownerOf: OwnerOf = () => undefined,
    pairedMachine: (id: HostId) => boolean = () => true,
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
    const hosts = {
      local,
      get,
      ...(sessionMachines === undefined
        ? {}
        : {
            forSession: (id: HostId, threadId?: ThreadId) =>
              byId.has(id) ? get(id) : sessionMachines(id, threadId),
          }),
    };
    const placed = placedHost(
      hosts,
      store ?? NO_THREADS,
      store === undefined ? () => false : anyMachines,
      headless,
    );
    return WorkerHosts.of({
      local,
      get,
      of: (record) => get(hostOf(record)),
      placed: store === undefined && headless === undefined ? local : placed,
      machine: placed.machine,
      placeOf: placed.placeOf,
      ...(headless === undefined ? {} : { headless }),
      ownerOf,
      paired: (id) => byId.has(id) || pairedMachine(id),
    });
  };

  /**
   * `CheckoutService` as every thread's checkout is placed (`placed`), for whatever takes the
   * service itself: provided over the local one, a checkout on another machine is made, checked
   * and removed there.
   */
  static readonly placedCheckouts: Layer.Layer<CheckoutService, never, WorkerHosts> = Layer.effect(
    CheckoutService,
    Effect.gen(function* () {
      return (yield* WorkerHosts).placed.checkouts;
    }),
  );

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
      const store = Option.getOrUndefined(yield* Effect.serviceOption(ThreadStore));
      const config = Option.getOrUndefined(yield* Effect.serviceOption(ServerConfig));
      const embedding = Option.getOrUndefined(yield* Effect.serviceOption(Embedding));
      const headless =
        config?.headless === true
          ? headlessPlacement(
              Option.getOrUndefined(yield* Effect.serviceOption(RemoteHosts)),
              embedding?.config.hostProvider !== undefined,
            )
          : undefined;
      const local: WorkerHost = {
        id: LOCAL_HOST_ID,
        sessions: yield* AgentHosts,
        checkouts: yield* CheckoutService,
        worktrees: parts.worktrees,
        git: parts.git,
        files: parts.files,
        terminals: yield* HostTerminals,
        ports: { scan: parts.scan },
        process: parts.hello,
      };
      return WorkerHosts.fromHosts(
        headless === undefined ? local : headlessLocal(local),
        [],
        machines?.get,
        machines === undefined ? undefined : store,
        machines?.any,
        headless,
        machines?.forSession,
        machines?.ownerOf,
        machines?.paired,
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
      const machines = yield* joinedMachines;
      const store = Option.getOrUndefined(yield* Effect.serviceOption(ThreadStore));
      const owners = Option.getOrUndefined(
        yield* Effect.serviceOption(MachineOwnersForTests),
      )?.ownerOf;
      return WorkerHosts.fromHosts(
        {
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
        },
        [],
        machines?.get,
        machines === undefined ? undefined : store,
        machines?.any,
        undefined,
        machines?.forSession,
        owners ?? machines?.ownerOf,
        machines?.paired,
      );
    }),
  );
}

/**
 * Who each machine was started for, in `layerLocalForTests`, where no joined machine records it: a
 * test that places a thread on a machine someone owns (`ownership.ts`) says so here.
 */
export class MachineOwnersForTests extends Context.Service<
  MachineOwnersForTests,
  { readonly ownerOf: OwnerOf }
>()("@gram/server/MachineOwnersForTests") {}
