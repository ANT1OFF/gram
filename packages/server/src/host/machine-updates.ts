/**
 * Updating the joined machines to this Gram's release over their own connections
 * (`host.update.*`): on request from Settings → Machines, and on their own while automatic updates
 * are on. Only this Gram's own release is ever named; the host downloads it from Gram's releases and
 * checks it there. A machine at work (a turn, a terminal running a command, a clone) waits: it is
 * asked again every `RETRY_MS` until it is idle. What each machine is doing is kept in memory and
 * shown on its row.
 */

import type {
  HostBusy,
  HostId,
  HostUpdateCheck,
  HostUpdateProgress,
  HostUpdateRefused,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { HostConnection } from "./protocol.ts";
import { CONFIRM_MS, compareReleases, RELEASE } from "./self-update.ts";

/** How often a machine waiting to be idle, or behind with automatic updates on, is asked again. */
export const RETRY_MS = 30_000;
/** How long a machine that handed its service over gets to come back on the new release. */
export const RETURN_MS = CONFIRM_MS + 60_000;

/** A machine's update, as its row shows it. Times are epoch ms. */
export type MachineUpdate =
  /** Busy: it updates once it is idle. */
  | { readonly phase: "waiting"; readonly release: string; readonly busy: HostBusy }
  | {
      readonly phase: "downloading";
      readonly release: string;
      readonly received: number;
      readonly total?: number;
    }
  | {
      readonly phase: "verifying" | "unpacking" | "testing" | "switching" | "restarting";
      readonly release: string;
    }
  | { readonly phase: "updated"; readonly release: string; readonly at: number }
  | {
      readonly phase: "failed" | "rolledBack";
      readonly release: string;
      readonly message: string;
      readonly at: number;
    };

/** What the updates need from the joined machines. */
export interface MachineUpdatesDeps {
  /** This Gram's release; undefined when it runs from source, which has none to hand out. */
  readonly release: string | undefined;
  /** The machine's connection while it is online. */
  readonly connection: (id: HostId) => HostConnection | undefined;
  /** The machines dialled in now. */
  readonly online: () => ReadonlyArray<HostId>;
  /** Whether automatic updates are on now (`updates.machines`, on unless turned off). */
  readonly automatic: Effect.Effect<boolean>;
  readonly now: () => number;
  /** Runs an update in the background, in the machines' own scope. */
  readonly fork: (effect: Effect.Effect<void>) => void;
}

/** What asking for an update did. */
export type UpdateRequest =
  /** It started, or is waiting for the machine to be idle. */
  | { readonly kind: "started"; readonly update: MachineUpdate }
  /** Its host can't update itself: an older gram-host, which the installer updates. */
  | { readonly kind: "fallback" }
  /** It runs this Gram's release, or a later one, already. */
  | { readonly kind: "current" }
  /** Offline, or this Gram has no release. */
  | { readonly kind: "unavailable"; readonly message: string };

const isBusy = (busy: HostBusy | undefined): busy is HostBusy =>
  busy !== undefined && busy.turns + busy.terminals + busy.clones + busy.checks > 0;

/** The release a host said it runs, when it reads as one. */
const releaseOf = (connection: HostConnection): string | undefined =>
  connection.hello.release !== undefined && RELEASE.test(connection.hello.release)
    ? connection.hello.release
    : undefined;

/** How the machine's last update went, as its host says; undefined when it can't say. */
const checkOf = (connection: HostConnection) =>
  connection.update === undefined
    ? Effect.succeed(undefined)
    : connection.update.check.pipe(Effect.orElseSucceed(() => undefined));

export const makeMachineUpdates = (deps: MachineUpdatesDeps) => {
  const states = new Map<HostId, MachineUpdate>();
  /** Machines whose update was asked for here: they update once idle even with automatic off. */
  const requested = new Set<HostId>();
  /** Releases a machine rolled back from or failed on: automatic updates don't try them again. */
  const refusedReleases = new Map<HostId, string>();
  /** When a machine that handed its service over stops being waited for. */
  const returns = new Map<HostId, number>();
  const running = new Set<HostId>();

  /** Whether the machine runs an earlier release than this Gram's. */
  const behind = (connection: HostConnection) => {
    const theirs = releaseOf(connection);
    return (
      deps.release !== undefined &&
      theirs !== undefined &&
      compareReleases(theirs, deps.release) < 0
    );
  };

  const set = (id: HostId, update: MachineUpdate | undefined) => {
    if (update === undefined) states.delete(id);
    else states.set(id, update);
  };

  const failed = (id: HostId, release: string, message: string) => {
    refusedReleases.set(id, release);
    requested.delete(id);
    set(id, { phase: "failed", release, message, at: deps.now() });
  };

  /** One run of `host.update.start`, its steps kept as the machine's state. */
  const run = (id: HostId, connection: HostConnection, release: string) =>
    Effect.gen(function* () {
      const update = connection.update;
      if (update === undefined) return;
      let handedOver = false;
      const result = yield* update.start(release).pipe(
        Stream.runForEach((step: HostUpdateProgress) =>
          Effect.sync(() => {
            if (step.phase === "switching") handedOver = true;
            set(
              id,
              step.phase === "downloading"
                ? {
                    phase: "downloading",
                    release,
                    received: step.received,
                    ...(step.total === undefined ? {} : { total: step.total }),
                  }
                : { phase: step.phase, release },
            );
          }),
        ),
        Effect.exit,
      );
      if (result._tag === "Success" || handedOver) {
        // Its service moves now: the connection drops, and the new host dials in.
        set(id, { phase: "restarting", release });
        returns.set(id, deps.now() + RETURN_MS);
        return;
      }
      const error = result.cause.reasons.find((reason) => reason._tag === "Fail")?.error as
        | HostUpdateRefused
        | { readonly _tag: "HostUnavailable"; readonly message: string }
        | undefined;
      if (
        error?._tag === "HostUpdateRefused" &&
        error.reason === "busy" &&
        error.busy !== undefined
      )
        set(id, { phase: "waiting", release, busy: error.busy });
      else if (error?._tag === "HostUpdateRefused") failed(id, release, error.message);
      else failed(id, release, error?.message ?? "The update stopped before it finished.");
      yield* Effect.logInfo("machines: a joined machine didn't update").pipe(
        Effect.annotateLogs({
          hostId: id,
          release,
          reason: error?._tag === "HostUpdateRefused" ? error.reason : "unavailable",
        }),
      );
    }).pipe(
      Effect.ensuring(Effect.sync(() => running.delete(id))),
      Effect.catchCause((cause) =>
        Effect.sync(() => failed(id, release, "The update stopped before it finished.")).pipe(
          Effect.andThen(
            Effect.logWarning("machines: an update failed").pipe(
              Effect.annotateLogs({ cause: String(cause) }),
            ),
          ),
        ),
      ),
    );

  /** Starts the machine's update unless one runs, or it is waiting to come back. */
  const begin = (id: HostId, connection: HostConnection) => {
    const release = deps.release;
    if (release === undefined || running.has(id)) return;
    if (states.get(id)?.phase === "restarting") return;
    running.add(id);
    deps.fork(run(id, connection, release));
  };

  /**
   * Asks for the machine's update, from its row or Update all: it starts now, or once the machine
   * is idle. A release it failed on before is tried again.
   */
  const request = (id: HostId): UpdateRequest => {
    if (deps.release === undefined)
      return {
        kind: "unavailable",
        message: "This Gram runs from source, so it has no release to update machines to.",
      };
    const connection = deps.connection(id);
    if (connection === undefined)
      return { kind: "unavailable", message: "That machine is offline." };
    if (connection.update === undefined) return { kind: "fallback" };
    if (!behind(connection)) return { kind: "current" };
    requested.add(id);
    refusedReleases.delete(id);
    const state = states.get(id);
    if (state?.phase !== "restarting" && !running.has(id))
      set(id, { phase: "downloading", release: deps.release, received: 0 });
    begin(id, connection);
    return {
      kind: "started",
      update: states.get(id) ?? { phase: "downloading", release: deps.release, received: 0 },
    };
  };

  /** Whether the machine should update now on its own: behind, and not refused before. */
  const due = (id: HostId, connection: HostConnection, automatic: boolean) =>
    connection.update !== undefined &&
    behind(connection) &&
    (requested.has(id) || (automatic && refusedReleases.get(id) !== deps.release));

  /**
   * A machine came online: how its last update went (asked through `host.update.check`, which also
   * confirms an update that brought it back on a new release), then whether it updates now.
   */
  /**
   * A machine that handed its service over, asked how that went: back on the new release is
   * updated; an outcome its host recorded for that release (rolled back, or failed) ends it too.
   * Otherwise it is still under way, and its deadline stands: the host that dialled in may be the
   * previous one, back before its supervisor wrote down why.
   */
  const settleReturn = (
    id: HostId,
    connection: HostConnection,
    check: HostUpdateCheck | undefined,
  ) => {
    const state = states.get(id);
    if (state === undefined || (state.phase !== "restarting" && state.phase !== "switching"))
      return;
    if (releaseOf(connection) === state.release) {
      returns.delete(id);
      requested.delete(id);
      set(id, { phase: "updated", release: state.release, at: deps.now() });
      return;
    }
    const last = check?.last;
    if (last === undefined || last.release !== state.release || last.outcome === "updated") return;
    returns.delete(id);
    const message = last.message ?? "The new release didn't start, so it went back.";
    failed(id, state.release, message);
    if (last.outcome === "rolledBack")
      set(id, { phase: "rolledBack", release: state.release, message, at: last.at });
  };

  /**
   * A machine came online: how its last update went (asked through `host.update.check`, which also
   * confirms an update that brought it back on a new release), then whether it updates now.
   */
  const connected = (id: HostId, connection: HostConnection) =>
    Effect.gen(function* () {
      const state = states.get(id);
      const check = yield* checkOf(connection);
      const last = check?.last;
      if (state !== undefined && (state.phase === "restarting" || state.phase === "switching")) {
        settleReturn(id, connection, check);
      } else if (
        state === undefined &&
        last !== undefined &&
        last.outcome !== "updated" &&
        last.release === deps.release
      ) {
        // Ended before this Gram started: shown, and not tried again on its own.
        const message = last.message ?? "The new release didn't start, so it went back.";
        refusedReleases.set(id, last.release);
        set(
          id,
          last.outcome === "rolledBack"
            ? { phase: "rolledBack", release: last.release, message, at: last.at }
            : { phase: "failed", release: last.release, message, at: last.at },
        );
      }
      if (due(id, connection, yield* deps.automatic)) begin(id, connection);
    });

  /**
   * Every `RETRY_MS`: a machine still coming back from its update is asked again how it went;
   * machines waiting to be idle, or behind with automatic updates on, are asked again; and one that
   * handed its service over and didn't come back in time is marked failed.
   */
  const sweep = Effect.gen(function* () {
    const automatic = yield* deps.automatic;
    for (const id of deps.online()) {
      const connection = deps.connection(id);
      const phase = states.get(id)?.phase;
      if (connection !== undefined && (phase === "restarting" || phase === "switching"))
        settleReturn(id, connection, yield* checkOf(connection));
    }
    const now = deps.now();
    for (const [id, until] of returns) {
      if (now < until) continue;
      returns.delete(id);
      const state = states.get(id);
      if (state?.phase === "restarting")
        failed(
          id,
          state.release,
          "It didn't come back on the new release. Check gram-host status there.",
        );
    }
    for (const id of deps.online()) {
      const connection = deps.connection(id);
      if (connection === undefined) continue;
      if (!behind(connection)) {
        // Updated some other way, by the installer, say: nothing is pending any more.
        const state = states.get(id);
        requested.delete(id);
        if (state !== undefined && state.phase !== "updated" && state.phase !== "restarting")
          set(id, undefined);
        continue;
      }
      if (due(id, connection, automatic)) begin(id, connection);
      // Waiting for an update no one asks for any more: automatic updates were turned off.
      else if (states.get(id)?.phase === "waiting" && !running.has(id)) set(id, undefined);
    }
  });

  return {
    request,
    connected,
    sweep,
    /** The machine's update, as its row shows it. */
    stateOf: (id: HostId) => states.get(id),
    /** Forgets a removed machine. */
    forget: (id: HostId) => {
      states.delete(id);
      requested.delete(id);
      refusedReleases.delete(id);
      returns.delete(id);
    },
    /** Whether a machine's busy count says it would wait. Exposed for its row. */
    isBusy,
  };
};

export type MachineUpdates = ReturnType<typeof makeMachineUpdates>;
