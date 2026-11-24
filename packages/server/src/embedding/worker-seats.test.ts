// Who is on a worker machine, as its provider keeps it: the answers read field by field, and the
// upkeep that gives a seat up once its worker's work is over. No provider is called.

import { describe, expect, it } from "@effect/vitest";
import type { Thread, ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { parseChoices } from "./on-demand.ts";
import { makeSeatUpkeep, seatsHere, seatsKept, staleSeats } from "./worker-seat-upkeep.ts";
import {
  askSeats,
  parseProvidedMachines,
  parseSeatsAnswer,
  releaseOccupied,
  seatsBody,
  type WorkerSeats,
  type WorkerSeatsAsk,
} from "./worker-seats.ts";

const NAME = "worker-0123456789";

describe("a provider's answer about a machine's seats", () => {
  it("is read field by field, and a refusal keeps its reason", () => {
    expect(
      parseSeatsAnswer(200, {
        workers: ["a", "b", 7, "bad seat"],
        cap: 4,
        size: "large",
        mode: "shared",
      }),
    ).toEqual({ kind: "seats", workers: ["a", "b"], cap: 4, size: "large", mode: "shared" });
    expect(
      parseSeatsAnswer(409, { code: "machine_full", message: "Full.", cap: 4, workers: ["a"] }),
    ).toEqual({ kind: "refused", code: "machine_full", message: "Full.", cap: 4, workers: ["a"] });
    // A code this Gram has no word for is still a refusal, never a seat.
    expect(parseSeatsAnswer(409, { code: "something_new" })).toMatchObject({
      kind: "refused",
      code: "other",
    });
    expect(parseSeatsAnswer(403, { message: "Not allowed." })).toMatchObject({ kind: "refused" });
    // A provider that keeps none of this, and one that didn't answer: neither is a seat.
    expect(parseSeatsAnswer(404, { code: "not_found" })).toEqual({ kind: "none" });
    expect(parseSeatsAnswer(503, {})).toMatchObject({ kind: "unknown" });
    expect(parseSeatsAnswer(200, { ok: true })).toMatchObject({ kind: "unknown" });
  });

  it.effect("sends only a well-formed ask, and names an environment only when one was picked", () =>
    Effect.gen(function* () {
      let sent = 0;
      const send = Effect.sync(() => {
        sent += 1;
        return { status: 200, body: { workers: [] } };
      });
      const ask = (each: WorkerSeatsAsk) => askSeats(each, send);
      expect((yield* ask({ name: NAME, attach: { worker: "s1" } })).kind).toBe("seats");
      for (const bad of [
        { name: "not-a-machine" },
        { name: NAME, attach: { worker: "has space" } },
        { name: NAME, detach: ["ok", "-starts-wrong"] },
      ])
        expect((yield* ask(bad)).kind).toBe("refused");
      expect(sent).toBe(1);
      expect(seatsBody({ name: NAME, orchestrator: "t-1", attach: { worker: "s1" } })).toEqual({
        name: NAME,
        orchestrator: "t-1",
        attach: { worker: "s1" },
      });
      expect(
        seatsBody({ name: NAME, attach: { worker: "s1", environment: "data" }, detach: [] }),
      ).toEqual({ name: NAME, attach: { worker: "s1", environment: "data" } });
    }),
  );

  it("reads a provider's machines, dropping what isn't one", () => {
    expect(
      parseProvidedMachines(200, {
        machines: [
          {
            name: NAME,
            size: "large",
            held: "xlarge",
            architecture: "arm64",
            isolation: "container",
            environment: "data",
            running: true,
            mode: "shared",
            cap: 4,
            workers: ["a"],
            usage: { cpu: 1.5, memoryGb: 3 },
            secret: "never read",
          },
          { name: "someone-elses", workers: ["x"] },
          { name: "worker-00000000aa", running: "yes", cap: 9000, mode: "pooled" },
        ],
      }),
    ).toEqual([
      {
        name: NAME,
        size: "large",
        held: "xlarge",
        architecture: "arm64",
        isolation: "container",
        environment: "data",
        running: true,
        mode: "shared",
        cap: 4,
        workers: ["a"],
        usage: { cpu: 1.5, memoryGb: 3 },
      },
      { name: "worker-00000000aa", running: false, workers: [] },
    ]);
    expect(parseProvidedMachines(404, { code: "not_found" })).toBeUndefined();
  });

  it("reads what a provider says of sharing with its choices, within bounds", () => {
    const choices = [
      { id: "size", label: "Size", default: "large", options: [{ id: "large", label: "Large" }] },
    ];
    expect(
      parseChoices({
        choices,
        sharing: { workers: { large: 4, xlarge: 8, huge: 9000, "Bad Size": 2 }, size: "large" },
      })?.sharing,
    ).toEqual({ workers: { large: 4, xlarge: 8 }, size: "large" });
    expect(parseChoices({ choices })?.sharing).toBeUndefined();
    expect(parseChoices({ choices, sharing: "yes" })?.sharing).toBeUndefined();
  });

  it("tells a release held back for seats from one that was applied", () => {
    expect(releaseOccupied({ known: true, applied: false, code: "occupied", workers: ["a"] })).toBe(
      true,
    );
    expect(releaseOccupied({ known: true, applied: false, code: "superseded" })).toBe(false);
    expect(releaseOccupied({ known: true, released: true })).toBe(false);
    expect(releaseOccupied(undefined)).toBe(false);
  });
});

const placed = (id: string, machineId: string, seat: string | undefined, more: object = {}) =>
  ({
    id: id as ThreadId,
    checkout: { kind: "worktree", path: `/w/${id}`, hostId: machineId },
    spawnedBy: {
      threadId: "t-orch",
      feature: "f",
      placement: { machine: NAME, ...(seat === undefined ? {} : { seat }) },
    },
    ...more,
  }) as unknown as Thread;

describe("the upkeep of a machine's seats", () => {
  const machine = { id: "m-1", name: NAME, via: "https://hosted.example.test" };

  it("stands behind every open worker's seat while any there is at work, a finished one's too", () => {
    const threads = [
      placed("a", "m-1", "sa"),
      placed("done", "m-1", "sd"),
      placed("parked", "m-1", "sp", { parked: true }),
      placed("unseated", "m-1", undefined),
      placed("elsewhere", "m-2", "se"),
    ];
    const done = new Set(["done" as ThreadId]);
    // `done` can be messaged back to work: its place is not given away while `a` keeps the machine.
    const seats = seatsHere(machine, threads, done);
    expect([...seats.live]).toEqual(["sa", "sd"]);
    expect(seats.any).toBe(true);
    // Once every worker there is finished, none is: the seats go and the machine is released.
    const over = seatsHere(machine, threads, new Set(["done", "a", "unseated"] as ThreadId[]));
    expect([...over.live]).toEqual([]);
    expect(over.any).toBe(true);
    expect(seatsHere(machine, [placed("unseated", "m-1", undefined)], new Set()).any).toBe(false);
  });

  it("stands behind no seat, and asks nothing, where the provider keeps none", () => {
    const threads = [placed("a", "m-1", "sa")];
    const claim = { orchestrator: "t-orch", picks: {} };
    // Every worker carries a seat as this Gram's own name for its place. Only a machine whose
    // provider keeps seats, as its claim says, has any looked after there.
    expect(seatsKept({ ...claim, seats: true }, machine, threads, new Set(), ["sr"])).toMatchObject(
      { live: new Set(["sa", "sr"]), any: true },
    );
    for (const none of [claim, { ...claim, seats: false }, undefined])
      expect(seatsKept(none, machine, threads, new Set(), ["sr"])).toEqual({
        live: new Set(),
        any: false,
      });
  });

  it("gives a seat up only once it was nobody's on two looks in a row", () => {
    const first = staleSeats(["sa", "gone", "fresh"], new Set(["sa"]), new Set());
    expect(first.detach).toEqual([]);
    expect([...first.remember]).toEqual(["gone", "fresh"]);
    // By the next look the spawn that took `fresh` has its worker; `gone` is still nobody's.
    const second = staleSeats(["sa", "gone", "fresh"], new Set(["sa", "fresh"]), first.remember);
    expect(second.detach).toEqual(["gone"]);
    expect([...second.remember]).toEqual([]);
  });

  it.effect(
    "detaches a finished worker's seat on the second look, so its machine can be released",
    () =>
      Effect.gen(function* () {
        let now = 0;
        const asks: Array<Omit<WorkerSeatsAsk, "name">> = [];
        let held = ["sa", "sd"];
        const upkeep = makeSeatUpkeep(
          (_machine, ask) =>
            Effect.sync((): WorkerSeats => {
              asks.push(ask);
              held = held.filter((seat) => !(ask.detach ?? []).includes(seat));
              return { kind: "seats", workers: held };
            }),
          () => now,
        );
        const seats = { live: new Set(["sa"]), any: true };
        expect(yield* upkeep.look(machine, seats)).toBe("looked");
        expect(asks).toEqual([{}]);
        // A stale seat is pending: the next pass looks again whatever the clock says.
        now += 120_000;
        expect(yield* upkeep.look(machine, seats)).toBe("looked");
        expect(asks.at(-1)).toEqual({ detach: ["sd"] });
        expect(held).toEqual(["sa"]);
        // Nothing stale now: it is left alone until its time comes round.
        now += 120_000;
        expect(yield* upkeep.look(machine, seats)).toBe("skipped");
        now += 10 * 60_000;
        expect(yield* upkeep.look(machine, seats)).toBe("looked");
      }),
  );

  it.effect("takes every open worker's seat again when one of them is back at work", () =>
    Effect.gen(function* () {
      let now = 0;
      const asks: Array<Omit<WorkerSeatsAsk, "name">> = [];
      let held = ["sa", "sb"];
      const upkeep = makeSeatUpkeep(
        (_machine, ask) =>
          Effect.sync((): WorkerSeats => {
            asks.push(ask);
            held = [
              ...held.filter((seat) => !(ask.detach ?? []).includes(seat)),
              ...(ask.attach === undefined ? [] : [ask.attach.worker]),
            ];
            return { kind: "seats", workers: held };
          }),
        () => now,
      );
      const threads = [placed("a", "m-1", "sa"), placed("b", "m-1", "sb")];
      const claim = { orchestrator: "t-started-for", picks: { environment: "data" } };
      const every = new Set(["a", "b"] as ThreadId[]);
      // Both finished: their seats are given up over two looks, so the machine can be released.
      yield* upkeep.look(machine, seatsHere(machine, threads, every, claim));
      now += 120_000;
      yield* upkeep.look(machine, seatsHere(machine, threads, every, claim));
      expect(held).toEqual([]);
      // A is messaged back to work. On the next pass, not ten minutes on, each open worker's
      // seat is taken again, for the orchestrator the machine was started for: B's too, which
      // may follow A at any time and must find its place kept.
      now += 120_000;
      const back = seatsHere(machine, threads, new Set(["b"] as ThreadId[]), claim);
      expect(yield* upkeep.look(machine, back)).toBe("looked");
      expect(asks.slice(-2)).toEqual([
        { orchestrator: "t-started-for", attach: { worker: "sa", environment: "data" } },
        { orchestrator: "t-started-for", attach: { worker: "sb", environment: "data" } },
      ]);
      expect(held).toEqual(["sa", "sb"]);
    }),
  );

  it.effect(
    "asks nothing of a machine no worker has a seat on, until its release is held back",
    () =>
      Effect.gen(function* () {
        const asks: unknown[] = [];
        const upkeep = makeSeatUpkeep((_machine, ask) =>
          Effect.sync((): WorkerSeats => {
            asks.push(ask);
            return { kind: "seats", workers: ["orphan"] };
          }),
        );
        const none = { live: new Set<string>(), any: false };
        expect(yield* upkeep.look(machine, none)).toBe("skipped");
        upkeep.occupied(machine);
        expect(yield* upkeep.look(machine, none)).toBe("looked");
        expect(yield* upkeep.look(machine, none)).toBe("looked");
        expect(asks).toEqual([{}, {}, { detach: ["orphan"] }]);
      }),
  );

  it.effect("leaves a provider that keeps no seats unasked for a while", () =>
    Effect.gen(function* () {
      let now = 0;
      let asked = 0;
      const upkeep = makeSeatUpkeep(
        () =>
          Effect.sync((): WorkerSeats => {
            asked += 1;
            return { kind: "none" };
          }),
        () => now,
      );
      const seats = { live: new Set(["sa"]), any: true };
      yield* upkeep.look(machine, seats);
      now += 20 * 60_000;
      yield* upkeep.look(machine, seats);
      expect(asked).toBe(1);
      now += 60 * 60_000;
      yield* upkeep.look(machine, seats);
      expect(asked).toBe(2);
    }),
  );
});
