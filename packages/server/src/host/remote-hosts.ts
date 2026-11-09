import { existsSync } from "node:fs";
import { join } from "node:path";
import { type HostHello, HostUnavailable, type HostId, type HostStatus } from "@gram/contracts";
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
import { connectHost, type HostConnection, helloMismatch, UNKNOWN_STATUS } from "./protocol.ts";
import { makeMachineUpdates, RETRY_MS, type UpdateRequest } from "./machine-updates.ts";
import * as Schedule from "effect/Schedule";
import * as FiberSet from "effect/FiberSet";
import { watchedSocket } from "./socket-end.ts";

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
  /**
   * The joined machines as the settings page lists them, each offline one with why: `tailscale`
   * false says access over Tailscale is off, so none of them can dial.
   */
  readonly list: (tailscale?: boolean) => ReadonlyArray<ReturnType<typeof machineView>>;
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
   * Asks the machine what it can run now (its Claude sign-in, its tools) and keeps the answer for
   * the listing: `undefined` while it is offline. A check already running is shared.
   */
  readonly checkSignIn: (id: HostId) => Promise<HostStatus | undefined>;
  /**
   * Updates the machine to this Gram's release over its own connection, now or once it is idle;
   * `fallback` for a host too old to update itself, which the installer updates.
   */
  readonly update: (id: HostId) => UpdateRequest;
  /** Reads whether joined machines update on their own (`updates.machines`); on until set. */
  readonly automaticUpdates: (automatic: Effect.Effect<boolean>) => void;
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
    /** This Gram's release, which machines update to; undefined when it runs from source. */
    options: { readonly release?: string | undefined; readonly retryMs?: number } = {},
  ) =>
    Effect.gen(function* () {
      const machines = createPairedMachines(store, now);
      const online = new Map<HostId, Online>();
      const root = yield* Effect.scope;
      // The server's own logger and the rest, for a check started outside an effect.
      const context = yield* Effect.context<never>();
      const runPromise = Effect.runPromiseWith(context);
      /** Updates and their checks, which outlive the dial or request that started them. */
      const runFork = yield* FiberSet.makeRuntime<never>();
      let automatic: Effect.Effect<boolean> = Effect.succeed(true);
      const updates = makeMachineUpdates({
        release: options.release,
        connection: (id) => {
          const live = online.get(id);
          return live === undefined || live.connection.gone() ? undefined : live.connection;
        },
        online: () => [...online.keys()],
        automatic: Effect.suspend(() => automatic).pipe(Effect.orElseSucceed(() => true)),
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
          let hello: HostHello | undefined;
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
              if (generationOf(machine.id) === generation)
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
            machines.note(machine.id, undefined);
            yield* Effect.logInfo("machines: a joined machine is online").pipe(
              Effect.annotateLogs({ hostId: machine.id, platform: opened.value.hello.platform }),
            );
            void checkSignIn(machine.id);
            // How its last update went, which also confirms one that brought it back, then
            // whether it updates now.
            runFork(updates.connected(machine.id, opened.value));
            yield* Deferred.await(ended).pipe(Effect.ignore);
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
      const view = (machine: PairedMachine, tailscale: boolean | undefined) => {
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
        attach,
        checkSignIn,
        update: updates.request,
        automaticUpdates: (next) => {
          automatic = next;
        },
        remove: (id) => {
          bump(id);
          updates.forget(id);
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
        },
      });
    });

  /** The machines kept in the server's data folder. */
  static readonly layer: Layer.Layer<RemoteHosts, never, ServerConfig> = Layer.effect(
    RemoteHosts,
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      return yield* RemoteHosts.make(lazyFileStore(config.dataDir), Date.now, {
        release: releaseOfConfig(config),
      });
    }),
  );
}
