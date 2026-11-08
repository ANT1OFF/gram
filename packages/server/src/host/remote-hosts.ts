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
  fileMachineStore,
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

/** The store, made on first write: a Gram no machine joined never makes the file or its folder. */
const lazyFileStore = (dataDir: string): PairedMachineStore => {
  let store: PairedMachineStore | undefined;
  const real = () => (store ??= fileMachineStore(dataDir));
  return {
    read: () =>
      store === undefined && !existsSync(join(dataDir, "remote-access", "machines.json"))
        ? []
        : real().read(),
    write: (machines) => real().write(machines),
  };
};

export interface RemoteHostsShape {
  readonly machines: PairedMachines;
  /** The machine's host, when it is joined, confirmed and dialled in now. */
  readonly connection: (id: HostId) => Effect.Effect<HostConnection, HostUnavailable>;
  /** The joined machines as the settings page lists them. */
  readonly list: () => ReadonlyArray<ReturnType<typeof machineView>>;
  /**
   * Serves a dial from `machine` that the auth middleware let through, until its socket closes or
   * the machine is removed. A second dial from the same machine replaces the first.
   */
  readonly attach: (
    machine: PairedMachine,
    socket: Socket.Socket,
    origin: string,
  ) => Effect.Effect<void>;
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
  static readonly make = (store: PairedMachineStore, now: () => number = Date.now) =>
    Effect.gen(function* () {
      const machines = createPairedMachines(store, now);
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
      const bump = (id: HostId) => generations.set(id, generationOf(id) + 1);
      const attach = (machine: PairedMachine, socket: Socket.Socket, origin: string) =>
        Effect.gen(function* () {
          const generation = generationOf(machine.id);
          const scope = yield* Scope.fork(root);
          let entry: Online | undefined;
          const ended = yield* Deferred.make<never, HostUnavailable>();
          const end = (message: string) =>
            Deferred.doneUnsafe(
              ended,
              Exit.fail(new HostUnavailable({ hostId: machine.id, message })),
            );
          // Whichever way the dial ends (its socket closed, it was replaced or removed, or the
          // request was interrupted), its entry and scope go with it.
          const cleanUp = Effect.suspend(() => {
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
            if (
              generationOf(machine.id) !== generation ||
              machines.get(machine.id)?.confirmedAt === undefined
            )
              return;
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
        list: () => machines.list().map((machine) => machineView(machine, online.get(machine.id))),
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
      return yield* RemoteHosts.make(lazyFileStore(dataDir));
    }),
  );
}
