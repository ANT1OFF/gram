import { describe, expect, it } from "@effect/vitest";
import {
  type HostBusy,
  HostId,
  type HostUpdateCheck,
  type HostUpdateProgress,
  HostUpdateRefused,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { makeMachineUpdates, RETURN_MS } from "./machine-updates.ts";
import type { HostConnection } from "./protocol.ts";

const ID = HostId.make("h_cachyos");
const MINE = "1.17.0";

/** A fake joined machine: its release, what it answers, and the releases it was asked for. */
const fakeMachine = (release: string, options: { readonly selfUpdate?: boolean } = {}) => {
  const asked: string[] = [];
  const state: {
    busy: HostBusy | undefined;
    check: HostUpdateCheck;
    fail: string | undefined;
  } = { busy: undefined, check: {}, fail: undefined };
  const connection = {
    hello: { protocol: 2, hostId: ID, capabilities: [], platform: "linux", pid: 1, release },
    gone: () => false,
    ...(options.selfUpdate === false
      ? {}
      : {
          update: {
            check: Effect.sync(() => state.check),
            start: (wanted: string) =>
              Stream.suspend(() => {
                asked.push(wanted);
                if (state.busy !== undefined)
                  return Stream.fail(
                    new HostUpdateRefused({ reason: "busy", message: "busy", busy: state.busy }),
                  );
                if (state.fail !== undefined)
                  return Stream.fail(
                    new HostUpdateRefused({ reason: "failed", message: state.fail }),
                  );
                return Stream.make<ReadonlyArray<HostUpdateProgress>>(
                  { phase: "downloading", received: 10, total: 100 },
                  { phase: "verifying" },
                  { phase: "switching" },
                );
              }),
          },
        }),
  } as unknown as HostConnection;
  return { connection, asked, state };
};

const setup = (machine: ReturnType<typeof fakeMachine>, automatic = true) => {
  let now = 0;
  let online: HostConnection | undefined = machine.connection;
  const pending: Effect.Effect<void>[] = [];
  const updates = makeMachineUpdates({
    release: MINE,
    connection: () => online,
    online: () => (online === undefined ? [] : [ID]),
    automatic: Effect.sync(() => automatic),
    now: () => now,
    fork: (effect) => {
      pending.push(effect);
    },
  });
  /** Runs what was forked, as the machines' scope would. */
  const settle = Effect.gen(function* () {
    while (pending.length > 0) yield* pending.shift()!;
  });
  return {
    updates,
    settle,
    advance: (ms: number) => {
      now += ms;
    },
    reconnect: (connection: HostConnection | undefined) => {
      online = connection;
    },
    setAutomatic: (on: boolean) => {
      automatic = on;
    },
  };
};

describe("updating joined machines", () => {
  it.effect("updates a machine behind on its own when it comes online, and sees it come back", () =>
    Effect.gen(function* () {
      const machine = fakeMachine("1.16.0");
      const { updates, settle, reconnect } = setup(machine);
      yield* updates.connected(ID, machine.connection);
      yield* settle;
      // Only this Gram's own release is ever asked for.
      expect(machine.asked).toEqual([MINE]);
      expect(updates.stateOf(ID)).toEqual({ phase: "restarting", release: MINE });
      // The new host dials in on the new release.
      const back = fakeMachine(MINE);
      back.state.check = { last: { release: MINE, outcome: "updated", at: 5 } };
      reconnect(back.connection);
      yield* updates.connected(ID, back.connection);
      expect(updates.stateOf(ID)).toMatchObject({ phase: "updated", release: MINE });
      expect(back.asked).toEqual([]);
    }),
  );

  it.effect("defers a busy machine, and updates it once it is idle", () =>
    Effect.gen(function* () {
      const machine = fakeMachine("1.16.0");
      machine.state.busy = { turns: 1, terminals: 1, clones: 0, checks: 0 };
      const { updates, settle } = setup(machine);
      yield* updates.connected(ID, machine.connection);
      yield* settle;
      expect(updates.stateOf(ID)).toEqual({
        phase: "waiting",
        release: MINE,
        busy: { turns: 1, terminals: 1, clones: 0, checks: 0 },
      });
      // Still busy at the next sweep: still waiting.
      yield* updates.sweep;
      yield* settle;
      expect(updates.stateOf(ID)?.phase).toBe("waiting");
      machine.state.busy = undefined;
      yield* updates.sweep;
      yield* settle;
      expect(updates.stateOf(ID)?.phase).toBe("restarting");
      expect(machine.asked).toEqual([MINE, MINE, MINE]);
    }),
  );

  it.effect("leaves machines alone with automatic updates off, unless asked", () =>
    Effect.gen(function* () {
      const machine = fakeMachine("1.16.0");
      machine.state.busy = { turns: 0, terminals: 0, clones: 1, checks: 0 };
      const { updates, settle } = setup(machine, false);
      yield* updates.connected(ID, machine.connection);
      yield* updates.sweep;
      yield* settle;
      expect(machine.asked).toEqual([]);
      expect(updates.stateOf(ID)).toBeUndefined();
      // Asked from its row: it waits for the clone, then updates, with automatic still off.
      expect(updates.request(ID).kind).toBe("started");
      yield* settle;
      expect(updates.stateOf(ID)?.phase).toBe("waiting");
      machine.state.busy = undefined;
      yield* updates.sweep;
      yield* settle;
      expect(updates.stateOf(ID)?.phase).toBe("restarting");
    }),
  );

  it.effect("shows a rollback, and doesn't try that release again on its own", () =>
    Effect.gen(function* () {
      const machine = fakeMachine("1.16.0");
      const { updates, settle, reconnect } = setup(machine);
      yield* updates.connected(ID, machine.connection);
      yield* settle;
      expect(updates.stateOf(ID)?.phase).toBe("restarting");
      // Back on the old release: its supervisor rolled back.
      const back = fakeMachine("1.16.0");
      back.state.check = {
        last: { release: MINE, outcome: "rolledBack", message: "It didn't dial in.", at: 9 },
      };
      reconnect(back.connection);
      yield* updates.connected(ID, back.connection);
      yield* settle;
      expect(updates.stateOf(ID)).toEqual({
        phase: "rolledBack",
        release: MINE,
        message: "It didn't dial in.",
        at: 9,
      });
      yield* updates.sweep;
      yield* settle;
      expect(back.asked).toEqual([]);
      // Asked again by hand, it tries.
      expect(updates.request(ID).kind).toBe("started");
      yield* settle;
      expect(back.asked).toEqual([MINE]);
    }),
  );

  it.effect("marks a machine that doesn't come back as failed", () =>
    Effect.gen(function* () {
      const machine = fakeMachine("1.16.0");
      const { updates, settle, advance, reconnect } = setup(machine);
      yield* updates.connected(ID, machine.connection);
      yield* settle;
      reconnect(undefined);
      advance(RETURN_MS + 1);
      yield* updates.sweep;
      expect(updates.stateOf(ID)).toMatchObject({ phase: "failed", release: MINE });
    }),
  );

  it.effect("keeps a failure on the row, and falls back for a host too old to update itself", () =>
    Effect.gen(function* () {
      const machine = fakeMachine("1.16.0");
      machine.state.fail =
        "gram_1.17.0_x86_64.AppImage doesn't match its checksum; nothing was installed.";
      const { updates, settle } = setup(machine);
      yield* updates.connected(ID, machine.connection);
      yield* settle;
      expect(updates.stateOf(ID)).toMatchObject({
        phase: "failed",
        message: machine.state.fail,
      });
      // Not retried on its own.
      yield* updates.sweep;
      yield* settle;
      expect(machine.asked).toEqual([MINE]);

      const old = fakeMachine("1.16.0", { selfUpdate: false });
      expect(setup(old).updates.request(ID)).toEqual({ kind: "fallback" });
      expect(setup(fakeMachine(MINE)).updates.request(ID)).toEqual({ kind: "current" });
    }),
  );

  // Failed on c0a36524 in the independent review: the reconnect dropped the deadline, and nothing
  // asked again, so the row read "restarting" for good.
  it.effect(
    "asks again when the previous host dials back before its rollback is written down",
    () =>
      Effect.gen(function* () {
        const machine = fakeMachine("1.16.0");
        const { updates, settle, advance, reconnect } = setup(machine);
        yield* updates.connected(ID, machine.connection);
        yield* settle;
        expect(updates.stateOf(ID)?.phase).toBe("restarting");
        // The supervisor restarts the previous host before it records why.
        const back = fakeMachine("1.16.0");
        reconnect(back.connection);
        yield* updates.connected(ID, back.connection);
        expect(updates.stateOf(ID)?.phase).toBe("restarting");
        back.state.check = {
          last: { release: MINE, outcome: "rolledBack", message: "It didn't dial in.", at: 100 },
        };
        yield* updates.sweep;
        yield* settle;
        expect(updates.stateOf(ID)).toEqual({
          phase: "rolledBack",
          release: MINE,
          message: "It didn't dial in.",
          at: 100,
        });
        // Not tried again on its own.
        advance(RETURN_MS * 10);
        yield* updates.sweep;
        yield* settle;
        expect(back.asked).toEqual([]);
      }),
  );

  it.effect("marks it failed at the deadline when the previous host never says why", () =>
    Effect.gen(function* () {
      const machine = fakeMachine("1.16.0");
      const { updates, settle, advance, reconnect } = setup(machine);
      yield* updates.connected(ID, machine.connection);
      yield* settle;
      const back = fakeMachine("1.16.0");
      reconnect(back.connection);
      yield* updates.connected(ID, back.connection);
      advance(RETURN_MS + 1);
      yield* updates.sweep;
      yield* settle;
      expect(updates.stateOf(ID)).toMatchObject({ phase: "failed", release: MINE });
    }),
  );

  it.effect("shows a recovery that failed as failed, not rolled back", () =>
    Effect.gen(function* () {
      const machine = fakeMachine("1.16.0");
      machine.state.check = {
        last: { release: MINE, outcome: "failed", message: "Both apps are kept.", at: 7 },
      };
      const { updates, settle } = setup(machine);
      yield* updates.connected(ID, machine.connection);
      yield* settle;
      expect(updates.stateOf(ID)).toEqual({
        phase: "failed",
        release: MINE,
        message: "Both apps are kept.",
        at: 7,
      });
      expect(machine.asked).toEqual([]);
    }),
  );
});
