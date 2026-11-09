import { existsSync } from "node:fs";
import { join } from "node:path";
import { HostUnavailable, type HostId } from "@gram/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { ServerConfig } from "../config.ts";
import type { Socket } from "../platform/unstable.ts";
import {
  createPairedMachines,
  type DialNonceStore,
  fileMachineStore,
  fileNonceStore,
  machineView,
  type PairedMachine,
  type PairedMachines,
  type PairedMachineStore,
} from "./paired-machines.ts";
import { connectHost, type HostConnection } from "./protocol.ts";
import { watchedSocket } from "./socket-end.ts";

/** A joined machine's host while it is dialled in. */
interface Online {
  readonly connection: HostConnection;
  readonly since: number;
  /** The tailnet address it dialled, which stops being valid when access is turned off. */
  readonly origin: string;
  /** Ends the connection: its socket closes and its calls fail. */
  readonly close: () => void;
}

/** A store, made on first write: a Gram no machine joined never makes the file or its folder. */
const lazyFileStore = <R, W>(
  dataDir: string,
  name: string,
  make: (dataDir: string) => { readonly read: () => R; readonly write: (value: W) => void },
  empty: () => R,
) => {
  let store: ReturnType<typeof make> | undefined;
  const real = () => (store ??= make(dataDir));
  return {
    read: (): R =>
      store === undefined && !existsSync(join(dataDir, "remote-access", name))
        ? empty()
        : real().read(),
    write: (value: W) => real().write(value),
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
  /** The joined machines as the settings page lists them. */
  readonly list: () => ReadonlyArray<ReturnType<typeof machineView>>;
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
  /** Forgets the machine and closes its connection; false when it wasn't joined. */
  readonly remove: (id: HostId) => boolean;
  /**
   * Closes every connection that didn't dial `origin`, and any still saying hello: all of them
   * when access over Tailscale is off (`undefined`). The machines stay joined.
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
  ) =>
    Effect.gen(function* () {
      const machines = createPairedMachines(store, now, nonces);
      const online = new Map<HostId, Online>();
      const root = yield* Effect.scope;
      const close = (id: HostId) => {
        const live = online.get(id);
        online.delete(id);
        live?.close();
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
      const stillAdmitted = ({ machine, origin, generation }: AdmittedDial) =>
        generationOf(machine.id) === generation &&
        (kept === undefined || kept === origin) &&
        machines.get(machine.id)?.confirmedAt !== undefined;
      const attach = (dial: AdmittedDial, socket: Socket.Socket) =>
        Effect.gen(function* () {
          const { machine, origin } = dial;
          // Access turned off or moved, or the machine removed, while the dial was upgraded.
          if (!stillAdmitted(dial)) return;
          const scope = yield* Scope.fork(root);
          let entry: Online | undefined;
          const ended = yield* Deferred.make<never, HostUnavailable>();
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
            if (entry !== undefined && online.get(machine.id) === entry) online.delete(machine.id);
            return Scope.close(scope, Exit.void);
          });
          return yield* Effect.gen(function* () {
            const opened = yield* connectHost(
              watchedSocket(
                socket,
                Effect.sync(() => end("The machine's connection closed.")),
              ),
              { hostId: machine.id, gone: Deferred.await(ended) },
            ).pipe(Scope.provide(scope), Effect.exit);
            if (Exit.isFailure(opened)) {
              yield* Effect.logWarning(
                "machines: a joined machine dialled in but didn't connect",
              ).pipe(Effect.annotateLogs({ hostId: machine.id }));
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
            yield* Effect.logInfo("machines: a joined machine is online").pipe(
              Effect.annotateLogs({ hostId: machine.id, platform: opened.value.hello.platform }),
            );
            yield* Deferred.await(ended).pipe(Effect.ignore);
            yield* Effect.logInfo("machines: a joined machine went offline").pipe(
              Effect.annotateLogs({ hostId: machine.id }),
            );
          }).pipe(Effect.ensuring(cleanUp));
        });
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
        list: () => machines.list().map((machine) => machineView(machine, online.get(machine.id))),
        admit: (machine, origin) => ({ machine, origin, generation: generationOf(machine.id) }),
        attach,
        remove: (id) => {
          bump(id);
          try {
            return machines.remove(id);
          } finally {
            close(id);
          }
        },
        keepOrigin: (origin) => {
          kept = origin ?? null;
          for (const machine of machines.list()) {
            const live = online.get(machine.id);
            if (live !== undefined && live.origin === origin) continue;
            bump(machine.id);
            close(machine.id);
          }
        },
      });
    });

  /** The machines kept in the server's data folder. */
  static readonly layer: Layer.Layer<RemoteHosts, never, ServerConfig> = Layer.effect(
    RemoteHosts,
    Effect.gen(function* () {
      const { dataDir } = yield* ServerConfig;
      return yield* RemoteHosts.make(
        lazyFileStore(dataDir, "machines.json", fileMachineStore, () => []),
        Date.now,
        lazyFileStore(dataDir, "dial-nonces.json", fileNonceStore, () => ({
          nonces: [],
          floor: 0,
        })),
      );
    }),
  );
}
