import { describe, expect, it } from "@effect/vitest";
import { type Checkout, HostId, type ThreadId } from "@gram/contracts";
import {
  hostedMachineInUse,
  type UseThread,
  WORKER_MACHINE_SETTLE_MS,
} from "./hosted-machine-use.ts";

const NOW = 10 * WORKER_MACHINE_SETTLE_MS;
const machine = { id: "m-hosted", name: "worker-0123456789", joinedAt: 0 };
const on = (hostId: string) => ({ path: "/w", hostId: HostId.make(hostId) }) as unknown as Checkout;
const thread = (id: string, fields: Partial<UseThread> = {}): UseThread => ({
  id: id as ThreadId,
  parked: false,
  checkout: on("local"),
  ...fields,
});

const noStops = {
  wanted: () => false,
  owes: () => false,
  holding: () => false,
  awaited: () => new Set<ThreadId>(),
  restedOf: () => [] as ReadonlyArray<ThreadId>,
};

describe("whether a hosted worker machine is still needed", () => {
  it("is not, once every thread placed on it is archived and nothing waits for it", () => {
    const threads = [
      thread("a", { parked: true, checkout: on(machine.id) }),
      thread("b", { checkout: on("other") }),
    ];
    expect(hostedMachineInUse(machine, threads, noStops, NOW)).toBe(false);
  });

  it("is, while a thread not archived is placed on it, its folder moved there or added there", () => {
    for (const placed of [
      thread("a", { checkout: on(machine.id) }),
      thread("a", { currentCheckout: on(machine.id) }),
      thread("a", { extraCheckouts: [on(machine.id)] }),
    ])
      expect(hostedMachineInUse(machine, [placed], noStops, NOW)).toBe(true);
  });

  it("is, while something waits for it, a resume is owed on it or its stop is held", () => {
    for (const mark of ["wanted", "owes", "holding"] as const)
      expect(hostedMachineInUse(machine, [], { ...noStops, [mark]: () => true }, NOW)).toBe(true);
  });

  it("is, while a thread not archived waits on or was put to rest for its stop", () => {
    const open = [thread("a")];
    const awaited = { ...noStops, awaited: () => new Set(["a" as ThreadId]) };
    const rested = { ...noStops, restedOf: () => ["a" as ThreadId] };
    expect(hostedMachineInUse(machine, open, awaited, NOW)).toBe(true);
    expect(hostedMachineInUse(machine, open, rested, NOW)).toBe(true);
    // Archived since: it no longer keeps the machine.
    const archived = [thread("a", { parked: true })];
    expect(hostedMachineInUse(machine, archived, awaited, NOW)).toBe(false);
    expect(hostedMachineInUse(machine, archived, rested, NOW)).toBe(false);
  });

  it("is, while its worker may not be placed yet: just joined, or a start of its name is on its way", () => {
    const fresh = { ...machine, joinedAt: NOW - WORKER_MACHINE_SETTLE_MS + 1 };
    expect(hostedMachineInUse(fresh, [], noStops, NOW)).toBe(true);
    expect(hostedMachineInUse({ id: machine.id, name: machine.name }, [], noStops, NOW)).toBe(true);
    expect(hostedMachineInUse(machine, [], noStops, NOW, new Set([machine.name]))).toBe(true);
  });
});
