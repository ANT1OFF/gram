import { describe, expect, it } from "@effect/vitest";
import type { HostId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { MOVE_ACTS_WITHIN_MS, moveAskedMachines, type MoveDeps } from "./signed-in-moves.ts";
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
    machines: () => [worker(), worker({ id: "m-away", name: "worker-89abcdef", onlineSince: undefined })],
    prepare: (id) => Effect.sync(() => void prepared.push(id)),
    readied: () => options.readied ?? true,
    takeBack: (id) => Effect.sync(() => void takenBack.push(id)),
  };
  return { deps, calls, prepared, takenBack };
};

describe("a hosted worker machine its provider asks to move", () => {
  it.effect("is readied, forced, and then moved, once for its run", () =>
    Effect.gen(function* () {
      const { deps, calls, prepared } = provider({});
      const done = new Set<string>();
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
      expect(yield* moveAskedMachines(deps, new Set(), () => NOW)).toEqual(["not-asked"]);
      expect(prepared).toEqual([]);
      expect(calls.map((each) => each.call)).toEqual(["status"]);
    }),
  );

  it.effect("works on where it is when the provider refuses, and isn't readied again", () =>
    Effect.gen(function* () {
      const { deps, prepared, takenBack } = provider({
        moved: { status: 200, body: { moved: false, code: "not_movable" } },
      });
      const done = new Set<string>();
      expect(yield* moveAskedMachines(deps, done, () => NOW)).toEqual(["refused"]);
      expect(takenBack).toEqual(["m-worker"]);
      expect(yield* moveAskedMachines(deps, done, () => NOW)).toEqual(["already-done"]);
      expect(prepared).toHaveLength(1);
    }),
  );

  it.effect("isn't moved when it couldn't be readied, as its work wasn't kept", () =>
    Effect.gen(function* () {
      const { deps, calls } = provider({ readied: false });
      expect(yield* moveAskedMachines(deps, new Set(), () => NOW)).toEqual(["not-readied"]);
      expect(calls.map((each) => each.call)).toEqual(["status"]);
    }),
  );

  it.effect("is asked again at the next look when the move's answer was lost", () =>
    Effect.gen(function* () {
      const { deps, prepared, takenBack } = provider({ moved: "unanswered" });
      const done = new Set<string>();
      expect(yield* moveAskedMachines(deps, done, () => NOW)).toEqual(["unanswered"]);
      expect(yield* moveAskedMachines(deps, done, () => NOW)).toEqual(["unanswered"]);
      expect(prepared).toHaveLength(2);
      // The stop stays: the move may have gone through, and the host is about to go.
      expect(takenBack).toEqual([]);
    }),
  );
});
