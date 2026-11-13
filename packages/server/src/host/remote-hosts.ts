import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import {
  type HostHello,
  HostUnavailable,
  type HostId,
  type HostStatus,
  type MachineState,
} from "@gram/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { ServerConfig } from "../config.ts";
import { privateJsonFile } from "../http/remote-sessions.ts";
import type { Socket } from "../platform/unstable.ts";
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
import { connectHost, type HostConnection, helloMismatch, UNKNOWN_STATUS } from "./protocol.ts";
import { makeMachineUpdates, RETRY_MS, type UpdateRequest } from "./machine-updates.ts";
import * as Schedule from "effect/Schedule";
import * as FiberSet from "effect/FiberSet";
import { watchedSocket } from "./socket-end.ts";
import { makeStopMarks, type StopMarks } from "./stop-marks.ts";

/** The release a host said it runs, kept only when it reads as a release: it is shown as text. */
const releaseOf = (hello: HostHello): string | undefined =>
  hello.release !== undefined &&
  /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[0-9A-Za-z.]{1,32})?$/.test(hello.release)
    ? hello.release
    : undefined;

/**
 * This Gram's release, which the installer downloads and machines update to: its version, only when
 * it was built as a release (its build is a commit); undefined when it runs from source.
 */
export const releaseOfConfig = (config: {
  readonly appVersion?: string | undefined;
  readonly appBuild?: string | undefined;
}): string | undefined =>
  config.appBuild !== undefined && /^[a-f0-9]{40}$/.test(config.appBuild)
    ? config.appVersion
    : undefined;

/** A joined machine's host while it is dialled in. */
interface Online {
  readonly connection: HostConnection;
  readonly since: number;
  /** The tailnet address it dialled, which stops being valid when access is turned off. */
  readonly origin: string;
  /** Ends the connection: its socket closes and its calls fail. */
  readonly close: () => void;
  /** What it can run (its Claude sign-in, its tools) as last checked here, and when. */
  status?: { readonly status: HostStatus; readonly at: number };
  /** A check running now, so a burst of listings starts one. */
  checking?: Promise<HostStatus | undefined> | undefined;
}

/** How old a status check may be before a listing asks the machine again. */
export const SIGN_IN_FRESH_MS = 60_000;

/** A store, made on first write: a Gram no machine joined never makes the file or its folder. */
const lazyFileStore = <R, W>(
  dataDir: string,
  name: string,
  make: (dataDir: string) => { readonly read: () => R; readonly write: (value: W) => void },
  empty: () => R,
  /** Other files the store keeps, any of which being there means it was made. */
  beside: ReadonlyArray<string> = [],
) => {
  let store: ReturnType<typeof make> | undefined;
  const real = () => (store ??= make(dataDir));
  return {
    read: (): R =>
      store === undefined &&
      ![name, ...beside].some((file) => existsSync(join(dataDir, "remote-access", file)))
        ? empty()
        : real().read(),
    write: (value: W) => real().write(value),
  };
};

/** The automatic-updates switch, as kept: undefined until it is first set. */
export interface AutomaticStore {
  readonly read: () => boolean | undefined;
  readonly write: (on: boolean) => void;
}

/**
 * The switch in `remote-access/machine-updates.json`, owner-only like the machines beside it. Only
 * a file that is genuinely not there reads as never set (on): anything else that stops it being
 * read (a folder it can't look into, a link, a file not its own or not a switch) throws, and
 * `automaticUpdates` reads that as off. Never `existsSync`, which says "absent" for all of those.
 */
export const fileAutomaticStore = (dataDir: string): AutomaticStore => {
  const name = "machine-updates.json";
  const file = () => privateJsonFile(dataDir, name, 1024);
  return {
    read: () => {
      // Each step without following a link: the folder, then the file in it.
      for (const [path, folder] of [
        [join(dataDir, "remote-access"), true],
        [join(dataDir, "remote-access", name), false],
      ] as const) {
        let stat;
        try {
          stat = lstatSync(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
          throw error;
        }
        if (folder ? !stat.isDirectory() : !stat.isFile())
          throw new Error(`${path} isn't a ${folder ? "folder" : "file"} of its own.`);
      }
      const value = file().read() as { version?: unknown; automatic?: unknown } | undefined;
      if (value === undefined) throw new Error(`${name} went away while it was read.`);
      if (value.version !== 1 || typeof value.automatic !== "boolean")
        throw new Error(`${name} isn't a machine updates file.`);
      return value.automatic;
    },
    write: (on) => file().write({ version: 1, automatic: on }),
  };
};

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

/** The other machines joined to this Gram, and the connections of those dialled in. */
export class RemoteHosts extends Context.Service<RemoteHosts, RemoteHostsShape>()(
  "@gram/server/RemoteHosts",
) {
  static readonly make = (
    store: PairedMachineStore,
    now: () => number = Date.now,
    nonces?: DialNonceStore,
    /** This Gram's release, which machines update to; undefined when it runs from source. */
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
    } = {},
  ) =>
    Effect.gen(function* () {
      /** Told when `states` may have changed; one that throws doesn't stop the others. */
      const watchers = new Set<() => void>();
      const changed = () => {
        for (const watcher of watchers) {
          try {
            watcher();
          } catch {
            // A watcher's failure is its own.
          }
        }
      };
      const machines = createPairedMachines(store, now, nonces, changed);
      const online = new Map<HostId, Online>();
      let readAccess: (() => DialAccess) | undefined;
      const stops = makeStopMarks(now);
      const root = yield* Effect.scope;
      // The server's own logger and the rest, for a check started outside an effect.
      const context = yield* Effect.context<never>();
      const runPromise = Effect.runPromiseWith(context);
      /** Updates and their checks, which outlive the dial or request that started them. */
      const runFork = yield* FiberSet.makeRuntime<never>();
      let automaticMemory: boolean | undefined;
      const automaticStore: AutomaticStore = options.automatic ?? {
        read: () => automaticMemory,
        write: (on) => {
          automaticMemory = on;
        },
      };
      /** On unless turned off; a switch it can't read counts as off, so nothing installs unasked. */
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
      /**
       * Each machine's generation, bumped when it is removed or its connections are closed, so a
       * dial still saying hello when that happens is dropped rather than put online after it.
       */
      const generations = new Map<HostId, number>();
      const generationOf = (id: HostId) => generations.get(id) ?? 0;
      /** Each machine's dials still saying hello, ended when its generation is bumped. */
      const pending = new Map<HostId, Set<() => void>>();
      const bump = (id: HostId) => {
        generations.set(id, generationOf(id) + 1);
        const ends = pending.get(id);
        pending.delete(id);
        for (const end of ends ?? []) end();
      };
      /**
       * The address access was last kept on (`null` when it was turned off), so a dial admitted
       * over another address never comes online; undefined until access is first kept or moved.
       */
      let kept: string | null | undefined;
      /** Whether the access a dial was admitted under still holds. */
      const stillAdmitted = ({ machine, origin, generation }: AdmittedDial) => {
        const current = machines.get(machine.id);
        return (
          generationOf(machine.id) === generation &&
          current?.confirmedAt !== undefined &&
          // A provisioned host on its own listener's address, whatever access over Tailscale is;
          // a joined machine on the address that access is kept on.
          (isProvisioned(current)
            ? options.provisionedOrigin !== undefined && origin === options.provisionedOrigin
            : origin !== options.provisionedOrigin && (kept === undefined || kept === origin))
        );
      };
      const attach = (dial: AdmittedDial, socket: Socket.Socket) =>
        Effect.gen(function* () {
          const { machine, origin } = dial;
          // Access turned off or moved, or the machine removed, while the dial was upgraded.
          if (!stillAdmitted(dial)) return;
          const scope = yield* Scope.fork(root);
          let entry: Online | undefined;
          const ended = yield* Deferred.make<never, HostUnavailable>();
          let hello: HostHello | undefined;
          const end = (message: string) =>
            Deferred.doneUnsafe(
              ended,
              Exit.fail(new HostUnavailable({ hostId: machine.id, message })),
            );
          // Ended while it says hello when the machine is removed or access is turned off or moved.
          const endPending = () => end("The machine was removed, or access to it moved.");
          const saying = pending.get(machine.id) ?? new Set<() => void>();
          pending.set(machine.id, saying.add(endPending));
          // Whichever way the dial ends (its socket closed, it was replaced or removed, or the
          // request was interrupted), its entry and scope go with it.
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
                Effect.sync(() => {
                  // Only a connection that was online is lost; one replaced or removed isn't.
                  if (entry !== undefined && online.get(machine.id) === entry)
                    machines.note(machine.id, { kind: "lost", at: now() });
                  end("The machine's connection closed.");
                }),
              ),
              {
                hostId: machine.id,
                gone: Deferred.await(ended),
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
            // Removed, or its connections closed, while it said hello: it doesn't come online.
            if (!stillAdmitted(dial)) return;
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
            stops.back(machine.id);
            machines.note(machine.id, undefined);
            changed();
            yield* Effect.logInfo("machines: a joined machine is online").pipe(
              Effect.annotateLogs({ hostId: machine.id, platform: opened.value.hello.platform }),
            );
            void checkSignIn(machine.id);
            // How its last update went, which also confirms one that brought it back, then
            // whether it updates now.
            runFork(updates.connected(machine.id, opened.value));
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
      /** The listing's view of each machine, asking again about any sign-in gone stale. */
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
              };
            }),
        watch: (listener) => {
          watchers.add(listener);
          return () => {
            watchers.delete(listener);
          };
        },
        accessFrom: (read) => {
          readAccess = read;
          changed();
        },
        provisionedOrigin: options.provisionedOrigin,
        closeProvisioned: () => {
          for (const machine of machines.list()) {
            if (!isProvisioned(machine)) continue;
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
        remove: (id) => {
          bump(id);
          updates.forget(id);
          stops.forget(id);
          try {
            return machines.remove(id);
          } finally {
            close(id);
          }
        },
        keepOrigin: (origin) => {
          kept = origin ?? null;
          for (const machine of machines.list()) {
            // Its listener isn't the tailnet's: access turned off or moved leaves it connected.
            if (isProvisioned(machine)) continue;
            const live = online.get(machine.id);
            if (live !== undefined && live.origin === origin) continue;
            // Onto another address, which it doesn't dial. Turned off, the list says so itself, and
            // once it is back on, this connection was lost then.
            if (live !== undefined)
              machines.note(machine.id, {
                kind: origin === undefined ? "lost" : "moved",
                at: now(),
              });
            bump(machine.id);
            close(machine.id);
          }
          // Access turned off, on or moved: an offline machine's reason follows it.
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
        },
      );
    }),
  );
}
