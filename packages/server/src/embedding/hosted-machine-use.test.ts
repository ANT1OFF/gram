import { describe, expect, it } from "@effect/vitest";
import { type Checkout, HostId, type ThreadId } from "@gram/contracts";
import {
  stopsLetGo,
  threadsLetGo,
  type UseThread,
  WORKER_MACHINE_SETTLE_MS,
} from "./hosted-machine-use.ts";

const NOW = 10 * WORKER_MACHINE_SETTLE_MS;
const machine = { id: "m-hosted", joinedAt: 0 };
const on = (hostId: string) => ({ path: "/w", hostId: HostId.make(hostId) }) as unknown as Checkout;
const thread = (id: string, fields: Partial<UseThread> = {}): UseThread => ({
  id: id as ThreadId,
  parked: true,
  checkout: on(machine.id),
  ...fields,
});
const none = new Set<ThreadId>();
const idle = () => false;
const letGo = (
  threads: ReadonlyArray<UseThread>,
  options: {
    waking?: ReadonlySet<ThreadId>;
    busy?: (id: ThreadId) => boolean;
    unreadable?: ReadonlyArray<ThreadId>;
    joinedAt?: number | undefined;
  } = {},
) =>
  threadsLetGo(
    { id: machine.id, joinedAt: "joinedAt" in options ? options.joinedAt : machine.joinedAt },
    { threads, unreadable: options.unreadable ?? [] },
    options.waking ?? none,
    options.busy ?? idle,
    NOW,
  );

describe("whether the threads let a hosted worker machine go", () => {
  it("do, once every thread placed on it is archived with nothing going on or waiting", () => {
    expect(letGo([thread("a"), thread("b", { parked: false, checkout: on("other") })])).toBe(true);
  });

  it("don't while a thread not archived is placed on it, finished or not, in any of its folders", () => {
    for (const placed of [
      { checkout: on(machine.id) },
      { checkout: on("local"), currentCheckout: on(machine.id) },
      { checkout: on("local"), extraCheckouts: [on(machine.id)] },
    ])
      expect(letGo([thread("a", { parked: false, ...placed })])).toBe(false);
  });

  it("don't for an archived thread with a turn, a message or a request still going, or a wake pending", () => {
    const a = "a" as ThreadId;
    expect(letGo([thread("a")], { busy: (id) => id === a })).toBe(false);
    expect(letGo([thread("a")], { waking: new Set([a]) })).toBe(false);
  });

  it("don't while some thread's row can't be read: it might be on the machine", () => {
    expect(letGo([thread("a")], { unreadable: ["x" as ThreadId] })).toBe(false);
  });

  it("don't for one just joined, whose worker may not be placed yet", () => {
    expect(letGo([], { joinedAt: NOW - WORKER_MACHINE_SETTLE_MS + 1 })).toBe(false);
    expect(letGo([], { joinedAt: undefined })).toBe(false);
    expect(letGo([])).toBe(true);
  });
});

describe("whether a machine's stop marks let it go", () => {
  const clear = {
    wanted: () => false,
    owes: () => false,
    holding: () => false,
    awaited: () => new Set<ThreadId>(),
    restedOf: () => [] as ReadonlyArray<ThreadId>,
  };

  it("do with nothing marked, and don't while anything waits, is owed, held or rests on it", () => {
    expect(stopsLetGo(clear, machine.id)).toBe(true);
    for (const marked of [
      { wanted: () => true },
      { owes: () => true },
      { holding: () => true },
      { awaited: () => new Set(["a" as ThreadId]) },
      { restedOf: () => ["a" as ThreadId] },
    ])
      expect(stopsLetGo({ ...clear, ...marked }, machine.id)).toBe(false);
  });
});
