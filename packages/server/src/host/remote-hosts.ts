import { existsSync } from "node:fs";
import { join } from "node:path";
import { type ClaudeSignIn, HostUnavailable, type HostId } from "@gram/contracts";
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
  /** Its Claude Code sign-in as last checked over this connection, and when. */
  signIn?: { readonly state: ClaudeSignIn; readonly at: number };
  /** A check running now, so a burst of listings starts one. */
  checking?: Promise<ClaudeSignIn | undefined> | undefined;
}

/** How old a sign-in check may be before a listing asks the machine again. */
export const SIGN_IN_FRESH_MS = 60_000;

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
  /** The tailnet address the machine dialled, while it is online: where it reaches this Gram. */
  readonly origin: (id: HostId) => string | undefined;
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
  /**
   * Asks the machine for its Claude Code sign-in now and keeps the answer for the listing:
   * `undefined` while it is offline. A check already running is shared.
   */
  readonly checkSignIn: (id: HostId) => Promise<ClaudeSignIn | undefined>;
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
      // The server's own logger and the rest, for a check started outside an effect.
      const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
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
            void checkSignIn(machine.id);
            yield* Deferred.await(ended).pipe(Effect.ignore);
            yield* Effect.logInfo("machines: a joined machine went offline").pipe(
              Effect.annotateLogs({ hostId: machine.id }),
            );
          }).pipe(Effect.ensuring(cleanUp));
        });
      const checkSignIn = (id: HostId): Promise<ClaudeSignIn | undefined> => {
        const live = online.get(id);
        if (live === undefined || live.connection.gone()) return Promise.resolve(undefined);
        if (live.checking !== undefined) return live.checking;
        const check = live.connection.claudeSignIn ?? Effect.succeed("unknown" as const);
        const checking = runPromise(
          check.pipe(
            Effect.tap((state) =>
              Effect.sync(() => {
                live.signIn = { state, at: now() };
              }),
            ),
            Effect.tap((state) =>
              state === "signedIn"
                ? Effect.void
                : Effect.logInfo(
                    "machines: a joined machine's Claude Code can't start sessions",
                  ).pipe(Effect.annotateLogs({ hostId: id, claudeSignIn: state })),
            ),
          ),
        ).finally(() => {
          if (live.checking === checking) live.checking = undefined;
        });
        live.checking = checking;
        return checking;
      };
      /** The listing's view of each machine, asking again about any sign-in gone stale. */
      const view = (machine: PairedMachine) => {
        const live = online.get(machine.id);
        if (live !== undefined && (live.signIn?.at ?? 0) + SIGN_IN_FRESH_MS <= now())
          void checkSignIn(machine.id);
        return machineView(machine, live);
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
        list: () => machines.list().map(view),
        attach,
        checkSignIn,
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
