import { copyFileSync, existsSync, lstatSync } from "node:fs";
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
import * as Stream from "effect/Stream";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { ServerConfig } from "../config.ts";
import { privateJsonFile } from "../http/remote-sessions.ts";
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
import * as FiberSet from "effect/FiberSet";
import { watchedSocket } from "./socket-end.ts";
import * as Schema from "effect/Schema";
import {
  MachineMarks,
  type MachineMarksByHost,
  makeStopMarks,
  type StopMarks,
  UNKNOWN_MARKS,
} from "./stop-marks.ts";
import { releaseOf, releaseOfConfig } from "./releases.ts";

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

/** The machines' stop marks and disks (`stop-marks.ts`), as kept across a restart. */
export interface MarksStore {
  /**
   * Every machine's marks, and how many machines' marks were left out for not reading as marks;
   * throws when what is kept can't be read at all.
   */
  readonly read: () => {
    readonly machines: MachineMarksByHost;
    readonly dropped: ReadonlyArray<string>;
  };
  /** Keeps a copy of what can't be read aside, for a person to look at. */
  readonly quarantine?: () => void;
  /** Throws when they couldn't be kept. */
  readonly write: (all: MachineMarksByHost) => void;
}

/** The largest marks file read: a few machines' folders, never their diffs. */
const MARKS_MAX_BYTES = 4 * 1024 * 1024;

/**
 * The marks in `remote-access/machine-marks.json`, owner-only beside the machines, each write a
 * whole new file renamed over the old (`privateJsonFile`). A machine whose marks don't read as
 * marks is left out, so one bad entry costs only its own; a file that isn't marks at all throws.
 * A write that would come to more than is read back leaves out what stops kept of folders, which
 * only holds a resume to a commit, before the disks and what is owed; past that it throws.
 */
export const fileMarksStore = (dataDir: string): MarksStore => {
  const file = privateJsonFile(dataDir, "machine-marks.json", MARKS_MAX_BYTES);
  const decode = Schema.decodeUnknownOption(MachineMarks);
  const fits = (value: unknown) =>
    Buffer.byteLength(JSON.stringify(value), "utf8") <= MARKS_MAX_BYTES;
  return {
    read: () => {
      const value = file.read() as { version?: unknown; machines?: unknown } | undefined;
      if (value === undefined) return { machines: {}, dropped: [] };
      if (
        value === null ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        value.version !== 1 ||
        typeof value.machines !== "object" ||
        value.machines === null ||
        Array.isArray(value.machines)
      )
        throw new Error("machine-marks.json isn't a machine marks file.");
      const machines: Record<string, MachineMarks> = {};
      const dropped: Array<string> = [];
      for (const [id, marks] of Object.entries(value.machines)) {
        const decoded = decode(marks);
        if (decoded._tag === "Some") machines[id] = decoded.value;
        else dropped.push(id);
      }
      return { machines, dropped };
    },
    quarantine: () => {
      const path = join(dataDir, "remote-access", "machine-marks.json");
      try {
        copyFileSync(path, `${path}.unreadable-${Date.now()}`);
      } catch {
        // Nothing to move, or it couldn't be: the next write replaces it.
      }
    },
    write: (all) => {
      const whole = { version: 1, machines: all };
      if (fits(whole)) return file.write(whole);
      // What only helps goes first: what stops kept (a resume then takes the remote's ref as it
      // is), the threads to reopen, and those already back (which then wait for the resume). The
      // disks, what is owed and the threads blocked are never left out.
      const lean = {
        version: 1,
        machines: Object.fromEntries(
          Object.entries(all).map(([id, marks]) => {
            const { kept: _, rested: __, back: ___, ...rest } = marks;
            return [id, rest];
          }),
        ),
      };
      if (!fits(lean)) throw new Error("The machines' marks don't fit in machine-marks.json.");
      file.write(lean);
    },
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
      /** How often its connections ping their hosts; `HOST_PING_EVERY_MS` unless a test says. */
      readonly pingEveryMs?: number;
      /** Where the stop marks and disks are kept across a restart; in memory when left out. */
      readonly marks?: MarksStore;
    } = {},
  ) =>
    Effect.gen(function* () {
      /** Told when `states` may have changed; one that throws doesn't stop the others. */
      const watchers = new Set<() => void>();
      /** What runs when a machine says it is about to be taken away (`onGoing`). */
      const goingReady = new Set<(id: HostId, withinMs: number) => Effect.Effect<void>>();
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
      const root = yield* Effect.scope;
      // The server's own logger and the rest, for a check started outside an effect.
      const context = yield* Effect.context<never>();
      const runPromise = Effect.runPromiseWith(context);
      /** Updates and their checks, which outlive the dial or request that started them. */
      const runFork = yield* FiberSet.makeRuntime<never>();
      // What was kept of the machines' stops and disks. A machine whose record can't be read,
      // or every machine when the file can't be, is owed a resume: its sessions wait for one
      // rather than open over folders nobody can say are there. Never a reason not to start.
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
              // A machine removed since (its record outlived it in a crash) starts over if it joins.
              Effect.map((read) =>
                Object.fromEntries(
                  Object.entries({ ...read.machines, ...unknownOf(read.dropped) }).filter(
                    ([id]) => machines.get(id as HostId) !== undefined,
                  ),
                ),
              ),
              Effect.catch((error) =>
                Effect.logError(
                  "machines: the machines' records couldn't be read; every machine owes a resume",
                ).pipe(
                  Effect.annotateLogs({ reason: String(error.cause) }),
                  Effect.andThen(Effect.sync(() => marksStore.quarantine?.())),
                  // Written over what couldn't be read at once: a restart before any other write
                  // finds every machine owed again, never an empty record. Not written, the file
                  // stays unreadable, and the next start finds the same.
                  Effect.andThen(
                    Effect.sync(() => {
                      const unknown = unknownOf(confirmed());
                      try {
                        marksStore.write(unknown);
                      } catch {
                        // Read as unreadable again at the next start: owed again.
                      }
                      return unknown;
                    }),
                  ),
                ),
              ),
            );
      // A machine waited on or no longer is news to the threads that run on it (`starting`).
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
              // What only adds caution holds in memory meanwhile and is written at the next change;
              // what lifts a debt, or admits a host, didn't happen (`MarksNotKept`).
              failed: (error) =>
                runFork(
                  Effect.logError("machines: the stop marks couldn't be kept").pipe(
                    Effect.annotateLogs({ reason: String(error) }),
                  ),
                ),
            },
      );
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
          // A relayed host on the hosted server it came through, and nowhere else.
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
          // Access turned off or moved, or the machine removed, while the dial was upgraded.
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
          /**
           * Its connection went while online (its socket closed, its stream broke, or it stopped
           * answering pings): noted as lost once, however it was found. One replaced or removed
           * has left `online` first, so isn't.
           */
          const lose = (message: string) => {
            if (!over && entry !== undefined && online.get(machine.id) === entry)
              machines.note(machine.id, { kind: "lost", at: now() });
            end(message);
          };
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
                Effect.sync(() => lose("The machine's connection closed.")),
              ),
              {
                hostId: machine.id,
                gone: Deferred.await(ended),
                // A host that stopped answering, or whose stream broke, goes offline now: left
                // online it looked connected while every call to it failed, until it dialled again.
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
            // Removed, or its connections closed, while it said hello: it doesn't come online.
            if (!stillAdmitted(dial)) return;
            // Once a host of the machine has said its disk, one that says none is refused: it
            // can't say it isn't an old disk's host. A machine none of whose hosts ever said one
            // comes online as before; removing the machine and joining it again starts over.
            const said = opened.value.hello;
            if (said.diskId === undefined && stops.disk(machine.id) !== undefined) {
              yield* Effect.logWarning(
                "machines: refused a joined machine's host that didn't say its disk",
              ).pipe(Effect.annotateLogs({ hostId: machine.id, online: online.has(machine.id) }));
              return;
            }
            // The disk it says it is on: the same, or another, which owes a resume before any
            // session opens there, written as one change with the disk before the host comes
            // online. A record that can't be written keeps it out: it dials again.
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
            // A disk the machine was replaced from, or the one it leaves while told it comes back
            // on another: an old host, cut off, that dialled in again with the machine's key. It
            // isn't the machine any more, so it is refused whatever is online, and the machine
            // that replaced it stays. The old host's own grace ends what it kept for the machine,
            // and the close says how a person makes that disk the machine again: its host says a
            // disk this Gram hasn't seen (`gram-host new-disk`), which owes a resume like any.
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
            // How its last update went, which also confirms one that brought it back, then
            // whether it updates now.
            runFork(updates.connected(machine.id, opened.value));
            // Listened to while it is online, and let go of once it was readied to stop as it said
            // it goes: the host holds its exit until then.
            const going = opened.value.stop.going;
            if (going !== undefined)
              runFork(
                Stream.runForEachWhile(going, ({ withinMs }) =>
                  Effect.logInfo("machines: a machine says it is about to be taken away").pipe(
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
              const starting = stops.wantedSince(machine.id);
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
                ...(machine.via === undefined || machine.hosted === undefined
                  ? {}
                  : { hosted: machine.hosted }),
              };
            }),
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
            // A relayed host dials through a hosted server, not the provisioned-host listener.
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
        remove: (id) => {
          bump(id);
          updates.forget(id);
          try {
            // Its registration goes first, and its record only once that is written. A removal
            // whose write fails still takes the machine out of this process, as before, but leaves
            // its record: the restart that finds it joined again finds its disk and debt with it.
            // A crash between the two leaves the record of a machine that isn't joined, dropped
            // at the next start.
            const removed = machines.remove(id);
            stops.forget(id);
            return removed;
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
          marks: lazyFileStore(dataDir, "machine-marks.json", fileMarksStore, () => ({
            machines: {},
            dropped: [],
          })),
        },
      );
    }),
  );
}
