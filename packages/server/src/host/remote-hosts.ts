import {
  type HostHello,
  HostId,
  type HostStatus,
  HostUnavailable,
  type MachineProviderWord,
  type MachineState,
} from "@gram/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { ServerConfig } from "../config.ts";
import { Socket } from "../platform/unstable.ts";
import {
  createPairedMachines,
  dialNoncesLastSeen,
  type DialNonceStore,
  fileMachineStore,
  isProvisioned,
  fileNonceStore,
  machineView,
  type DialAccess,
  NO_DIALS,
  type PairedMachine,
  type PairedMachines,
  type PairedMachineStore,
} from "./paired-machines.ts";
import {
  connectHost,
  HOST_FENCED_CLOSE,
  HOST_FENCED_REASON,
  type HostConnection,
  helloMismatch,
  UNKNOWN_STATUS,
} from "./protocol.ts";
import { makeMachineUpdates, RETRY_MS, type UpdateRequest } from "./machine-updates.ts";
import * as Schedule from "effect/Schedule";
import * as Duration from "effect/Duration";
import * as FiberSet from "effect/FiberSet";
import { watchedSocket } from "./socket-end.ts";
import { MOVE_WITHIN_MS } from "./following-sessions.ts";
import {
  type MachineMarksByHost,
  makeStopMarks,
  type StopMarks,
  UNKNOWN_MARKS,
} from "./stop-marks.ts";
import { releaseOf, releaseOfConfig } from "./releases.ts";
import {
  type AutomaticStore,
  fileAutomaticStore,
  fileMarksStore,
  lazyFileStore,
  type MarksStore,
} from "./remote-hosts-stores.ts";

export type { AutomaticStore, MarksStore } from "./remote-hosts-stores.ts";

interface Online {
  readonly connection: HostConnection;
  readonly since: number;
  readonly origin: string;
  readonly close: () => void;
  status?: { readonly status: HostStatus; readonly at: number };
  checking?: Promise<HostStatus | undefined> | undefined;
}

const hostedOf = (
  machine: PairedMachine,
  logos: ReadonlyMap<string, string>,
): Pick<MachineState, "hosted"> => {
  if (machine.via === undefined || machine.viaName === undefined) return {};
  const logo = logos.get(machine.via);
  return { hosted: { name: machine.viaName, ...(logo === undefined ? {} : { logo }) } };
};

/** Whether two provider words say the same, whenever each was heard: the first is kept. */
export const sameWord = (
  a: MachineProviderWord | undefined,
  b: MachineProviderWord | undefined,
): boolean =>
  JSON.stringify(a === undefined ? a : { ...a, at: 0 }) ===
  JSON.stringify(b === undefined ? b : { ...b, at: 0 });

/** How old a status check may be before a listing asks the machine again. */
export const SIGN_IN_FRESH_MS = 60_000;

/**
 * A dial the route let through, pinned to the access it was let through under: the machine's
 * generation and the tailnet address it dialled, taken before the WebSocket upgrade starts. It
 * comes online only while both still hold.
 */
export interface AdmittedDial {
  readonly machine: PairedMachine;
  readonly origin: string;
  readonly generation: number;
}

export interface RemoteHostsShape {
  readonly machines: PairedMachines;
  /** The machine's host, when it is joined, confirmed and dialled in now. */
  readonly connection: (id: HostId) => Effect.Effect<HostConnection, HostUnavailable>;
  /** The tailnet address the machine dialled, while it is online: where it reaches this Gram. */
  readonly origin: (id: HostId) => string | undefined;
  /**
   * The joined machines as the settings page lists them, each offline one with why: `tailscale`
   * says whether access over Tailscale is on, off, or on but down, so none of them can dial.
   */
  readonly list: (tailscale?: DialAccess) => ReadonlyArray<ReturnType<typeof machineView>>;
  /**
   * The confirmed machines as a thread that runs on one shows it: its name, how it got in and
   * whether it is dialled in, with why not. What every client is sent, so far less than `list`.
   */
  readonly states: () => ReadonlyArray<MachineState>;
  /**
   * Calls `listener` after `states` may have changed: a machine joined, was confirmed or removed,
   * connected or dropped, or a dial of one was refused. Returns the unwatch.
   */
  readonly watch: (listener: () => void) => () => void;
  /**
   * Keeps the mark the hosted server at `origin` gave last (`WorkerMachineServer.logo`), for the
   * machines that came through it to show in `states`; undefined forgets it. Kept in memory only:
   * it is told again each time the server is asked for.
   */
  readonly hostedLogo?: (origin: string, logo: string | undefined) => void;
  /**
   * Keeps what whoever runs the machine last said of it (`MachineProviderWord`), for `states` to
   * show while it is offline; undefined forgets it. Kept in memory only, and dropped as it dials
   * in: what the provider says is asked again whenever it matters.
   */
  readonly providerSaid?: (id: HostId, word: MachineProviderWord | undefined) => void;
  /**
   * Runs `ready` when a machine's host says it is about to be taken away (`host.stop.going`), with
   * how long it waits: the host holds its exit until every `ready` has ended, or that time has
   * passed. Returns the unregister.
   */
  readonly onGoing: (ready: (id: HostId, withinMs: number) => Effect.Effect<void>) => () => void;
  /**
   * Where `states` reads whether access over Tailscale is switched off, so an offline machine says
   * that rather than that it never dialled; until it is given, access counts as on unless it was
   * last kept off. Only the switch is read: why Tailscale is down here changes with no word to
   * this registry, so `states` leaves it to Settings → Machines, which asks each time.
   */
  readonly accessFrom: (read: () => DialAccess) => void;
  /**
   * Pins a dial from `machine` that the route let through over `origin`, before its upgrade
   * starts: turning access off or moving it, or removing the machine, after this drops the dial.
   */
  readonly admit: (machine: PairedMachine, origin: string) => AdmittedDial;
  /**
   * Serves an admitted dial until its socket closes or the machine is removed. A second dial from
   * the same machine replaces the first.
   */
  readonly attach: (dial: AdmittedDial, socket: Socket.Socket) => Effect.Effect<void>;
  /**
   * Asks the machine what it can run now (its Claude sign-in, its tools) and keeps the answer for
   * the listing: `undefined` while it is offline. A check already running is shared.
   */
  readonly checkSignIn: (id: HostId) => Promise<HostStatus | undefined>;
  /**
   * Updates the machine to this Gram's release over its own connection, now or once it is idle;
   * `fallback` for a host too old to update itself, which the installer updates.
   */
  readonly update: (id: HostId) => UpdateRequest;
  /**
   * Whether joined machines update on their own, on until turned off. Kept beside the machines,
   * not in Settings, so only the local app's `/machines/*` routes change it: never a paired phone.
   */
  readonly automaticUpdates: () => boolean;
  readonly setAutomaticUpdates: (on: boolean) => void;
  /** Forgets the machine and closes its connection; false when it wasn't joined. */
  readonly remove: (id: HostId) => boolean;
  /** The address provisioned hosts dial, when this Gram listens for them. */
  readonly provisionedOrigin: string | undefined;
  /**
   * The machines readied to stop with their disks kept, and what waits on one to be started
   * (`stop-marks.ts`). A machine that dials in is no longer stopped.
   */
  readonly stops: StopMarks;
  /**
   * The machines being replaced and expected back on the same disk (a cloud machine reclaimed, a VM
   * moved): a session of one whose agent or connection goes waits for it to come back and carries
   * on there (`followingSessions`' `moving`), showing a notice meanwhile rather than failing.
   */
  readonly moves: MachineMoves;
  /**
   * Closes every provisioned host's connection and any of their dials still saying hello, for
   * when provisioned hosts are turned off. They stay registered.
   */
  readonly closeProvisioned: () => void;
  /**
   * Closes every joined machine's connection that didn't dial `origin`, and any still saying
   * hello: all of them when access over Tailscale is off (`undefined`). The machines stay joined,
   * and provisioned hosts, which dial their own listener, aren't touched.
   */
  readonly keepOrigin: (origin: string | undefined) => void;
}

/** What `RemoteHosts.moves` keeps. In memory only: a session doesn't outlive this process. */
export interface MachineMoves {
  /**
   * The machine is being replaced and is expected back: its host said it was going, or whoever
   * runs it said so (`POST /machines/stop/moving`). Its sessions wait `withinMs` for it, the
   * default when left out, from when each starts waiting. Held until a host of it dials in again.
   */
  readonly said: (id: HostId, withinMs?: number) => void;
  /**
   * How long a session of the machine waits for it now, or undefined when it isn't moving: said
   * so within that time and not back since, or readied to stop by this Gram recently.
   */
  readonly of: (id: HostId) => number | undefined;
}

/** The other machines joined to this Gram, and the connections of those dialled in. */
export class RemoteHosts extends Context.Service<RemoteHosts, RemoteHostsShape>()(
  "@gram/server/RemoteHosts",
) {
  static readonly make = (
    store: PairedMachineStore,
    now: () => number = Date.now,
    nonces?: DialNonceStore,
    options: {
      readonly release?: string | undefined;
      readonly retryMs?: number;
      /** Where the automatic-updates switch is kept; in memory when left out. */
      readonly automatic?: AutomaticStore;
      /**
       * The address provisioned hosts dial, when this Gram has a listener for them. Their dials
       * and connections are held to it alone and don't follow access over Tailscale.
       */
      readonly provisionedOrigin?: string | undefined;
      /** How often its connections ping their hosts; `HOST_PING_EVERY_MS` unless a test says. */
      readonly pingEveryMs?: number;
      /** Where the stop marks and disks are kept across a restart; in memory when left out. */
      readonly marks?: MarksStore;
      /** How long a session waits for a machine being replaced; `MOVE_WITHIN_MS` when left out. */
      readonly moveWithinMs?: number;
    } = {},
  ) =>
    Effect.gen(function* () {
      const watchers = new Set<() => void>();
      const goingReady = new Set<(id: HostId, withinMs: number) => Effect.Effect<void>>();
      const changed = () => {
        for (const watcher of watchers) {
          try {
            watcher();
          } catch (_aWatchersFailureIsItsOwn) {}
        }
      };
      const machines = createPairedMachines(store, now, nonces, changed);
      const online = new Map<HostId, Online>();
      const logos = new Map<string, string>();
      const providerWords = new Map<HostId, MachineProviderWord>();
      let readAccess: (() => DialAccess) | undefined;
      const root = yield* Effect.scope;
      const context = yield* Effect.context<never>();
      const runPromise = Effect.runPromiseWith(context);
      const runFork = yield* FiberSet.makeRuntime<never>();
      const marksStore = options.marks;
      const confirmed = () =>
        machines
          .list()
          .filter((machine) => machine.confirmedAt !== undefined)
          .map((machine) => machine.id);
      const unknownOf = (ids: ReadonlyArray<string>) =>
        Object.fromEntries(ids.map((id) => [id, UNKNOWN_MARKS(now())]));
      const keptMarks: MachineMarksByHost =
        marksStore === undefined
          ? {}
          : yield* Effect.try(() => marksStore.read()).pipe(
              Effect.tap(({ dropped }) =>
                dropped.length === 0
                  ? Effect.void
                  : Effect.logWarning(
                      "machines: some machines' records couldn't be read; they owe a resume",
                    ).pipe(Effect.annotateLogs({ dropped: dropped.length })),
              ),
              Effect.map((read) =>
                Object.fromEntries(
                  Object.entries({ ...read.machines, ...unknownOf(read.dropped) }).filter(
                    ([id]) => machines.get(HostId.make(id)) !== undefined,
                  ),
                ),
              ),
              Effect.catch((error) =>
                Effect.logError(
                  "machines: the machines' records couldn't be read; every machine owes a resume",
                ).pipe(
                  Effect.annotateLogs({ reason: String(error.cause) }),
                  Effect.andThen(Effect.sync(() => marksStore.quarantine?.())),
                  Effect.andThen(
                    Effect.sync(() => {
                      const unknown = unknownOf(confirmed());
                      try {
                        marksStore.write(unknown);
                      } catch (_readAsUnreadableAgainAtTheNextStartOwed) {}
                      return unknown;
                    }),
                  ),
                ),
              ),
            );
      const stops = makeStopMarks(
        now,
        undefined,
        () => changed(),
        undefined,
        marksStore === undefined
          ? undefined
          : {
              initial: keptMarks,
              save: (all) => marksStore.write(all),
              failed: (error) =>
                runFork(
                  Effect.logError("machines: the stop marks couldn't be kept").pipe(
                    Effect.annotateLogs({ reason: String(error) }),
                  ),
                ),
            },
      );
      stops.onReady(() => changed());
      const moveWithin = options.moveWithinMs ?? MOVE_WITHIN_MS;
      const moving = new Map<HostId, { readonly at: number; readonly withinMs: number }>();
      const moves: MachineMoves = {
        said: (id, withinMs) => {
          moving.set(id, { at: now(), withinMs: withinMs ?? moveWithin });
        },
        of: (id) => {
          const said = moving.get(id);
          if (said !== undefined && now() - said.at < said.withinMs) return said.withinMs;
          return stops.recently(id) ? moveWithin : undefined;
        },
      };
      let automaticMemory: boolean | undefined;
      const automaticStore: AutomaticStore = options.automatic ?? {
        read: () => automaticMemory,
        write: (on) => {
          automaticMemory = on;
        },
      };
      const automaticOn = () => {
        try {
          return automaticStore.read() !== false;
        } catch {
          return false;
        }
      };
      const updates = makeMachineUpdates({
        release: options.release,
        connection: (id) => {
          const live = online.get(id);
          return live === undefined || live.connection.gone() ? undefined : live.connection;
        },
        online: () => [...online.keys()],
        automatic: Effect.sync(automaticOn),
        now,
        fork: (effect) => {
          runFork(effect);
        },
      });
      yield* updates.sweep.pipe(
        Effect.catchCause(() => Effect.void),
        Effect.repeat(Schedule.spaced(options.retryMs ?? RETRY_MS)),
        Effect.forkIn(root),
      );
      const close = (id: HostId) => {
        const live = online.get(id);
        online.delete(id);
        live?.close();
        if (live !== undefined) changed();
      };
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          for (const id of online.keys()) close(id);
        }),
      );
      const generations = new Map<HostId, number>();
      const generationOf = (id: HostId) => generations.get(id) ?? 0;
      const pending = new Map<HostId, Set<() => void>>();
      const bump = (id: HostId) => {
        generations.set(id, generationOf(id) + 1);
        const ends = pending.get(id);
        pending.delete(id);
        for (const end of ends ?? []) end();
      };
      let kept: string | null | undefined;
      const stillAdmitted = ({ machine, origin, generation }: AdmittedDial) => {
        const current = machines.get(machine.id);
        return (
          generationOf(machine.id) === generation &&
          current?.confirmedAt !== undefined &&
          (current.via !== undefined
            ? origin === current.via
            : isProvisioned(current)
              ? options.provisionedOrigin !== undefined && origin === options.provisionedOrigin
              : origin !== options.provisionedOrigin && (kept === undefined || kept === origin))
        );
      };
      const attach = (dial: AdmittedDial, socket: Socket.Socket) =>
        Effect.gen(function* () {
          const { machine, origin } = dial;
          if (!stillAdmitted(dial)) return;
          const scope = yield* Scope.fork(root);
          let entry: Online | undefined;
          const ended = yield* Deferred.make<never, HostUnavailable>();
          let hello: HostHello | undefined;
          let over = false;
          const end = (message: string) => {
            over = true;
            Deferred.doneUnsafe(
              ended,
              Exit.fail(new HostUnavailable({ hostId: machine.id, message })),
            );
          };
          const lose = (message: string) => {
            if (!over && entry !== undefined && online.get(machine.id) === entry)
              machines.note(machine.id, { kind: "lost", at: now() });
            end(message);
          };
          const endPending = () => end("The machine was removed, or access to it moved.");
          const saying = pending.get(machine.id) ?? new Set<() => void>();
          pending.set(machine.id, saying.add(endPending));
          const cleanUp = Effect.suspend(() => {
            pending.get(machine.id)?.delete(endPending);
            if (entry !== undefined && online.get(machine.id) === entry) {
              online.delete(machine.id);
              changed();
            }
            return Scope.close(scope, Exit.void);
          });
          return yield* Effect.gen(function* () {
            const opened = yield* connectHost(
              watchedSocket(
                socket,
                Effect.sync(() => lose("The machine's connection closed.")),
              ),
              {
                hostId: machine.id,
                gone: Deferred.await(ended),
                onEnded: (reason) => Effect.sync(() => lose(reason)),
                ...(options.pingEveryMs === undefined ? {} : { pingEveryMs: options.pingEveryMs }),
                onHello: (said) => {
                  hello = said;
                },
              },
            ).pipe(Scope.provide(scope), Effect.exit);
            if (Exit.isFailure(opened)) {
              const mismatch =
                hello !== undefined && hello.hostId === machine.id
                  ? helloMismatch(hello)
                  : undefined;
              const release = hello === undefined ? undefined : releaseOf(hello);
              if (generationOf(machine.id) === dial.generation)
                machines.note(
                  machine.id,
                  hello !== undefined && mismatch !== undefined
                    ? {
                        kind: "mismatch",
                        at: now(),
                        protocol: hello.protocol,
                        ...(release === undefined ? {} : { release }),
                        ...(mismatch.kind === "capabilities" ? { missing: mismatch.missing } : {}),
                      }
                    : { kind: "no-hello", at: now() },
                );
              yield* Effect.logWarning(
                "machines: a joined machine dialled in but didn't connect",
              ).pipe(
                Effect.annotateLogs({
                  hostId: machine.id,
                  ...(mismatch === undefined
                    ? {}
                    : {
                        protocol: hello?.protocol,
                        release: release ?? "unknown",
                      }),
                }),
              );
              return;
            }
            if (!stillAdmitted(dial)) return;
            const said = opened.value.hello;
            if (said.diskId === undefined && stops.disk(machine.id) !== undefined) {
              yield* Effect.logWarning(
                "machines: refused a joined machine's host that didn't say its disk",
              ).pipe(Effect.annotateLogs({ hostId: machine.id, online: online.has(machine.id) }));
              return;
            }
            const arrived = yield* Effect.try({
              try: () => stops.arrive(machine.id, said),
              catch: (error) => error,
            }).pipe(Effect.option);
            if (arrived._tag === "None") {
              yield* Effect.logError(
                "machines: refused a joined machine's host, as its record couldn't be kept",
              ).pipe(Effect.annotateLogs({ hostId: machine.id }));
              return;
            }
            const disk = arrived.value;
            if (disk.kind === "fenced") {
              yield* Effect.logWarning(
                "machines: refused a joined machine's host on a disk it was replaced from",
              ).pipe(
                Effect.annotateLogs({
                  hostId: machine.id,
                  why: disk.why,
                  online: online.has(machine.id),
                }),
              );
              yield* Effect.flatMap(socket.writer, (writer) =>
                writer.write(new Socket.CloseEvent(HOST_FENCED_CLOSE, HOST_FENCED_REASON)),
              ).pipe(Effect.ignore, Effect.scoped);
              return;
            }
            pending.get(machine.id)?.delete(endPending);
            close(machine.id);
            const live: Online = {
              connection: opened.value,
              since: now(),
              origin,
              close: () => end("The machine was removed, or dialled in again."),
            };
            entry = live;
            online.set(machine.id, live);
            providerWords.delete(machine.id);
            moving.delete(machine.id);
            machines.note(machine.id, undefined);
            changed();
            yield* Effect.logInfo("machines: a joined machine is online").pipe(
              Effect.annotateLogs({
                hostId: machine.id,
                platform: opened.value.hello.platform,
                disk: disk.kind,
              }),
            );
            void checkSignIn(machine.id);
            runFork(updates.connected(machine.id, opened.value));
            const going = opened.value.stop.going;
            if (going !== undefined)
              runFork(
                Stream.runForEachWhile(going, ({ withinMs }) =>
                  Effect.logInfo("machines: a machine says it is about to be taken away").pipe(
                    Effect.tap(() => Effect.sync(() => moves.said(machine.id))),
                    Effect.annotateLogs({ hostId: machine.id, withinMs }),
                    Effect.andThen(
                      Effect.forEach([...goingReady], (ready) => ready(machine.id, withinMs), {
                        concurrency: "unbounded",
                        discard: true,
                      }),
                    ),
                    Effect.as(false),
                  ),
                ).pipe(Effect.ignore),
              );
            yield* Deferred.await(ended).pipe(Effect.ignore);
            if (online.get(machine.id) === live) stops.away(machine.id);
            yield* Effect.logInfo("machines: a joined machine went offline").pipe(
              Effect.annotateLogs({ hostId: machine.id }),
            );
          }).pipe(Effect.ensuring(cleanUp));
        });
      const checkSignIn = (id: HostId): Promise<HostStatus | undefined> => {
        const live = online.get(id);
        if (live === undefined || live.connection.gone()) return Promise.resolve(undefined);
        if (live.checking !== undefined) return live.checking;
        const check = live.connection.status ?? Effect.succeed(UNKNOWN_STATUS);
        const checking = runPromise(
          check.pipe(
            Effect.tap((status) =>
              Effect.sync(() => {
                live.status = { status, at: now() };
              }),
            ),
            Effect.tap((status) => {
              const missing = status.tools.filter((tool) => !tool.found).map((tool) => tool.tool);
              return status.claudeSignIn === "signedIn" && missing.length === 0
                ? Effect.void
                : Effect.logInfo("machines: a joined machine can't run every session").pipe(
                    Effect.annotateLogs({
                      hostId: id,
                      claudeSignIn: status.claudeSignIn,
                      missing: missing.join(","),
                    }),
                  );
            }),
          ),
        ).finally(() => {
          if (live.checking === checking) live.checking = undefined;
        });
        live.checking = checking;
        return checking;
      };
      const view = (machine: PairedMachine, tailscale: DialAccess | undefined) => {
        const live = online.get(machine.id);
        if (live !== undefined && (live.status?.at ?? 0) + SIGN_IN_FRESH_MS <= now())
          void checkSignIn(machine.id);
        return machineView(
          machine,
          live === undefined
            ? undefined
            : {
                since: live.since,
                status: live.status,
                release: releaseOf(live.connection.hello),
                selfUpdate: live.connection.update !== undefined,
              },
          {
            problem: machines.problemOf(machine.id),
            update: updates.stateOf(machine.id),
            ...(tailscale === undefined ? {} : { tailscale }),
          },
        );
      };
      return RemoteHosts.of({
        machines,
        connection: (id) =>
          Effect.suspend(() => {
            const live = online.get(id);
            return live === undefined || live.connection.gone()
              ? Effect.fail(
                  new HostUnavailable({ hostId: id, message: "That machine is offline." }),
                )
              : Effect.succeed(live.connection);
          }),
        origin: (id) => online.get(id)?.origin,
        list: (tailscale) => machines.list().map((machine) => view(machine, tailscale)),
        states: () =>
          machines
            .list()
            .filter((machine) => machine.confirmedAt !== undefined)
            .map((machine): MachineState => {
              const live = online.get(machine.id);
              const starting = stops.wantedSince(machine.id);
              const restoring = live !== undefined && stops.owes(machine.id);
              const stalled = restoring ? stops.stalled(machine.id) : undefined;
              const paused = live === undefined ? stops.stoppedAt(machine.id) : undefined;
              const provider = live === undefined ? providerWords.get(machine.id) : undefined;
              const { offline } = machineView(
                machine,
                live === undefined ? undefined : { since: live.since },
                {
                  problem: machines.problemOf(machine.id),
                  tailscale: (readAccess === undefined ? kept === null : readAccess() === "off")
                    ? "off"
                    : "on",
                },
              );
              return {
                id: machine.id,
                name: machine.name,
                kind: isProvisioned(machine) ? "provisioned" : "joined",
                ...(live === undefined ? {} : { onlineSince: live.since }),
                ...(offline === undefined ? {} : { offline }),
                ...(live !== undefined || starting === undefined ? {} : { starting }),
                ...(live !== undefined && restoring ? { restoring: live.since } : {}),
                ...(stalled === undefined ? {} : { stalled }),
                ...(paused === undefined ? {} : { paused }),
                ...(provider === undefined ? {} : { provider }),
                ...hostedOf(machine, logos),
              };
            }),
        hostedLogo: (origin, logo) => {
          if (logos.get(origin) === logo) return;
          if (logo === undefined) logos.delete(origin);
          else logos.set(origin, logo);
          changed();
        },
        providerSaid: (id, word) => {
          if (sameWord(word, providerWords.get(id))) return;
          if (word === undefined) providerWords.delete(id);
          else providerWords.set(id, word);
          changed();
        },
        watch: (listener) => {
          watchers.add(listener);
          return () => {
            watchers.delete(listener);
          };
        },
        onGoing: (ready) => {
          goingReady.add(ready);
          return () => {
            goingReady.delete(ready);
          };
        },
        accessFrom: (read) => {
          readAccess = read;
          changed();
        },
        provisionedOrigin: options.provisionedOrigin,
        closeProvisioned: () => {
          for (const machine of machines.list()) {
            if (!isProvisioned(machine) || machine.via !== undefined) continue;
            if (online.has(machine.id)) machines.note(machine.id, { kind: "lost", at: now() });
            bump(machine.id);
            close(machine.id);
          }
        },
        admit: (machine, origin) => ({ machine, origin, generation: generationOf(machine.id) }),
        attach,
        checkSignIn,
        update: updates.request,
        automaticUpdates: automaticOn,
        setAutomaticUpdates: (on) => automaticStore.write(on),
        stops,
        moves,
        remove: (id) => {
          bump(id);
          updates.forget(id);
          try {
            const removed = machines.remove(id);
            stops.forget(id);
            providerWords.delete(id);
            return removed;
          } finally {
            close(id);
          }
        },
        keepOrigin: (origin) => {
          kept = origin ?? null;
          for (const machine of machines.list()) {
            if (isProvisioned(machine)) continue;
            const live = online.get(machine.id);
            if (live !== undefined && live.origin === origin) continue;
            if (live !== undefined)
              machines.note(machine.id, {
                kind: origin === undefined ? "lost" : "moved",
                at: now(),
              });
            bump(machine.id);
            close(machine.id);
          }
          changed();
        },
      });
    });

  /** The machines kept in the server's data folder. */
  static readonly layer: Layer.Layer<RemoteHosts, never, ServerConfig> = Layer.effect(
    RemoteHosts,
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const { dataDir } = config;
      return yield* RemoteHosts.make(
        lazyFileStore(dataDir, "machines.json", fileMachineStore, () => [], [
          "provisioned-hosts.json",
        ]),
        Date.now,
        {
          ...lazyFileStore(dataDir, "dial-nonces.json", fileNonceStore, () => NO_DIALS),
          lastSeen: () => dialNoncesLastSeen(dataDir),
        },
        {
          release: releaseOfConfig(config),
          automatic: fileAutomaticStore(dataDir),
          provisionedOrigin: config.provisionedHosts?.origin,
          ...(config.machineMoveWithin === undefined
            ? {}
            : { moveWithinMs: Duration.toMillis(config.machineMoveWithin) }),
          marks: lazyFileStore(dataDir, "machine-marks.json", fileMarksStore, () => ({
            machines: {},
            dropped: [],
          })),
        },
      );
    }),
  );
}
