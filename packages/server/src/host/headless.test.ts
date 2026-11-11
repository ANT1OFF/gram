import { describe, expect, it } from "@effect/vitest";
import { type CheckoutRequest, HostId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import {
  defaultMachine,
  headlessAgentHosts,
  headlessLocal,
  headlessPlacement,
  NO_MACHINE_JOINED,
  placeRequest,
  type PlaceableMachine,
  RUNS_NOTHING_HERE,
} from "./headless.ts";
import type { RemoteHostsShape } from "./remote-hosts.ts";
import type { WorkerHost } from "./worker-host.ts";

const machine = (
  id: string,
  fields: Partial<Omit<PlaceableMachine, "id">> = {},
): PlaceableMachine => ({
  id: HostId.make(id),
  name: id,
  confirmed: true,
  joinedAt: 1,
  ...fields,
});
const remote = (machines: ReadonlyArray<PlaceableMachine>) =>
  ({ list: () => machines }) as unknown as Pick<RemoteHostsShape, "list">;
const MODELS = [{ id: "fake-opus", displayName: "Fake Opus", supportsEffort: false }];

describe("defaultMachine", () => {
  it("picks the confirmed machine online now that joined first", () => {
    expect(
      defaultMachine([
        machine("m-late", { joinedAt: 30, onlineSince: 1 }),
        machine("m-unconfirmed", { joinedAt: 5, onlineSince: 1, confirmed: false }),
        machine("m-offline", { joinedAt: 10 }),
        machine("m-first", { joinedAt: 20, onlineSince: 9 }),
      ]),
    ).toEqual({ id: "m-first" });
  });

  it("says why there is none: nothing joined, or what has is offline", () => {
    expect(defaultMachine([])).toEqual({ error: NO_MACHINE_JOINED });
    expect(defaultMachine([machine("m-new", { confirmed: false, onlineSince: 1 })])).toEqual({
      error: NO_MACHINE_JOINED,
    });
    expect(defaultMachine([machine("m-a", { name: "build box" })])).toEqual({
      error: expect.stringMatching(/^build box is offline/),
    });
    expect(defaultMachine([machine("m-a", { name: "a" }), machine("m-b", { name: "b" })])).toEqual({
      error: expect.stringMatching(/^a, b are offline/),
    });
  });
});

describe("placeRequest", () => {
  const placement = headlessPlacement(remote([machine("m-first", { onlineSince: 1 })]));

  it.effect("puts what names no machine on the default one, and leaves what names one", () =>
    Effect.gen(function* () {
      expect(yield* placeRequest(placement, { kind: "current" })).toEqual({
        kind: "current",
        hostId: "m-first",
      });
      expect(yield* placeRequest(placement, { kind: "newWorktree", branch: "gram/x" })).toEqual({
        kind: "newWorktree",
        branch: "gram/x",
        hostId: "m-first",
      });
      const named: CheckoutRequest = {
        kind: "newWorktree",
        branch: "gram/x",
        hostId: HostId.make("m-other"),
      };
      expect(yield* placeRequest(placement, named)).toBe(named);
    }),
  );

  it.effect("refuses a worktree of this machine, and anything with no machine to take it", () =>
    Effect.gen(function* () {
      const here = yield* placeRequest(placement, {
        kind: "existingWorktree",
        path: "/work/repo",
      }).pipe(Effect.flip);
      expect(here).toMatchObject({ _tag: "InvalidState", message: RUNS_NOTHING_HERE });
      const none = yield* placeRequest(headlessPlacement(undefined), { kind: "current" }).pipe(
        Effect.flip,
      );
      expect(none).toMatchObject({ _tag: "InvalidState", message: NO_MACHINE_JOINED });
    }),
  );
});

describe("headlessAgentHosts", () => {
  it.effect("offers Claude Code as the default machine lists it, and opens nothing here", () =>
    Effect.gen(function* () {
      const hosts = headlessAgentHosts(
        remote([machine("m-first", { onlineSince: 1, models: MODELS })]),
      );
      const claude = yield* hosts.get("claude");
      expect(yield* claude.listModels()).toEqual(MODELS);
      const opened = yield* Effect.flip(
        Effect.scoped(claude.open({ threadId: "t-1", cwd: "/work/repo" } as never)),
      );
      expect(opened).toMatchObject({ _tag: "AgentUnavailable", message: RUNS_NOTHING_HERE });
      expect(yield* Effect.flip(hosts.get("codex"))).toMatchObject({ _tag: "AgentUnavailable" });
    }),
  );

  it.effect("lists no models until a machine is online and has said what it offers", () =>
    Effect.gen(function* () {
      const none = yield* headlessAgentHosts(undefined).get("claude");
      expect(yield* Effect.flip(none.listModels())).toMatchObject({ message: NO_MACHINE_JOINED });
      const quiet = yield* headlessAgentHosts(
        remote([machine("m-first", { name: "build box", onlineSince: 1 })]),
      ).get("claude");
      expect(yield* Effect.flip(quiet.listModels())).toMatchObject({
        message: expect.stringContaining("build box hasn't said which models"),
      });
    }),
  );
});

describe("headlessLocal", () => {
  it.effect("refuses what would start something on this machine and keeps what only reads", () =>
    Effect.gen(function* () {
      const reads = { present: () => Effect.succeed(true) };
      const local = headlessLocal({
        checkouts: {
          ...reads,
          prepare: () => Effect.die("made a checkout here"),
          restore: () => Effect.die("restored a checkout here"),
        },
        worktrees: {
          list: () => Effect.succeed([]),
          create: () => Effect.die("made a worktree here"),
          restore: () => Effect.die("restored a worktree here"),
        },
        terminals: { list: () => Effect.succeed([]), open: () => Effect.die("opened a shell") },
      } as unknown as WorkerHost);
      for (const refused of [
        local.checkouts.prepare({ kind: "current" }, [], "/work/repo"),
        local.terminals.open({ cols: 80, rows: 24 } as never),
        local.worktrees.create({} as never),
      ] as ReadonlyArray<Effect.Effect<unknown, { readonly message: string }, never>>)
        expect(yield* Effect.flip(refused)).toMatchObject({ message: RUNS_NOTHING_HERE });
      expect(yield* local.checkouts.present("/work/repo")).toBe(true);
    }),
  );
});
