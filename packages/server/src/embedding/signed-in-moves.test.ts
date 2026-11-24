import { describe, expect, it } from "@effect/vitest";
import type { HostId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import {
  makeMoveMemory,
  MOVE_ACTS_WITHIN_MS,
  MOVE_TRIES,
  moveAskedMachines,
  type MoveDeps,
} from "./signed-in-moves.ts";
import { fencedCalls } from "./signed-in-fences.ts";
import type { WorkerMachinePortShape } from "./signed-in-port.ts";
import type { ProvidedMachine } from "./worker-machines.ts";

const ORIGIN = "https://provider.test";
const NOW = 1_800_000_000_000;

const worker = (over: Partial<ProvidedMachine> = {}): ProvidedMachine => ({
  id: "m-worker",
  name: "worker-0123abcd",
  onDemand: "worker",
  via: ORIGIN,
  viaAccount: "acct_12345678",
  onlineSince: NOW - 60_000,
  ...over,
});

const RUN = { sandboxId: "sbx_one", generation: 3 };

/** A provider whose status says `asking`, and whose move answers `moved`, as a fake port. */
const provider = (options: {
  readonly asking?: boolean;
  readonly moved?: { readonly status: number; readonly body: unknown } | "unanswered";
  readonly readied?: boolean;
}) => {
  const calls: Array<{ call: string; body: unknown; run?: unknown }> = [];
  const prepared: Array<HostId> = [];
  const takenBack: Array<HostId> = [];
  const deps: MoveDeps = {
    port: {
      call: (_origin, call, body, callOptions) =>
        Effect.sync(() => {
          calls.push({
            call,
            body,
            ...(callOptions?.run === undefined ? {} : { run: callOptions.run }),
          });
          if (call === "status")
            return {
              ok: true as const,
              status: 200,
              body: {
                phase: "running",
                ...RUN,
                ...(options.asking === false ? {} : { moveRequested: "2027-01-15T08:00:00Z" }),
              },
            };
          const moved = options.moved ?? { status: 200, body: { moved: true } };
          return moved === "unanswered"
            ? { ok: false as const, why: "The desktop app didn't answer." }
            : { ok: true as const, ...moved };
        }),
    },
    machines: () => [
      worker(),
      worker({ id: "m-away", name: "worker-89abcdef", onlineSince: undefined }),
    ],
    prepare: (id) =>
      Effect.sync(() => {
        prepared.push(id);
        return { kept: [{ pushed: true }] };
      }),
    readied: () => options.readied ?? true,
    takeBack: (id) => Effect.sync(() => void takenBack.push(id)),
  };
  return { deps, calls, prepared, takenBack };
};

describe("a hosted worker machine its provider asks to move", () => {
  it.effect("is readied, forced, and then moved, once for its run", () =>
    Effect.gen(function* () {
      const { deps, calls, prepared } = provider({});
      const done = makeMoveMemory();
      expect(yield* moveAskedMachines(deps, done, () => NOW)).toEqual(["moved"]);
      expect(prepared).toEqual(["m-worker"]);
      // Asked about only the machine that is there, and moved fenced to the run its status named.
      expect(calls).toEqual([
        { call: "status", body: { name: "worker-0123abcd" } },
        {
          call: "move",
          body: { name: "worker-0123abcd", notAfter: NOW + MOVE_ACTS_WITHIN_MS },
          run: RUN,
        },
      ]);
      expect(yield* moveAskedMachines(deps, done, () => NOW)).toEqual(["already-done"]);
      expect(prepared).toHaveLength(1);
    }),
  );

  it.effect("isn't touched while nobody asks", () =>
    Effect.gen(function* () {
      const { deps, calls, prepared } = provider({ asking: false });
      expect(yield* moveAskedMachines(deps, makeMoveMemory(), () => NOW)).toEqual(["not-asked"]);
      expect(prepared).toEqual([]);
      expect(calls.map((each) => each.call)).toEqual(["status"]);
    }),
  );

  it.effect("works on where it is when the provider refuses, and isn't readied again", () =>
    Effect.gen(function* () {
      const { deps, prepared, takenBack } = provider({
        moved: { status: 200, body: { moved: false, code: "not_movable" } },
      });
      const done = makeMoveMemory();
      expect(yield* moveAskedMachines(deps, done, () => NOW)).toEqual(["refused"]);
      expect(takenBack).toEqual(["m-worker"]);
      expect(yield* moveAskedMachines(deps, done, () => NOW)).toEqual(["already-done"]);
      expect(prepared).toHaveLength(1);
    }),
  );

  it.effect("isn't moved when it couldn't be readied, as its work wasn't kept", () =>
    Effect.gen(function* () {
      const { deps, calls } = provider({ readied: false });
      expect(yield* moveAskedMachines(deps, makeMoveMemory(), () => NOW)).toEqual(["not-readied"]);
      expect(calls.map((each) => each.call)).toEqual(["status"]);
    }),
  );

  it.effect(
    `keeps its stop while the move's answer is lost, and lets it go after ${MOVE_TRIES} looks`,
    () =>
      Effect.gen(function* () {
        const { deps, prepared, takenBack } = provider({ moved: "unanswered" });
        const memory = makeMoveMemory();
        const looks = [];
        for (let look = 0; look <= MOVE_TRIES; look++)
          looks.push(...(yield* moveAskedMachines(deps, memory, () => NOW)));
        expect(looks).toEqual(["unanswered", "unanswered", "unanswered", "given-up"]);
        // Before this change it was readied again at every look, its hold never running out.
        expect(prepared).toHaveLength(MOVE_TRIES);
        expect(takenBack).toEqual(["m-worker"]);
        expect(yield* moveAskedMachines(deps, memory, () => NOW)).toEqual(["already-done"]);
      }),
  );

  it.effect("works on where it is while the provider can't move it now, and is asked again", () =>
    Effect.gen(function* () {
      for (const answer of [
        { status: 503, body: { code: "no_capacity" } },
        { status: 429, body: {} },
        { status: 404, body: {} },
      ]) {
        const { deps, prepared, takenBack } = provider({ moved: answer });
        const memory = makeMoveMemory();
        expect(yield* moveAskedMachines(deps, memory, () => NOW)).toEqual(["busy"]);
        expect(takenBack).toEqual(["m-worker"]);
        expect(yield* moveAskedMachines(deps, memory, () => NOW)).toEqual(["busy"]);
        expect(prepared).toHaveLength(2);
      }
      // The provider's own "no such machine" is final.
      const gone = provider({ moved: { status: 404, body: { code: "not_found" } } });
      expect(yield* moveAskedMachines(gone.deps, makeMoveMemory(), () => NOW)).toEqual(["refused"]);
    }),
  );

  it.effect("carries the run its status named on the wire, through the fenced calls", () =>
    Effect.gen(function* () {
      const wire: Array<{ call: string; body: unknown }> = [];
      const { deps } = provider({});
      const app: WorkerMachinePortShape = {
        available: true,
        server: () => Effect.die("unused"),
        marks: () => Effect.succeed([]),
        onSignIns: () => undefined,
        call: (origin, call, body, callOptions) =>
          Effect.tap(deps.port.call(origin, call, body, callOptions), () =>
            Effect.sync(() => void wire.push({ call, body })),
          ),
        relay: () => undefined,
        unrelay: () => undefined,
        relays: () => undefined,
        onDial: () => undefined,
      };
      const fenced = { ...deps, port: fencedCalls(app) };
      expect(yield* moveAskedMachines(fenced, makeMoveMemory(), () => NOW)).toEqual(["moved"]);
      expect(wire.at(-1)).toEqual({
        call: "move",
        body: { name: "worker-0123abcd", notAfter: NOW + MOVE_ACTS_WITHIN_MS, ...RUN },
      });
    }),
  );
});
